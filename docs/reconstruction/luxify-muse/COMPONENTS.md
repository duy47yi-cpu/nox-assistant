# Nox — Компоненты (Phase R2)

Компоненты — переиспользуемые, темизируемые, доступные (клавиатура, контраст 4.5:1, reduce-motion).

## 1. Кнопки

| Вариант | Высота | Паддинг | Радиус | Фон | Текст | Бордер | Состояния |
|---|---|---|---|---|---|---|---|
| primary | 32 | 0 12 | 10 | accent | accent-ink (#fff/#0B1018) | — | hover -4% яркости, active scale 0.97, disabled 45% |
| ghost | 32 | 0 12 | 10 | transparent | text-2 | border | hover surface-3, active scale 0.97 |
| icon | 28 | — | 8 | transparent | text-3 | — | hover surface-3, active scale 0.96 |
| pill | 32 | 0 12 | 999 | surface-3 | text-2 | border | hover border-strong, active — text-1 |

Все — `transition: background 120ms, color 120ms, transform 80ms` [В].

## 2. Поля ввода

- **Капсула чата:** surface-3, border 1px, 16px, padding 7/12, focus — border accent + outline 2px bg + 4px accent 30% [В nox-screen.css].
- **Поиск:** 32px, border 1px, 10px, лупа 14px слева, placeholder text-3, focus accent.
- **Текстовое поле:** 36px, border 1px, 8px, padding 0 12, focus accent.

## 3. Панели и карточки

| Компонент | Фон | Бордер | Радиус | Паддинг | Тень |
|---|---|---|---|---|---|
| Панель (рейка/история/чат/сфера) | surface | 1px border | 16 | 12–16 | нет (плоско как Luxify [В]) |
| Карточка настроек/агента | surface | 1px border | 16 | 16 | нет |
| Карточка ответа ИИ | surface-2 72% | 1px border | 4/16/16/16 | 12/14 | нет |
| Пузырь пользователя | surface-3 | 1px border | 16/16/4/16 | 10/14 | нет |
| Модалка | surface | 1px border | 16 | 20 | 0 24px 64px #00000066 |

## 4. Списки

- **История чатов:** строки 36px, 10px, hover 6% белого, активная 9% + inset 1px 7%, gap 2px.
- **Дерево команд:** строки 36px, отступ уровня 16px + направляющая 1px #2A2A2E, иконка 16px, выбрана accent-soft 14%, справа 3 кнопки 28px hover/выбор [В S06].
- **Каталог паков:** карточки 1 в ряд, 96px иконка, 2 кнопки 28px, гап 12px.

## 5. Навигация

- **Рейка:** 52px, иконки 18px, активная accent-soft 14% + лента 4×22 accent слева, бордер 1px, радиус 16 0 0 16, drag на фоне [В].
- **Вкладки:** pills 28px, активная accent-soft + accent текст, неактивная text-2.
- **Чипы фильтров:** 28px pill, border, активная accent.

## 6. Индикаторы статуса

| Статус | Точка | Pill | Где |
|---|---|---|---|
| idle/thinking | 6px accent | — | сфера, агент header |
| waiting_approval | 6px warn | warn-bg + warn-line | агент, лоток |
| success/confirmed | 6px ok | ok-bg | плашки, сфера |
| error/failed | 6px err | err-bg | плашки, сфера |
| unverified | 6px text-3 | нейтральный | плашки |
| pending | 6px text-3 hollow | — | плашки |

Точка — 6px круг, hollow — 6px с бордером 1.5px.

## 7. Сфера (NoxOrb)

Канвас 332px (240 <1000), варианты wire/nox, 8 состояний — см. SPHERE-DESIGN. Контейнер — панель с теми же токенами, что и чат.

## 8. Плашки шагов (центр ленты)

Pill 22px, surface, border 1px, 12/16, иконка 10px, text-2, gap 5px, по центру ленты, `nox-rise` 200ms. Только по `verification` [В].

## 9. Карточка агента

См. SCREEN-SPECS §2 — контейнер 16px, header 36px, action 32px, approval 170ms reveal, done 12/16.

## 10. Поле голоса

Расширение капсулы + плашка wake accent pill 20px + живой текст 12/16 + волна 5×2px 900ms + mic красный err [П] — см. VOICE-UX.

## 11. Диалоги и меню

- **Модалка:** scrim 40%, панель surface 16px, header 14/600, footer с primary/ghost 32px, `dialogRise` 240ms.
- **Контекстное меню:** 180px, 32px пункт, hover surface-3, `menuIn` 67ms.
- **Тост:** 32px, surface-3, 12/16, `toastIn` 180ms, 3s.

## 12. Скелетоны и пустые

- Скелетон: surface-2, 8px, shimmer 1200ms linear.
- Пусто: точки-иллюстрация + текст 13/16 text-2.

Все компоненты — CSS-переменные темы, без хардкода hex (кроме scrim).
