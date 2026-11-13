'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { getModelSpec, DEFAULT_RUSSIAN_MODEL_ID } = require('./model-catalog');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const FORBIDDEN_MODEL_ROOTS = [
  path.join(REPO_ROOT, 'apps'),
  path.join(REPO_ROOT, 'data'),
  path.join(REPO_ROOT, 'workspace'),
  path.join(REPO_ROOT, 'apps', 'jarvis-desktop', 'data'),
  path.join(REPO_ROOT, 'apps', 'nox-server', 'data'),
  path.join(REPO_ROOT, 'apps', 'nox-meeting-spike', 'src'),
  path.join(REPO_ROOT, 'apps', 'nox-meeting-spike', '.spike-sessions'),
];

const FORBIDDEN_FILENAMES = new Set([
  '.env',
  '.env.local',
  'chats.json',
  'journal.jsonl',
  'memory.json',
  'conversation.json',
  'settings.json',
  'deals.json',
  'missions.json',
  'account.bin',
  'gmail.bin',
]);

class ModelStorageIsolationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelStorageIsolationError';
    this.code = 'MODEL_STORAGE_ISOLATION_VIOLATION';
  }
}

class ModelNotInstalledError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ModelNotInstalledError';
    this.code = 'ASR_MODEL_NOT_INSTALLED';
    this.retryable = false;
    this.modelId = options.modelId || null;
    this.modelDir = options.modelDir || null;
  }
}

class ModelValidationError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ModelValidationError';
    this.code = options.code || 'ASR_MODEL_INVALID';
    this.retryable = false;
    this.modelId = options.modelId || null;
    this.details = options.details || null;
  }
}

