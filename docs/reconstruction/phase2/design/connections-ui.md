# Подключения — визуальная спецификация

> Рекламный кадр V2 00:15 [В] — графический образ MCP, не читаемый каталог. Весь экран — проектное решение [П] в каркасе `navigation-layout.md`. Источник данных — `renderer/connections.js` + IPC `mcp:state/add/toggle/remove/approve`.

---

## 1. Лейаут

### 1.1 Эталон 1200×720

```
.nox-workspace  x80 y72 w1092
┌──────────────────────────────────────────────┐ — head h56 pad 20 border-bottom subtle
│ "Подключения" 24/600 + [ + Добавить сервис 40 accent]  │
├──────────────────────────────────────────────┤ y128 toolbar h40 gap12
│ Search 360×40 r8 bg surface-3 border      │  🔍 Поиск сервисов… 13/text-2
│ Filters: [Все] [Подключённые] [Выкл] [Ошибка] │ chips h32 r pill gap 8 — active accent-soft
├──────────────────────┬───────────────────────┤ y180 gap 12
│ List 720px pad 16    │ Popular 360px pad 16│  bg surface r12 border gap12
│ cards gap 12         │ bg surface-1 r12    │
│                      │ head 16/600 "Популярные" │
│                      │ cats [Все/Файлы/Разраб/Прочее] h32 │
│                      │ cards 7 items gap 8 │
└──────────────────────┴───────────────────────┘
```

- Head: title слева, primary CTA справа 160×40 r8 [П].
- Search: слева в toolbar, `w360` фиксировано [П по connections-spec].
- Filters — локально к загруженным записям, не сетевой запрос [П].
- При 864×520: колонки вертикально, популярные под списком; filters — горизонтальный скролл [П].

### 1.2 Карточка сервиса

```
Card  min 100px  pad 16  r12  bg surface  border  gap 12  flex col
┌──────────────────────────────────────────────┐
│ Row 1: Icon 32×32 r8 bg surface-3 border     │
│        Name 14/600 text-1  + State pill h20  │  gap 8
│        Subline target 12/mono text-2 ellipsis│  безопасное отображение: команда + args обрезаны, ключи не показывать
├──────────────────────────────────────────────┤
│ Row 2: Capabilities 12/text-2  «Доступно: readFiles, exec…»  clamp 2 lines │
├──────────────────────────────────────────────┤
│ Row 3: Actions  gap 8  h32                   │
│  [Включить|Выключить] ghost / [Детали] ghost│
│  drift → [Подтвердить изменения] accent 36  │
└──────────────────────────────────────────────┘
```

- Icon: `plug` 16px text-3 в 32px box; для popular — `docs 16 + brand dot` [П].
- State pill: `h20 r pill pad 6 11/500` — цвета см. §2 [П].

---

## 2. Статусы подключений

| Статус (`statusOf`) | Pill | Текст | Действия | Иконка |
|---------------------|------|-------|----------|--------|
| `connected` | `ok 12% bg ok border 42% text ok` | «Подключён» + `N действий` 12/text-2 | [Выключить] [Настроить] [Детали] | `● ok 8px` |
| `connecting` | `accent-soft border accent/24 text accent` pulse | «Подключается» 12/500 | buttons disabled ghost + спиннер 12 | `◍ accent` |
| `disabled` | `surface-3 border text-ghost` | «Выключен» | [Включить] [Удалить] | `○ ghost` |
| `idle` | `surface-3 border text-2` | «Не подключён» | [Включить] [Повторить] | `○ text-2` |
| `legacy` | `warn 14% border 42% text warn` | «Подключится при запуске» | disabled info | `◐ warn` |
| `error` | `err 14% border 42% text err` | Причина 12/400 err + [Повторить] 32 | `mcpToggle(name,false)` | `▲ err 12` |
| `drift` | `warn 14% border 42% text warn` | «Изменения инструментов» + diff chips | **[Подтвердить изменения]** accent 36 disabled others | `⚠ warn` |

- `drift` — перечень `+added −removed ~changed` в details; действия service недоступны до `mcpApprove(name)` [П].
- Сохранённый, но не подключившийся — не считать `connected` [П].
- `mcpApprove` подтверждает набор инструментов; `approval:respond` — решение по конкретному действию: не смешивать [П].

### 2.1 Banner ошибки внутри карточки

```
Error band  min 36px  pad 12  r8  bg err/14 border err/42  flex row gap 8
  Icon alert 14 err
  Message 12/400 err  «ECONNREFUSED 127.0.0.1:3000»
  Spacer flex 1
  [Повторить] 32px h r8 ghost
```

---

## 3. Карточки сервисов (Popular)

### 3.1 Сетка популярных

```
Popular panel  pad 16  r12  bg surface-1  border  gap 12
  Header: "Популярные" 16/600 text-1 — [О] 7 реально имеющихся записей POPULAR из connections.js
  Cats: [Все] [Файлы и память] [Разработка и браузер] [Прочее]  h32 r pill  ghost → active accent-soft  [П]
  List: gap 8  each row h56 pad 12 r8 bg surface border flex row gap 12
    Icon 28×28 r8 bg surface-3 border icon 14 text-3
    Name 13/600 text-1  + Desc 12/400 text-2 ellipsis 1 line
    [Добавить] 28px h r8 ghost → accent on hover
```

