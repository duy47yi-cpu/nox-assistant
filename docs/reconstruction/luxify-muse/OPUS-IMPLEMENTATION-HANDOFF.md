# OPUS — ТЗ на реализацию (handoff от Muse к Opus 5.5)

> Что Muse спроектировал, что Opus реализует. Не менять до утверждения владельцем макетов `previews/` — см. DEFINITION OF DONE.

## 1. Что подтверждено и можно реализовывать (зелёный свет, F-слой)

| # | Решение | Откуда | Файлы для правки | Тесты |
|---|---|---|---|---|
| 1 | Семантические токены Nox: алиасы `--nox-*` → `var(--bg/--surface/--text/--accent)` | THEMES.md §2 [П] + `nox-screen.css` изолирован [В] | `renderer/nox-screen.css` (заменить хардкоды на алиасы) + `renderer/theme-boot.js` (сфера слушает `jarvis:accent`) | `themes.test.js` + `nox-shot.js` 1200/864 |
| 2 | Сфера берёт акцент: `getComputedStyle(--accent)` → `NoxOrb.pal()` | THEMES.md §4 [П] | `renderer/orb-nox.js` (подписка на `jarvis:accent`) | `nox-qa-verify.js` |
| 3 | Плашки шагов в ленте: `✓ Выполнено` только по `verified=true`, иначе `○ Не проверено` | SCREEN-SPECS §2 [П] + `checkEffect` [В] | `renderer/app.js` / `renderer/nox-screen.js` (рендер плашек из `turn-acts`) | `project-map.test.js` |
| 4 | Карточка агента: шаг k/N, цель, Стоп, approval 170ms, done | SCREEN-SPECS §2 [П] + `agent:event` уже есть [В] | `renderer/nox-screen.js` (карточка) + `renderer/nox-screen.css` | `nox-qa-verify.js` |
| 5 | Плотность строк дерева 36px + направляющие + 3 кнопки hover | SCREEN-SPECS §4 [П] + S06 [В] | `renderer/nox-commands.css` | `nox-commands-shot.js` |
| 6 | Сброс раздела ↻ с confirm | SCREEN-SPECS §6 [В] S20 | `renderer/nox-settings.js` | `nox-settings` baseline |
| 7 | Контраст accent ≥4.5:1 — уже есть `readable()` [В] — проверить для Nox-алиасов | THEMES.md §6 | — (только тест) | `themes.test.js` |

Все — F (только интерфейс), часы работы, низкий риск [В].

## 2. Что требует согласования с владельцем (жёлтый свет)

| # | Решение | Вопрос | Что показать владельцу | Блокирует ли реализацию? |
|---|---|---|---|---|
| 8 | Сфера anchored vs contained | OPEN-QUESTIONS §1 | `previews/01-main.png` contained vs макет anchored (показать сдвиг 64px) | Нет — дефолт contained, anchored — флаг `data-sphere` |
| 9 | Светлая тема: панели #FFFDF9 на #F4F1EB, сфера ярче | §12 | `previews/06-light.png` — контраст сферы на светлом | Нет — можно релизить dark, light — вторым |
| 10 | Вкладки столов на Главной | §3 | Мокап с вкладками над чатом vs без | Да — влияет на `desks.js` |
| 11 | Прозрачность по умолчанию | §11 | 0% vs 8% — скрин на обоях | Нет — ручка уже есть |
| 12 | Кольцо шагов вокруг сферы | §14 | С кольцом vs без | Нет — можно скрыть флагом |
| 13 | Цена в чате | §15 | С «Использовано ≈…» vs без | Нет — `cost/meter.js` уже есть |
| 14 | Минимальный размер окна | §16 | 864×520 vs 1000×680 | Нет |

## 3. Что предполагает изменение backend (красный свет, B-слой)

| # | Решение | Почему B | Что менять | Риск |
|---|---|---|---|---|
| 15 | Аватар на рабочем столе 280×280 + 3×3 + автоскрытие | Новое окно Electron, `setIgnoreMouseEvents`, FPS лимит, отслеживание полноэкранного | `main.js` `openMini` → `desktopOverlay`, `src/screen/` | Высокий — perf, фокус игр |
| 16 | Сфера на звук системы/микрофона | Нужен захват PCM, `AGC`, `capture.js` | `src/voice/capture.js`, `src/voice/agc.js` (уже есть но не вызывается [В]) | Средний — приватность |
| 17 | «Сохранить ход как команду» | Перевод `agent:event` → `commands/store.js` шаги | `src/skills/experience.js` + `src/commands/builder.js` | Средний |
| 18 | Голосовой стол «Открой стол Игры» | Новая короткая фраза offline | `src/shortcuts/offline.js` + `desks:*` | Низкий |
| 19 | Телеметрия стола/шага (опционально) | — | — | — |

B-задачи — отдельные ветки после F, каждая с `node --test` и проверкой окном [В] AGENTS.md.

## 4. Последовательность внедрения (из IMPLEMENTATION-RISKS §4)

**Этап 1 — F (часы):** #1→#2→#3→#4→#5→#6→#7 — каждый с `node --test` + `nox-shot.js` 1200×720.  
**Этап 2 — S (дни):** #8→#12 после утверждения макетов — контекстное меню, вкладки столов, голосовая строка (если interim доступен).  
**Этап 3 — B (неделя+):** #15→#19 — отдельными задачами.

## 5. Что нельзя делать

- Ослаблять `decide`/`hardDeny`/`approvals` ради красоты — только вид [В] (риск высокий).
- Показывать «выполнено» по словам модели — только `verify` [В].
- Показывать имя модели/провайдера — только «Быстрая/Умная» [В] AGENTS.md.
- Копировать бренд/кольца/голоса Luxify [В].
- Коммитить без просьбы владельца [В] AGENTS.md.

## 6. Артефакты для Opus

- `DESIGN-DIRECTION.md` — валидация + направление
- `DESIGN-SYSTEM.md` — токены
- `SCREEN-SPECS.md` — экраны 1200×720
- `SPHERE-DESIGN.md` — 8 состояний + переходы
- `MOTION-TIMELINES.md` — таймлайны
- `VOICE-UX.md` — голос
- `THEMES.md` — темы (dark/light примеры)
- `COMPONENTS.md` — компоненты
- `INTERACTIONS.md` — 18 взаимодействий
- `previews/01..06.png` — макеты 1200×720
- `storyboards/sphere-states.png` — раскадровка сферы
- `OPEN-QUESTIONS.md` — 19 вопросов

## 7. Критерий готовности к коду

Макеты утверждены владельцем + алиасы Nox→semantic (THEMES.md §2) проверены `themes.test.js` — тогда Opus может править `nox-screen.css`/`orb-nox.js`.

## 8. Контакты

Владелец утверждает макеты в этом каталоге до реализации — см. STRICT RULES: не менять `renderer/`, `main.js`, `preload.js`, `app.js`, `package.json`.
