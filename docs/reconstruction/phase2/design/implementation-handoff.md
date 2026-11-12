# Implementation Handoff — передача в разработку

> Этот документ — единственный контракт для реализации Phase 2.2. Все визуальные решения зафиксированы; доработка без дизайн-ревью запрещена. Маркеры [В]/[О]/[П] из `video-analysis.md`.

---

## 1. Объём и запреты

### Что делать

- Собрать единые разделы **Команды / Подключения / Настройки / Журнал+Агент** на базе чата Nox.
- Использовать токены `design-system.md` и лейаут `navigation-layout.md`.
- Сохранить все существующие IPC, хранилища, режимы, пространства — только визуальный слой.

### Строгие запреты [П]

НЕ изменять:

```
renderer/  (любые css/js кроме новых nox-* — согласовать)
main.js, preload.js, app.js, index.html, package.json
Backend и IPC (только чтение существующих каналов)
Не создавать рабочие React/Electron-компоненты до утверждения this handoff
Не запускать миграцию данных, не ставить зависимости, не запускать другие модели
Работать только внутри docs/reconstruction/phase2/design/ на этапе дизайна
```

После утверждения: разрешённые файлы — новые `renderer/nox-*.css/.js` (или расширение `nox-screen.*`) + правка `app.js` для монтирования видов (как в Phase 1), плюс новые IPC если согласованы для сферы/генерации [П].

---

## 2. Карта файлов

```
renderer/
  nox-screen.css/js        # уже готов (чат) — не ломать, изолировать body[data-view="nox"] как есть
  nox-commands.css/js      # P1 — список/библиотека/редактор/выбор/запись/импорт
  nox-connections.css/js   # P1 — каталог/популярные/диалоги/сетевые состояния
  nox-settings.css/js      # P1 — нав+поиск+карты+сфера preview (disabled)
  nox-history.css/js       # P2 — таблица/карты/детали/ход/подтверждения/итог
  tokens-nox.css (опц.)    # вынос токенов из nox-screen.css — только если без регрессии

src/  (только если нужен новый контракт)
  commands/  store.js/runner.js  — читать; saveDraft payload расширить совместимо
  mcp/       client.js/drift.js — читать
  agent/     loop.js/effects.js — читать для verification
```

---

## 3. Приоритет и зависимости

| Приоритет | Раздел | Зависит от | Критерий готовности |
|-----------|--------|------------|---------------------|
| **P0** | Каркас | Токены, rail, .nox-workspace | 1200 и 864 без горизонтального скролла, темы не сломаны, `data-nav` + Ctrl+1..5 работают |
| **P1** | Команды — список и библиотека | P0 | Строки 64, шеврон preview, search, паки не ставят без клика |
| **P1** | Команды — редактор + выбор | P0 | Валидация, фокус на первой ошибке, add/enter, dirty guard, preview без запуска |
| **P1** | Команды — запись/импорт/экспорт | P1 editor | captured tools + warn координат, diff с конфликтом блокирует импорт |
| **P1** | Подключения | P0 | 7 статусов, популярные 7, drift до подтверждения блокирует действия |
| **P1** | Настройки | P0 | Все секции перенесены, поиск не удаляет контролы, условные скрыты когда флага нет |
| **P2** | Журнал и агент | P0 | Table/card, детали только из записи, ход честно, approval timer 30с |
| **Future** | Сфера контролы | P1 settings | Только preview, версионированный ключ, не меняет живую сферу |

---

## 4. Контракты данных (читать, не менять)

| Экран | Источники (preload → main → src) |
|-------|-----------------------------------|
| Команды список | `commands:list → commands:list → src/commands/store.js + src/workspaces/commands.js (workspaceId)`, `renderCmdList/renderPacks`, `packs:install → seedPackCommands` |
| Редактор | `saveDraft → commands:save → store.js v2 (atomic)`, `loadCommands`, `cmd-steps.js showPreview` (без запуска) |
| Выбор действия | `tools:catalog → EDITOR_STEP_TOOLS (app_open, ui_keys, wait, speak, volume_set)` + фильтр редактора |
| Запись | `commands:record-start/stop/cancel/state → CommandRecorder + captureRecordedTool (tool_start)` |
| Импорт/экспорт | `commands:import-pick/import-apply(token,true)/export → store.js diff + token confirm` |
| Подключения | `mcp:state/add/toggle/remove/approve + connections.js POPULAR (7) + statusOf + approval:respond` |
| Настройки | `settings:get/set + settings:setModelTier/setThinking + owner:providers + look.js/accent.js/theme-boot.js + app.js/account.js/extensions.js` |
| Сфера | `nox-screen.js setVariant wire/nox + localStorage noxOrb` (текущее); future — новый версионированный ключ |
| Журнал | `journal:recent/search + src/journal/journal.js recordToEntry + historyStatus + shared.js`, workspace isolated |
| Агент | `agent:event {runId,step,status,label,target,verification,cancelled} + agent:stop + approval:respond + src/agent/effects.js` |

