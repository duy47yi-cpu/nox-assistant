# FILE OWNERSHIP

| Область | Владелец | Правило |
|---|---|---|
| `docs/design/nox-aether/prototypes/**` | Fable | единственное место записи Fable в Gate 1 |
| `docs/design/nox-aether/screenshots/**` | Fable (снимки макетов), Haiku (QA-снимки в `screenshots/qa/`) | — |
| `docs/design/nox-aether/*.md` (TASKS, OPUS_*, HANDOFF, VISUAL_BASELINE, FILE_OWNERSHIP, QA_MATRIX) | Opus | остальные не правят |
| `FABLE_PROGRESS.md` | Fable | только он |
| `HAIKU_QA.md` | Haiku | только он |
| `apps/jarvis-desktop/renderer/*` (вкл. `orb*.js`, `nox-screen.*`, `index.html`, `app.js`) | **никто** в Gate 1 | только чтение; сферы подключать из прототипов относительным путём `../../../../apps/jarvis-desktop/renderer/orb-*.js` |
| `main.js`, `preload.js`, `src/**`, `apps/nox-server/**` | C5/C6/C7 | не трогать |
| `.env`, `data/` | — | не читать |
