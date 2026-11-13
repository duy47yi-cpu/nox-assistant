# OPUS PROGRESS

### 2026-11-13 — Opus-роль (фактически исполняет сессия Claude Code) — Ticket D0 — checkpoint 01
State: DONE
Actions performed:
- Распакован `NOX_AETHER_HANDOFF.zip`, прочитаны мастер-промпт, спеки 01–05, 07, 4 референса. 06_TESTS_AND_ACCEPTANCE.md и PDF: пока не читал (нужны на Gate 3 / для сверки).
- Прочитан код (read-only) `D:\nox-release\apps\jarvis-desktop\renderer`: точки входа, две рендер-системы сфер, выбор варианта, события ядра. Результат — VISUAL_BASELINE.md.
- Создана папка артефактов и `package/` (копия пакета).
Tests/visual checks: живой Electron/браузерный снимок — NOT RUN (панель браузера скрыта, проверка политики не завершилась). Тесты проекта — NOT RUN (Gate 1 их не требует).
Known blockers: идентификация «точечной/синей» сфер требует подтверждения владельца.
Next exact action: запустить Fable по FABLE_TASK.md.
Do not touch: apps/**, src/**, main.js, preload.js, orb-*.js, nox-screen.*.

### 2026-11-13 — checkpoint 02 — D1 запущен
- Прочитаны 06_TESTS_AND_ACCEPTANCE.md и стр. 1–4 PDF (PDF — краткая сводка, нового не добавляет).
- Fable (реальный субагент, model=fable) запущен в фоне по FABLE_TASK.md. Результат: ЖДЁМ уведомления, ничего не предполагаю.
- Next: по готовности D1 → Haiku по HAIKU_TASK.md.


### 2026-11-13 — Agent: Opus (Continuation) — Checkpoints 03–04
State: GATE 1 COMPLETE · REVIEW READY (ожидает выбора владельца)
Goal: завершить восстановление контекста, архитектуру Orb Library и новой оболочки, довести прототипы до всех 7 экранов × 2 размеров, провести независимый QA и подготовить handoff.
Files created/updated in `docs/design/nox-aether/`:
- `ORB_LIBRARY_ARCHITECTURE.md` (new) — разбор `NoxOrb` vs `JarvisOrb`, архитектура `OrbRegistry` / `OrbEngineAdapter` / `OrbSettingsStore` (отдельные параметры каждой сферы, пресеты, дефолты, будущие пользовательские сферы и движки).
- `AETHER_SHELL_ARCHITECTURE.md` (new) — компонентная схема чистой оболочки `renderer/aether/`, карта «что заменено vs что сохранено», план безопасного отката через `uiShell`.
- `prototypes/shared/base.css`, `prototypes/shared/proto.js`, `prototypes/b/index.html`, `prototypes/c/index.html`, `prototypes/INDEX.md` (updated) — добавлены превью-плотность для `jarvis-sphere`, работающий слайдер `speed`, изолированное хранение настроек каждой сферы (`perOrb`), пресеты/сброс сферы, адаптивная 2-колоночная сетка карточек на `864×520`, явная навигация по всем 7 обязательным видам (+ голос), улучшенная контрастная подложка в C и компактный слой B на малой высоте, очистка DOM-карточек при закрытии Мастерской.
- `screenshots/*.png` — актуальный комплект из **48 PNG** (`A/B/C × 8 видов × 1200×720 и 864×520`), удалены 3 устаревших `stateworkshop_864x520.png`.
- `QA_REVIEW.md` (new), `TASKS.md`, `OPUS_DECISIONS.md`, `HANDOFF.md` (updated).
Verified checks:
- Chrome Headless CDP (`task-226`): **52 проверки, 0 падений**, 0 ошибок консоли/исключений; подтверждено переключение сфер без потери `perOrb` параметров (`glow=1.5`, `dens=1.3`), сброс к умолчаниям, работа клавиатуры в подтверждении (`Esc`), `prefers-reduced-motion`.
- Независимый QA-аудит (`aether_qa`): PASS по всем 6 пунктам чеклиста, замечания (`[M]`, `2×[L]`) записаны для этапа Gate 2.
- `apps/jarvis-desktop/renderer/`, `apps/nox-server/`, `src/` и ветки C5/C6/C7 не изменялись.