- Новые IPC для генерации команды из редактора и ручек сферы — **отдельный согласованный контракт**; не рисовать как работающие без него [П].

---

## 5. Известные риски (совместимость)

- `saveDraft` формирует ограниченный payload; `store.js` сохраняет `collections`/`optionalPhrases` если поля отсутствуют — проверить старые/неизвестные шаги при реализации [П].
- `journalSearch` есть в preload, экран его не вызывает — full search требует разработки [П].
- `connections load catch → empty list` скрывает ошибку — нужен UI-адаптер для error vs empty [П].
- Пределы `name 60 / phrase 80 / folder 60 / hotkey 40 / steps 20` — не менять молча [П].

---

## 6. Визуальная приёмка (общая)

### 6.1 Геометрия

- [ ] Окно 1200×720: rail 52, history/nav 244/252, main 800–828, sphere 360, gap 8, header 56, rows 56–64, panel r16 card r12 control r8.
- [ ] Окно 864×520: rail 46, drawer 280 overlay, sphere hidden, паки/popular под списком, filters horizontal scroll, table→cards, dialog win-32px, footer sticky.
- [ ] Длинный текст (80 симв фразы, 260 симв app name) — wrap `anywhere`, кнопки не перекрываются, скролл внутри.
- [ ] Темы: Nox-токены внутри `body[data-view="nox"]` не перезаписывают `themes.css` классических разделов.

### 6.2 Цвета и типографика

- [ ] Фон сплошной #0F0F10, без градиента/пятна; панели #18181B border #2A2A2E.
- [ ] Inter 14/500 заголовки строк, 24/600 заголовок раздела, mono для args.
- [ ] Контраст text-1/surface-2 16:1, accent/surface-2 6:1; focus ring 2px.
- [ ] Hover — surface-hover 6% mix, не «синий фон».

### 6.3 Состояния

- [ ] Loading (спиннер+текст) ≠ Empty (иконка+подсказка+CTA) ≠ No results ( + Сбросить) ≠ Error (banner+retry).
- [ ] Disabled ghost, active accent-soft+accent, selected border accent, error err/14%+err.
- [ ] Dirty guard при уходе с изменениями; двойной клик 4с для удаления команды.

### 6.4 Интерактив и a11y

- [ ] Все контролы 36/40h, focus-visible 2px, клавиатура ↑↓ Enter Escape, диалог trap + возврат фокуса.
- [ ] Скролл тонкий 6px, автопрокрутка feed не сдвигает пользователя если он читает выше.
- [ ] `prefers-reduced-motion` — без translate, только fade; `data-motion off` — сфера статична.

### 6.5 Инструментальная проверка

```
node --test  в apps/jarvis-desktop  (2115+)  и  apps/nox-server (31+)
NOX_DATA_DIR=/tmp/nox-test  npm start  — настоящее Electron-окно 1200 и 864: клавиатура, темы, масштаб, длинный текст, пусто/ошибка/ожидание, импорт с конфликтом, save+reopen
Скрипт типа scripts/nox-qa-verify.js — чаты, отправка, отмена на локальном потоке, прокрутка, resize, копирование, FPS
```

---

## 7. Что не входит

- Генерация команды по описанию из редактора (требует нового IPC) — пока только ссылка «Создать по описанию в чате» если безопасно [П].
- Ручки сферы — preview only, не пишут в `noxOrb` [П].
- Столы, виджеты, аккаунт (платёж) — вне Phase 2.1/2.2 [П].
- Светлая тема, свой фон-картинка — отдельный шаг [П].

---

## 8. Готовность

Документация пригодна для передачи DeepSeek: визуальные решения можно уточнять, сохраняя функциональные границы и токены. Новые функции сферы/генерации не означают готового backend [П].

---

## 9. Артефакты фазы

Все в `docs/reconstruction/phase2/design/`:

1. `design-system.md` — токены, типографика, отступы, состояния.
2. `navigation-layout.md` — каркас, сетки, брейкпоинты, переходы.
3. `commands-ui.md` — каталог, редактор, шаги, выбор, запись, импорт/экспорт.
4. `connections-ui.md` — каталог, статусы 7, популярные, диалоги, разрешения.
5. `settings-ui.md` — нав, ИИ/провайдеры, голос/память, вид, сфера preview, безопасность.
6. `history-agent-ui.md` — журнал, фильтры, детали, ход, подтверждения, ошибки.
7. `components.md` — кнопки/поля/pills/карты/диалоги/сладеры.
8. `motion.md` — easing, длительности, появления, переходы.
9. `implementation-handoff.md` — этот файл: объём, карты, контракты, риски, приёмка.

Если готовятся изображения-макеты — класть рядом как `mock-*.png` (не выдавать за работающий интерфейс).
