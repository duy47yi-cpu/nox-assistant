# Доказательства независимой проверки S0

- `git-status-start.txt`, `git-diffstat-start.txt`, `git-diff-core-start.patch` — срез рабочей копии до начала проверки (`HEAD 7e6cdc509982`, грязное дерево).
- `hashes-start.txt`, `hashes-end.txt` — SHA-256 девяти проверяемых файлов в начале и в конце; совпадают.
- `baseline-jarvis-node-test.log` (2141/2141), `baseline-server-node-test.log` (31/31).
- `core/zm-core.test.js`, `core/zm-core.test.log` — свои тесты ядра, 15/15. Запуск: `node --test docs/audits/zero-mercy/independent-s0/evidence/core/` из корня.
- `live/zm-live.js` — стенд настоящего окна. Из `apps/jarvis-desktop`:
  - `node_modules/.bin/electron ../../docs/audits/zero-mercy/independent-s0/evidence/live/zm-live.js main 1200x720 <имя>`
  - `... restart-write 1200x720 <имя>`, затем `... restart-read 1200x720 <то же имя>`
- `live/summarize.js runs/<имя>/main.json` — краткая таблица прогона.
- `live/runs/main-864x520-r3/`, `live/runs/main-1200x720-r3/` — **финальные** прогоны: `main.json` (все снимки, вызовы IPC, эффекты, события окна), `summary.txt`, PNG.
- `live/runs/restart-*-r1/` — перезапуск без обработчиков выхода: `restart-write.json`, `restart-read.json`, PNG до и после.
- `live/runs/main-864-r1/`, `live/runs/main-864-r2/` — отброшенные ранние прогоны (см. `TEST-RESULTS.md`). Оставлены, потому что в них впервые проявились N5 и N3.

Папки браузерного профиля Chromium (`profile/`) удалены после прогонов: это кэш временного профиля, доказательств в нём нет. `data/` и `workspace/` прогонов оставлены. Все эффекты фиктивных агентов — только массив в памяти. Единственная настоящая запись могла бы произойти в `runs/restart-*/workspace/reports/` и не произошла.