function normalizePath(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSubPath(candidate, root) {
  const rel = path.relative(normalizePath(root), normalizePath(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Возвращает каталог хранения весов ASR вне исходников Nox и вне пользовательских разговоров.
 */
function getDefaultModelsDir({ env = process.env, platform = process.platform, homeDir = os.homedir() } = {}) {
  if (env.NOX_ASR_MODELS_DIR && String(env.NOX_ASR_MODELS_DIR).trim()) {
    return path.resolve(String(env.NOX_ASR_MODELS_DIR).trim());
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    return path.join(localAppData, 'NoxAssistant', 'models', 'asr');
  }
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'NoxAssistant', 'models', 'asr');
  }
  const xdgData = env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share');
  return path.join(xdgData, 'nox-assistant', 'models', 'asr');
}

/**
 * Гарантирует, что папка моделей отделена от исходного кода Nox, папки data/ и диалогов.
 */
function assertIsolatedModelPath(targetDir, extraForbiddenRoots = []) {
  if (!targetDir || typeof targetDir !== 'string' || !targetDir.trim()) {
    throw new ModelStorageIsolationError('Путь хранилища моделей ASR должен быть непустой строкой');
  }

  const resolved = path.resolve(targetDir);
  const envDataDir = process.env.NOX_DATA_DIR ? path.resolve(process.env.NOX_DATA_DIR) : null;
  const forbiddenRoots = [
    ...FORBIDDEN_MODEL_ROOTS,
    ...(envDataDir ? [envDataDir] : []),
    ...extraForbiddenRoots,
  ];

  for (const root of forbiddenRoots) {
    if (!root) continue;
    if (isSubPath(resolved, root)) {
      throw new ModelStorageIsolationError(
        `Запрещено хранить веса ASR внутри исходников или данных Nox (${resolved} пересекается с ${path.resolve(root)})`
      );
    }
  }

  const base = path.basename(resolved).toLowerCase();
  if (FORBIDDEN_FILENAMES.has(base)) {
    throw new ModelStorageIsolationError(`Запрещено использовать служебный файл Nox "${base}" в пути моделей`);
  }

  const segments = resolved.split(path.sep).map((s) => s.toLowerCase());
  if (segments.includes('jarvis-desktop') && (segments.includes('data') || segments.includes('src') || segments.includes('renderer'))) {
    throw new ModelStorageIsolationError('Запрещено смешивать веса моделей с кодом или данными jarvis-desktop');
  }
  if (segments.includes('nox-server')) {
    throw new ModelStorageIsolationError('Запрещено хранить веса моделей в каталоге nox-server');
  }

  return resolved;
}

function sha256FileSync(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Управляет локальным расположением и проверкой моделей ASR строго без сетевых вызовов.
 * Загрузка моделей вынесена в явный пользовательский шаг и отключена по умолчанию.
 */
class ModelStore {
  constructor(options = {}) {
    this._extraForbiddenRoots = Array.isArray(options.forbiddenRoots) ? options.forbiddenRoots : [];
    const candidateDir = options.modelsDir || getDefaultModelsDir();
    this.modelsDir = assertIsolatedModelPath(candidateDir, this._extraForbiddenRoots);
    this.requireManifestChecksums = Boolean(options.requireManifestChecksums);
    this.requireAttributionNotice = Boolean(options.requireAttributionNotice);
  }

  getModelDir(modelId = DEFAULT_RUSSIAN_MODEL_ID, customModelDir = null) {
    if (customModelDir) {
      return assertIsolatedModelPath(customModelDir, this._extraForbiddenRoots);
    }
    const spec = getModelSpec(modelId);
    const target = path.join(this.modelsDir, spec.archiveName);
    return assertIsolatedModelPath(target, this._extraForbiddenRoots);
  }

  /**
   * Чисто локальная проверка модели без сети и без автоматического скачивания.
   */
  inspectModel(modelId = DEFAULT_RUSSIAN_MODEL_ID, options = {}) {
    const spec = getModelSpec(modelId);
    const modelDir = this.getModelDir(modelId, options.modelDir || null);

    if (!fs.existsSync(modelDir)) {
      return {
        installed: false,
        valid: false,
        offlineReady: false,
        modelId: spec.id,
        modelDir,
        missingFiles: Object.keys(spec.files),
        resolvedFiles: {},
        warnings: [],
        reason: `Каталог модели не найден: ${modelDir}`,
      };
    }

    const stat = fs.statSync(modelDir);
    if (!stat.isDirectory()) {
      throw new ModelValidationError(`Путь модели не является каталогом: ${modelDir}`, {
        modelId: spec.id,
        code: 'ASR_MODEL_NOT_A_DIRECTORY',
      });
    }

    const resolvedFiles = {};
    const missingFiles = [];
    const warnings = [];
    let totalBytes = 0;

    for (const [role, candidates] of Object.entries(spec.files)) {
      const list = Array.isArray(candidates) ? candidates : [candidates];
      let foundPath = null;
      for (const relName of list) {
        const candidatePath = path.join(modelDir, relName);
        if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
          const size = fs.statSync(candidatePath).size;
          if (size > 0) {
            foundPath = candidatePath;
            totalBytes += size;
            break;
          }
        }
      }
      if (!foundPath) {
        missingFiles.push({ role, expectedOneOf: list });
      } else {
        resolvedFiles[role] = foundPath;
      }
    }

    // Проверяем файл локального манифеста и контрольные суммы (если присутствуют)
    const manifestPath = path.join(modelDir, 'nox-model-manifest.json');
    let manifest = null;
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (err) {
        throw new ModelValidationError(`Повреждён manifest модели: ${err.message}`, {
          modelId: spec.id,
          code: 'ASR_MODEL_MANIFEST_CORRUPTED',
        });
      }
    } else if (this.requireManifestChecksums) {
      missingFiles.push({ role: 'manifest', expectedOneOf: ['nox-model-manifest.json'] });
    }

    if (manifest && manifest.files && typeof manifest.files === 'object') {
      for (const [relName, expectedSha] of Object.entries(manifest.files)) {
        if (!expectedSha) continue;
        const targetFile = path.join(modelDir, relName);
        if (!fs.existsSync(targetFile)) {
          missingFiles.push({ role: `checksum:${relName}`, expectedOneOf: [relName] });
          continue;
        }
        const actualSha = sha256FileSync(targetFile);
        if (actualSha.toLowerCase() !== String(expectedSha).toLowerCase()) {
          throw new ModelValidationError(
            `Контрольная сумма SHA-256 не совпала для ${relName}`,
            {
              modelId: spec.id,
              code: 'ASR_MODEL_CHECKSUM_MISMATCH',
              details: { file: relName, expected: expectedSha, actual: actualSha },
            }
          );
        }
      }
    }

    // Проверка наличия лицензии/уведомления для коммерческой поставки
    const noticeCandidates = ['NOTICE', 'LICENSE', 'ATTRIBUTION.txt', 'LICENSE.txt'];
    const foundNotice = noticeCandidates.find((name) => fs.existsSync(path.join(modelDir, name)));
    if (!foundNotice) {
      const msg =
        'В каталоге модели отсутствует локальный файл NOTICE/LICENSE (требуется для коммерческого аудита Apache-2.0)';
      if (this.requireAttributionNotice) {
        missingFiles.push({ role: 'license_notice', expectedOneOf: noticeCandidates });
      } else {
        warnings.push(msg);
      }
    }

    const valid = missingFiles.length === 0;
    return {
      installed: valid,
      valid,
      offlineReady: valid,
      modelId: spec.id,
      displayName: spec.displayName,
      recognizerKind: spec.recognizerKind,
      modelType: spec.modelType,
      sampleRate: spec.sampleRate,
      featureDim: spec.featureDim,
      decodingMethod: spec.decodingMethod,
      modelDir,
      resolvedFiles,
      missingFiles,
      totalBytes,
      licenseSpdx: spec.weightsLicense.spdx,
      noticeFile: foundNotice || null,
      manifestVerified: Boolean(manifest),
      warnings,
      reason: valid ? null : 'Не хватает обязательных файлов модели',
    };
  }

  /**
   * Возвращает проверенные пути к локальным файлам для RealASRProvider или бросает ModelNotInstalledError.
   */
  resolveRecognizerFiles(modelId = DEFAULT_RUSSIAN_MODEL_ID, options = {}) {
    const report = this.inspectModel(modelId, options);
    if (!report.valid) {
      throw new ModelNotInstalledError(
        `Локальная модель ASR "${report.modelId}" не установлена или неполна в ${report.modelDir}. Автозагрузка запрещена.`,
        { modelId: report.modelId, modelDir: report.modelDir }
      );
    }
    return report;
  }

  /**
   * Формирует план ручной установки весов без выполнения сетевых запросов.
   */
  buildDownloadPlan(modelId = DEFAULT_RUSSIAN_MODEL_ID, options = {}) {
    const spec = getModelSpec(modelId);
    const targetDir = this.getModelDir(modelId, options.modelDir || null);
    return {
      modelId: spec.id,
      displayName: spec.displayName,
      downloadUrl: spec.downloadUrl,
      targetDir,
      approxArchiveSizeMb: spec.approxArchiveSizeMb,
      approxExtractedSizeMb: spec.approxExtractedSizeMb,
      weightsLicense: spec.weightsLicense,
      requiresExplicitUserConfirmation: true,
      isolatedFromNoxSources: true,
      isolatedFromNoxChats: true,
      requiredFiles: spec.files,
      recommendedAttributionNotice: [
        `Model: ${spec.archiveName}`,
        `Upstream: ${spec.weightsLicense.upstreamProject} (${spec.weightsLicense.upstreamUrl})`,
        `License: ${spec.weightsLicense.spdx}`,
        spec.weightsLicense.complianceNote,
      ].join('\n'),
    };
  }

  /**
   * Защищённая точка будущей загрузки весов: отказывает без явного согласия пользователя и в offline-режиме.
   * На текущем этапе реальная сетевая загрузка запрещена и делегируется только явно переданному downloaderFn.
   */
  async installWithConsent({
    modelId = DEFAULT_RUSSIAN_MODEL_ID,
    userConfirmed = false,
    offlineOnly = true,
    targetModelDir = null,
    downloaderFn = null,
  } = {}) {
    if (userConfirmed !== true) {
      throw new ModelValidationError(
        'Загрузка весов ASR запрещена без явного подтверждения владельца (userConfirmed: true)',
        { modelId, code: 'ASR_DOWNLOAD_CONSENT_REQUIRED' }
      );
    }
    if (offlineOnly) {
      throw new ModelValidationError(
        'Загрузка весов заблокирована в автономном режиме (offlineOnly: true)',
        { modelId, code: 'ASR_OFFLINE_MODE_BLOCKS_DOWNLOAD' }
      );
    }
    const plan = this.buildDownloadPlan(modelId, { modelDir: targetModelDir });
    if (typeof downloaderFn !== 'function') {
      throw new ModelValidationError(
        'Сетевой загрузчик моделей не подключён до разрешения владельца на Этапе 2',
        { modelId, code: 'ASR_DOWNLOADER_NOT_ENABLED' }
      );
    }
    return downloaderFn(plan);
  }
}

module.exports = {
  ModelStore,
  ModelStorageIsolationError,
  ModelNotInstalledError,
  ModelValidationError,
  FORBIDDEN_MODEL_ROOTS,
  getDefaultModelsDir,
  assertIsolatedModelPath,
  sha256FileSync,
};
