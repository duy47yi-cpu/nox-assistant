'use strict';

// Хранилище сервера. Текста переписки здесь нет и быть не должно: только аккаунты, пропуска и расход.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const { WINDOW_MS } = require('./plans');

const DAY = 24 * 3600 * 1000;
const DEFAULT_SESSION_TTL_MS = 30 * DAY;
// Версия схемы. Старая база (версия 0) доводится миграциями, данные не теряются.
const SCHEMA_VERSION = 2;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const LEGACY_ALGO = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${SCRYPT.keylen}`;
// Для несуществующей почты считаем scrypt с этой солью: ответ не должен быть быстрее и выдавать, есть ли аккаунт.
const DUMMY_SALT = '6f1c6a0d2f1f4b9e8a3c5d7e9f0a1b2c';
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Версия и параметры хеша лежат в базе: позже их можно поднять, не ломая старые записи.
function parseAlgo(algo) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$(\d+)$/.exec(String(algo || ''));
  if (!m) return null;
  const [N, r, p, keylen] = m.slice(1).map(Number);
  // Границы: испорченная запись в базе не должна съесть память.
  if (N < 16384 || N > 131072 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16 || keylen < 32 || keylen > 128) return null;
  return { N, r, p, keylen, maxmem: 128 * N * r * 2 };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex'), algo = LEGACY_ALGO) {
  const opts = parseAlgo(algo) || parseAlgo(LEGACY_ALGO);
  return {
    salt,
    hash: crypto.scryptSync(String(password), salt, opts.keylen, { N: opts.N, r: opts.r, p: opts.p, maxmem: opts.maxmem }).toString('hex'),
    algo: parseAlgo(algo) ? algo : LEGACY_ALGO,
  };
}

class Store {
  // sessionTtlMs — сколько живёт пропуск; старые пропуска при миграции получают срок от своей выдачи.
  constructor(file, { sessionTtlMs = DEFAULT_SESSION_TTL_MS } = {}) {
    this.sessionTtlMs = Number.isFinite(sessionTtlMs) && sessionTtlMs > 0 ? sessionTtlMs : DEFAULT_SESSION_TTL_MS;
    try {
      this.db = new DatabaseSync(file);
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      this._migrate();
    } catch (err) {
      try { if (this.db) this.db.close(); } catch { /* уже закрыта */ }
      const error = new Error(`база Nox не открылась: файл повреждён, это не база SQLite или нет доступа. Восстановите её из резервной копии (apps/nox-server/README.md).`);
      error.cause = err;
      throw error;
    }
  }

  _hasColumn(table, name) {
    return this.db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name);
  }

  get schemaVersion() {
    return Number(this.db.prepare('PRAGMA user_version').get().user_version) || 0;
  }

  // Схема создаётся по частям: сначала таблицы версии 0, затем миграции. Так одинаково
  // открываются и новая база, и старая, где этих колонок ещё нет.
  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL,
        plan TEXT NOT NULL, trial_until INTEGER, created_at INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tokens (
        hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS windows (
        account_id TEXT NOT NULL REFERENCES accounts(id), kind TEXT NOT NULL, started_at INTEGER NOT NULL, used_usd REAL NOT NULL,
        PRIMARY KEY (account_id, kind)
      );
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), at INTEGER NOT NULL, usd REAL NOT NULL,
        prompt INTEGER, cached INTEGER, completion INTEGER, estimated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts (key TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
      CREATE INDEX IF NOT EXISTS attempts_key ON attempts(key, at);
    `);
    if (this.schemaVersion > SCHEMA_VERSION) {
      throw new Error(`база Nox новее этого сервера: схема ${this.schemaVersion}, поддерживается до ${SCHEMA_VERSION}`);
    }
    if (this.schemaVersion < 1) {
      if (!this._hasColumn('accounts', 'pass_algo')) this.db.exec("ALTER TABLE accounts ADD COLUMN pass_algo TEXT NOT NULL DEFAULT ''");
      if (!this._hasColumn('tokens', 'expires_at')) this.db.exec('ALTER TABLE tokens ADD COLUMN expires_at INTEGER');
      this.db.exec('PRAGMA user_version = 1');
    }
    if (this.schemaVersion < 2) {
      // Старые пропуска получают срок от момента выдачи: после обновления они не живут вечно.
      this.db.prepare('UPDATE tokens SET expires_at = created_at + ? WHERE expires_at IS NULL').run(this.sessionTtlMs);
      this.db.exec('CREATE INDEX IF NOT EXISTS tokens_account ON tokens(account_id); CREATE INDEX IF NOT EXISTS tokens_expires ON tokens(expires_at); PRAGMA user_version = 2');
    }
  }

  close() {
    this.db.close();
  }

  createAccount({ email, password, plan, trialUntil, now }) {
    const { salt, hash, algo } = hashPassword(password);
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO accounts (id, email, pass_hash, pass_salt, pass_algo, plan, trial_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, email, hash, salt, algo, plan, trialUntil, now);
    return this.account(id);
  }

  account(id) {
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) || null;
  }

  accountByEmail(email) {
    return this.db.prepare('SELECT * FROM accounts WHERE email = ?').get(email) || null;
  }

  // false — не тот пароль, нет аккаунта или запись в базе битая. Исключений наружу нет: это отказ, а не 500.
  checkPassword(account, password) {
    if (!account) {
      try { hashPassword(String(password), DUMMY_SALT); } catch { /* сравнение не нужно */ }
      return false;
    }
    try {
      const algo = account.pass_algo || LEGACY_ALGO;
      const given = Buffer.from(hashPassword(String(password), String(account.pass_salt || ''), algo).hash, 'hex');
      const want = Buffer.from(String(account.pass_hash || ''), 'hex');
      return given.length > 0 && given.length === want.length && crypto.timingSafeEqual(given, want);
    } catch {
      return false;
    }
  }

  // Старый пароль после успешного входа переписывается с версией алгоритма. Пароль уже проверен.
  upgradePassword(account, password) {
    if (!account || account.pass_algo === LEGACY_ALGO) return false;
    try {
      const { salt, hash, algo } = hashPassword(password);
      return this.db.prepare('UPDATE accounts SET pass_hash = ?, pass_salt = ?, pass_algo = ? WHERE id = ? AND pass_hash = ? AND pass_salt = ?')
        .run(hash, salt, algo, account.id, account.pass_hash, account.pass_salt).changes > 0;
    } catch {
      return false; // не смогли переписать — вход всё равно уже разрешён по старому хешу
    }
  }

  setPlan(id, plan) {
    return this.db.prepare('UPDATE accounts SET plan = ? WHERE id = ?').run(plan, id).changes > 0;
  }

  setDisabled(id, disabled) {
    if (disabled) this.revokeAllTokens(id);
    return this.db.prepare('UPDATE accounts SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id).changes > 0;
  }

  // В базе только хеш: украденная база не даёт войти чужими пропусками.
  issueToken(accountId, now) {
    this.pruneTokens(now);
    const token = `nox_${crypto.randomBytes(32).toString('base64url')}`;
    this.db.prepare('INSERT INTO tokens (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), accountId, now, now + this.sessionTtlMs);
    return token;
  }

  accountByToken(token, now = Date.now()) {
    if (!token) return null;
    return this.db.prepare('SELECT a.* FROM tokens t JOIN accounts a ON a.id = t.account_id WHERE t.hash = ? AND t.revoked = 0 AND a.disabled = 0 AND (t.expires_at IS NULL OR t.expires_at > ?)').get(sha256(String(token)), now) || null;
  }

  revokeToken(token) {
    this.db.prepare('UPDATE tokens SET revoked = 1 WHERE hash = ?').run(sha256(String(token)));
  }

  revokeAllTokens(accountId) {
    this.db.prepare('UPDATE tokens SET revoked = 1 WHERE account_id = ? AND revoked = 0').run(accountId);
  }

  // Просроченные пропуска удаляем: иначе таблица растёт вечно.
  pruneTokens(now) {
    this.db.prepare('DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
  }

  // Окно начинается с первого запроса после конца прошлого, как у Claude Code.
  window(accountId, kind, now) {
    const row = this.db.prepare('SELECT started_at, used_usd FROM windows WHERE account_id = ? AND kind = ?').get(accountId, kind);
    if (!row || now >= row.started_at + WINDOW_MS[kind]) return { active: false, startedAt: null, usedUsd: 0, resetAt: null };
    return { active: true, startedAt: row.started_at, usedUsd: row.used_usd, resetAt: row.started_at + WINDOW_MS[kind] };
  }

  // Окно отсчитывается от начала запроса, даже если расход записан позже.
  openWindows(accountId, now) {
    for (const kind of Object.keys(WINDOW_MS)) {
      if (!this.window(accountId, kind, now).active) {
        this.db.prepare('INSERT INTO windows (account_id, kind, started_at, used_usd) VALUES (?, ?, ?, 0) ON CONFLICT(account_id, kind) DO UPDATE SET started_at = excluded.started_at, used_usd = 0')
          .run(accountId, kind, now);
      }
    }
  }

  charge(accountId, { usd, weight = 1, prompt = null, cached = null, completion = null, estimated, now }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO usage (account_id, at, usd, prompt, cached, completion, estimated) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(accountId, now, usd, prompt, cached, completion, estimated ? 1 : 0);
      this.db.prepare('UPDATE windows SET used_usd = used_usd + ? WHERE account_id = ?').run(usd * weight, accountId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // Расход всего сервера с момента since: предохранитель кошелька владельца.
  spentSince(since) {
    return this.db.prepare('SELECT COALESCE(SUM(usd), 0) AS s FROM usage WHERE at >= ?').get(since).s;
  }

  // true — попытка учтена, false — лимит превышен. Для входа и регистрации.
  allowAttempt(key, { max, perMs, now }) {
    this.db.prepare('DELETE FROM attempts WHERE at < ?').run(now - DAY);
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE key = ? AND at >= ?').get(key, now - perMs);
    if (n >= max) return false;
    this.db.prepare('INSERT INTO attempts (key, at) VALUES (?, ?)').run(key, now);
    return true;
  }

  // Проверка без учёта: нужно служебным запросам, где считать надо только неудачные попытки.
  tooMany(key, { max, perMs, now }) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE key = ? AND at >= ?').get(key, now - perMs).n >= max;
  }

  recordAttempt(key, now) {
    this.db.prepare('DELETE FROM attempts WHERE at < ?').run(now - DAY);
    this.db.prepare('INSERT INTO attempts (key, at) VALUES (?, ?)').run(key, now);
  }

  // Резервная копия. VACUUM INTO делает цельный снимок вместе с WAL: копировать файлы вручную нельзя.
  // Существующий файл не перезаписываем, чтобы не потерять прежнюю копию.
  backupTo(file) {
    if (!file) throw new Error('нужен путь для резервной копии');
    if (fs.existsSync(file)) throw new Error(`резервная копия уже существует: ${file}`);
    const target = `'${String(file).replace(/'/g, "''")}'`;
    this.db.exec(`VACUUM INTO ${target}`);
    return { file, bytes: fs.statSync(file).size };
  }
}

module.exports = { Store, sha256, hashPassword, SCHEMA_VERSION, DEFAULT_SESSION_TTL_MS };
