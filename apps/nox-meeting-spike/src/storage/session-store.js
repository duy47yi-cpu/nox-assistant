'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { StorageIsolationError, StorageWriteError } = require('../privacy/privacy-controller');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_FORBIDDEN_ROOTS = [
  path.join(REPO_ROOT, 'apps', 'jarvis-desktop', 'data'),
  path.join(REPO_ROOT, 'apps', 'nox-server', 'data'),
  path.join(REPO_ROOT, 'data'),
];

const FORBIDDEN_NOX_FILENAMES = new Set([
  'chats.json',
  'journal.jsonl',
  'memory.json',
  'conversation.json',
  'settings.json',
  'deals.json',
  'missions.json',
]);

function normalizeForCompare(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSubPath(candidate, root) {
  const rel = path.relative(normalizeForCompare(root), normalizeForCompare(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Гарантирует, что хранилище C7-прототипа никогда не пересекается с обычной историей Nox.
 */
function assertIsolatedStoragePath(targetDir, extraForbiddenRoots = []) {
  if (!targetDir || typeof targetDir !== 'string') {
    throw new StorageIsolationError('Путь изолированного хранилища должен быть непустой строкой');
  }
  const resolved = path.resolve(targetDir);
  const forbiddenRoots = [...DEFAULT_FORBIDDEN_ROOTS, ...extraForbiddenRoots];

  for (const root of forbiddenRoots) {
    if (!root) continue;
    if (isSubPath(resolved, root)) {
      throw new StorageIsolationError(
        `Запрещено сохранять данные C7 внутрь каталога Nox (${resolved} пересекается с ${path.resolve(root)})`
      );
    }
  }

  const baseName = path.basename(resolved).toLowerCase();
  if (FORBIDDEN_NOX_FILENAMES.has(baseName)) {
    throw new StorageIsolationError(`Запрещено использовать файл основной истории Nox: ${baseName}`);
  }

  const segments = resolved.split(path.sep).map((s) => s.toLowerCase());
  if (segments.includes('jarvis-desktop') && segments.includes('data')) {
    throw new StorageIsolationError('Запрещено записывать данные C7 в профиль jarvis-desktop/data');
  }

  return resolved;
}

/**
 * Изолированное хранилище сессий встреч с атомарной записью и очисткой.
 */
class IsolatedSessionStore {
  constructor(options = {}) {
    const defaultDir = path.resolve(__dirname, '..', '..', '.spike-sessions');
    this._forbiddenRoots = options.forbiddenRoots || [];
    this.baseDir = assertIsolatedStoragePath(options.baseDir || defaultDir, this._forbiddenRoots);
    this._failOnWrite = Boolean(options.failOnWrite);
    this._writeInterceptor = typeof options.writeInterceptor === 'function' ? options.writeInterceptor : null;
  }

  setWriteFailure(shouldFail) {
    this._failOnWrite = Boolean(shouldFail);
  }

  _sessionDir(sessionId) {
    const safeId = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) {
      throw new StorageWriteError('Некорректный идентификатор сессии для сохранения', { sessionId });
    }
    const dir = path.join(this.baseDir, safeId);
    assertIsolatedStoragePath(dir, this._forbiddenRoots);
    return dir;
  }

  _writeAtomicSync(targetFile, content) {
    const dir = path.dirname(targetFile);
    fs.mkdirSync(dir, { recursive: true });
    const tmpFile = `${targetFile}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    try {
      if (this._failOnWrite) {
        const err = new Error('Simulated disk write failure (ENOSPC)');
        err.code = 'ENOSPC';
        throw err;
      }
      if (this._writeInterceptor) {
        this._writeInterceptor(targetFile, content);
      }
      fs.writeFileSync(tmpFile, content, 'utf8');
      fs.renameSync(tmpFile, targetFile);
    } catch (err) {
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {
        // Игнорируем ошибку очистки временного файла, пробрасываем основную.
      }
      throw new StorageWriteError(`Ошибка записи в изолированное хранилище: ${err.message}`, { cause: err });
    }
  }

  saveSession(sessionId, sessionPayload) {
    const dir = this._sessionDir(sessionId);
    const jsonFile = path.join(dir, 'session.json');
    const summaryFile = path.join(dir, 'summary.md');

    const safePayload = {
      schemaVersion: 1,
      isolatedSpike: true,
      sessionId,
      savedAt: new Date().toISOString(),
      ...sessionPayload,
    };

    try {
      this._writeAtomicSync(jsonFile, JSON.stringify(safePayload, null, 2));
      if (sessionPayload && sessionPayload.summaryMarkdown) {
        this._writeAtomicSync(summaryFile, String(sessionPayload.summaryMarkdown));
      }
      return {
        saved: true,
        sessionId,
        directory: dir,
        files: [jsonFile, ...(sessionPayload && sessionPayload.summaryMarkdown ? [summaryFile] : [])],
      };
    } catch (err) {
      if (err instanceof StorageWriteError) {
        err.sessionId = sessionId;
        throw err;
      }
      throw new StorageWriteError(`Сбой сохранения сессии ${sessionId}: ${err.message}`, {
        cause: err,
        sessionId,
      });
    }
  }

  loadSession(sessionId) {
    const dir = this._sessionDir(sessionId);
    const jsonFile = path.join(dir, 'session.json');
    if (!fs.existsSync(jsonFile)) return null;
    const raw = fs.readFileSync(jsonFile, 'utf8');
    return JSON.parse(raw);
  }

  listSessions() {
    if (!fs.existsSync(this.baseDir)) return [];
    const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jsonFile = path.join(this.baseDir, entry.name, 'session.json');
      if (!fs.existsSync(jsonFile)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
        out.push({
          sessionId: data.sessionId || entry.name,
          savedAt: data.savedAt || null,
          status: data.status || 'unknown',
          segmentCount: Array.isArray(data.transcript) ? data.transcript.length : 0,
        });
      } catch {
        // Повреждённую запись не маскируем — отмечаем в списке.
        out.push({ sessionId: entry.name, savedAt: null, status: 'corrupted', segmentCount: 0 });
      }
    }
    return out;
  }

  deleteSession(sessionId) {
    const dir = this._sessionDir(sessionId);
    const existed = fs.existsSync(dir);
    if (existed) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return {
      sessionId,
      existed,
      deleted: !fs.existsSync(dir),
    };
  }

  purgeAll() {
    if (!fs.existsSync(this.baseDir)) return { purged: true, removedCount: 0 };
    const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
    let removedCount = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      fs.rmSync(path.join(this.baseDir, entry.name), { recursive: true, force: true });
      removedCount += 1;
    }
    return { purged: true, removedCount };
  }
}

module.exports = {
  IsolatedSessionStore,
  assertIsolatedStoragePath,
  DEFAULT_FORBIDDEN_ROOTS,
};