- Категории — локальные группы 7 записей, не внешний каталог [П].
- Search по **безопасным** именам и описаниям, не по ключам [П].
- Popular показывает команду и args до подтверждения; запуск загрузки пакетов — **только после согласия** владельца [П].

---

## 4. Диалоги

### 4.1 Добавление сервиса

```
Overlay 0.48  Dialog 560×480 r16 bg surface border shadow-popover
┌──────────────────────────────────────┐ h60 pad 16 border-bottom subtle  Title 16/600 "Добавить сервис"  [×] 20
│ Name*  h40 r8  1–40 симв  placeholder «my-files»              │ gap 16 pad 20
│ Target* h40 r8  адрес или команда  1–400 симв  «npx -y @modelcontextprotocol/server-filesystem» │
│ Args  h40 r8  0–400  «через пробел, напр. /data»              │
│ Hint 12/400 text-2  «Некоторые сервисы загружают пакеты…» icon info 12 │
├──────────────────────────────────────┤ footer h64 pad 16 border-top gap 8 flex-end
│ [Отмена] 36 ghost  [Добавить] 40 accent disabled пока invalid │
└──────────────────────────────────────┘
```

- Вызов `mcpAdd(name,target,args)`; во время ожидания кнопка `Добавить` → спиннер 14 + disabled [П].
- Не подставлять секреты; ошибка — banner err 36h + retry hint [П].

### 4.2 Детали сервиса (клик по карточке)

```
На 1200: Side pane справа 360px внутри .nox-main (не диалог)  [П]
На 864: Dialog 480×520  [П]

Pane  pad 20  gap 16  bg surface  border-left 1px (или r16 на узком)
  Name 16/600 + State pill h20
  Target 12/mono text-2 bg surface-3 pad 8 r8 ellipsis + [Копировать] 20px icon (без секретов)
  Capabilities chips h20 r pill bg surface-3 border text-2 11/500 gap 6
  Permissions explain 13/400 text-2  «Доступ к файлам, выполнение…»
  Toggle [Включён ○—●]  40px wide switch
  Actions: [Удалить] ghost err  +  [Закрыть] 36
```

- Данные не выдумывать: только из `mcpState`; отдельного API настроек прав нет [П].
- Удаление `mcpRemove` — диалог подтверждения `«Удалить “name”? Это действие нельзя отменить.»` + input подтверждения имени 40h + [Удалить] err 40 disabled пока не совпало [П].

---

## 5. Управление разрешениями [П]

- Разрешения показываются как **объяснительный текст**, не toggles на каждое действие: `«Может читать файлы в /data и выполнять команды»` 13/400 text-2 [П].
- Отдельной матрицы прав на действие нет — каждое действие проходит политику `decide`/`hardDeny` и при необходимости `approval:respond` [П].
- Не рисовать OAuth, edit command, отзыв отдельного права как работающие — не подтверждено API [П].
- Опрос состояния каждые 3с при видимом разделе — сохранить [П].

---

## 6. Состояния каталога

| Состояние | Визуал |
|-----------|--------|
| Loading | Спиннер 16 accent + «Загрузка подключений…» 14/text-2 center |
| Empty (list) | Icon plug 24 ghost + «Нет подключений» 16/600 + «Добавьте первый сервис» 14/text-2 + [Добавить] 40 accent |
| No results (search/filter) | «Ничего не найдено» 14/text-2 + [Сбросить] link |
| Error load | Banner err + [Повторить] — текущий `load catch → empty` требует UI-адаптер для различения [П] |
| Drift pending | Warn banner 36h + chips diff + [Подтвердить] accent |

---

## 7. Текстовые схемы

### S1 — Подключения пусто

```
Head: Подключения + Добавить сервис — Toolbar: Search 360 | Filters Все/Подкл/Выкл/Ошибка — List: empty center icon plug ghost 24 + «Нет подключений» — Popular справа: header Популярные + cats Все/Файлы/Разраб/Прочее + 7 rows h56 each «Filesystem  npx …  [Добавить]»
```

### S2 — Карточка drift

```
Card 100px: icon 32 + Name «my-files» + pill warn «Изменения»  — Subline «npx -y @mcp/server-filesystem /data» mono 12/text-2 — Capabilities «readFiles, writeFiles…» — Footer: [Подтвердить изменения] accent 36 disabled others  — Below: diff chips +2 −1 ~3
```

### S3 — Диалог добавления

```
Overlay — Dialog 560×480 — Header Добавить сервис × — Body: Name* [my-files] err hint под полем 12/err если invalid — Target* [npx …] — Args [ /data ] — Hint warn — Footer Отмена Добавить
```

---

## 8. Чек-лист приёмки

- [ ] Header 56, search 360×40, filters chips 32, cards 100min, gap 12, radius 12/16.
- [ ] 7 статусов pills различимы вне цвета (текст + иконка).
- [ ] Drift блокирует действия до подтверждения; Повторить вызывает toggle.
- [ ] Popular cats — локальные 7 записей, search не по ключам.
- [ ] Добавление: 40/400 лимиты, не подставляет секреты, пакет не ставится без согласия.
- [ ] Удаление с подтверждением имени.
- [ ] Адаптив 864: популярные внизу, card не обрезается.
