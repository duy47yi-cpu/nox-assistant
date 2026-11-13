# TASKS — NOX AETHER

| ID | Owner | State | Files | Deliverable | QA / Blocker |
|---|---|---|---|---|---|
| D0 | Opus | DONE | `VISUAL_BASELINE.md`, `FILE_OWNERSHIP.md`, `OPUS_DECISIONS.md` | Аудит базы и ограничений | Готово |
| D1 | Fable + Opus | DONE | `prototypes/*`, `screenshots/*.png` (48 шт.) | 3 концепции A/B/C, все 7 состояний (+ голос) на `1200×720` и `864×520`, Мастерская с `perOrb` и пресетами | 52/52 CDP-проверки PASS |
| D2 | Opus | DONE | `ORB_LIBRARY_ARCHITECTURE.md` | Архитектура Orb Library с сохранением `NoxOrb` и `JarvisOrb` без правок движков | Проверено QA |
| D3 | Opus | DONE | `AETHER_SHELL_ARCHITECTURE.md` | Архитектура новой чистой UI-оболочки `renderer/aether/` и карта замен/сохранения | Проверено QA |
| Q1 | `aether_qa` (subagent) | DONE | `QA_REVIEW.md` | Независимый read-only QA-аудит (в т.ч. `864×520` и изоляция `renderer/`) | PASS (1 [M], 2 [L] в backlog Gate 2) |
| A1 | Владелец | WAITING_USER | — | Выбор концепции (**A**, **B** или **C**; рекомендована **B**) и подтверждение активной пары/дефолтов сфер | **СТОП перед Gate 2** |
| I1–I2 | — | BLOCKED | `apps/jarvis-desktop/renderer/aether/*` | Реализация новой оболочки и `OrbLibrary` + обновление `AGENTS.md` + `node --test` | Ждёт A1 |
