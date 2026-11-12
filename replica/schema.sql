-- Предлагаемая миграция для новой локальной базы Nox на Windows.
-- Применяет главный процесс, который создаёт UUID через crypto.randomUUID(),
-- передаёт UTC epoch milliseconds и проверяет принадлежность workspace.
-- Запускать только для версии схемы 0. Новую версию проверять до BEGIN.
-- Включать foreign_keys для каждого соединения, а не только при миграции.
PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_ref TEXT NOT NULL,
  chat_ref TEXT NOT NULL,
  request_key TEXT,
  input_kind TEXT NOT NULL CHECK (input_kind IN ('text', 'voice')),
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'running', 'waiting', 'confirmed', 'partial',
    'unknown', 'failed', 'cancelled', 'interrupted'
  )),
  last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (workspace_ref, request_key)
) STRICT;

CREATE INDEX runs_by_workspace_chat ON runs (workspace_ref, chat_ref, created_at DESC, id);
CREATE INDEX runs_by_state ON runs (state, updated_at);

-- Для send/cart effect_key — HMAC канонического внешнего намерения,
-- включая профиль, назначение, цель и текст/количество. Ключ HMAC из хранилища ОС.
-- idempotency_key — стабильный ключ операции в текущем run.
-- Храним отпечаток и обрезанную сводку. Не храним сообщение, cookies и разрешение
-- на автоматическое продолжение. Для удаления хода см. workflow в architecture.md.
CREATE TABLE action_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_ref TEXT NOT NULL,
  run_id TEXT,
  step_no INTEGER NOT NULL CHECK (step_no > 0),
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  effect_key TEXT,
  target_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'planned', 'waiting', 'dispatching', 'confirmed', 'unknown',
    'absent', 'failed', 'cancelled', 'rejected'
  )),
  policy_mode TEXT NOT NULL CHECK (policy_mode IN ('full', 'ask', 'auto')),
  decision_kind TEXT NOT NULL CHECK (decision_kind IN (
    'pending', 'policy', 'owner', 'rejected'
  )),
  summary_redacted TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE SET NULL,
  UNIQUE (run_id, step_no),
  UNIQUE (run_id, idempotency_key),
  CHECK (operation NOT IN ('telegram.send', 'ozon.cart.add') OR effect_key IS NOT NULL),
  CHECK (state NOT IN ('dispatching', 'confirmed') OR decision_kind IN ('policy', 'owner'))
) STRICT;

CREATE INDEX attempts_by_workspace ON action_attempts (workspace_ref, created_at DESC);
CREATE INDEX attempts_recovery ON action_attempts (state, updated_at);
-- Блокировка на весь локальный профиль: один и тот же внешний эффект может
-- попасть из двух рабочих пространств. Ключ включает идентичность внешней сессии.
CREATE UNIQUE INDEX attempts_one_open_effect ON action_attempts (effect_key)
  WHERE effect_key IS NOT NULL AND state IN ('dispatching', 'unknown');

CREATE TRIGGER attempts_scope_insert
BEFORE INSERT ON action_attempts
WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM runs WHERE id = NEW.run_id AND workspace_ref = NEW.workspace_ref
)
BEGIN
  SELECT RAISE(ABORT, 'attempt workspace mismatch');
END;

CREATE TRIGGER attempts_scope_update
BEFORE UPDATE OF run_id, workspace_ref ON action_attempts
WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM runs WHERE id = NEW.run_id AND workspace_ref = NEW.workspace_ref
)
BEGIN
  SELECT RAISE(ABORT, 'attempt workspace mismatch');
END;

CREATE TABLE attachments (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 20971520),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

CREATE INDEX attachments_by_run ON attachments (run_id, created_at);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('docx', 'pptx', 'xlsx', 'md', 'txt')),
  relative_path TEXT NOT NULL UNIQUE,
  sha256 TEXT CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size_bytes INTEGER CHECK (size_bytes >= 0),
  state TEXT NOT NULL CHECK (state IN ('staging', 'ready', 'invalid', 'missing')),
  verification_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(verification_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (state <> 'ready' OR (sha256 IS NOT NULL AND size_bytes IS NOT NULL))
) STRICT;

CREATE INDEX artifacts_by_run ON artifacts (run_id, created_at DESC, id);
CREATE INDEX artifacts_by_state ON artifacts (state, updated_at);

-- Ссылки на URL/окно и наблюдение. Не хранит сырые снимки или аудиозаписи.
-- Пара run_id + step_no при наличии шага проверяется через связь.
CREATE TABLE evidence (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  step_no INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('window', 'screen', 'web', 'media', 'file', 'system', 'app')),
  source_ref_redacted TEXT NOT NULL,
  note_redacted TEXT NOT NULL,
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (run_id, step_no) REFERENCES action_attempts (run_id, step_no) ON DELETE CASCADE
) STRICT;

CREATE INDEX evidence_by_run_step ON evidence (run_id, step_no, observed_at DESC);

PRAGMA user_version = 1;

COMMIT;

-- Удаление хода из UI: одним transaction очистить summary_redacted,
-- обнулить run_id у 'unknown'/'dispatching' после удаления их evidence,
-- остальные попытки удалить, затем удалить run. Файлы очищать только после
-- коммита и повторной проверки ссылок. Отметку unresolved нельзя перевести
-- в absent лишь потому, что внешний сервис временно недоступен.

