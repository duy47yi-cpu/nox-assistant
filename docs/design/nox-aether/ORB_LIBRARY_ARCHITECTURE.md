# Архитектура Orb Library — NOX AETHER (Step 2)

> Статус: проектный документ (Gate 1). Ни один из существующих файлов движков сфер в `apps/jarvis-desktop/renderer/` не изменён.

---

## 1. Установленное соответствие двух систем сфер (по коду и референсам)

Проверка реального кода и референсных изображений выявила **две независимые системы отрисовки сфер** (`window.NoxOrb` и `window.JarvisOrb`), которые работают с разными HTML5 Canvas, разными хранилищами и разным набором форм:

| Система (файл и глобальный API) | Реальные варианты (`id` и подпись в коде) | Как выглядит и чем отличается | Хранилище | Соответствие референсам |
|---|---|---|---|---|
| **Система 1: `NoxOrb`**<br>`apps/jarvis-desktop/renderer/orb-nox.js`<br>+ `apps/jarvis-desktop/renderer/orb-shutter.js` | `'nox'` *(«Точечная сфера» / матрица точек)* | 1400 точек оболочки по спирали Фибоначчи (`NOX_SHELL = 1400`) + 200 точек ядра (`NOX_CORE = 200`) + радиальное свечение ядра. Голубовато-бирюзовая палитра `#4DBCE8` / `#1A3D4F`. Реагирует на `state`, `voice`, `scale`, `animated`, **не** читает `--hue` / `JarvisOrbTune`. | `localStorage['noxOrb']` *(превью-ползунки размера/свечения в `nox-settings.js` — `jarvis.spherePreview`)* | Совпадает с `package/assets/02_previous_nox.png` (прежний Nox с плотной голубой сферой из точек и «С чего начнём?») |
| **Система 1: `NoxOrb`** *(форма 2)* | `'wire'` *(«Проволочная сфера» / сетка)* | Проволочная сфера: 112 меридианов × 54 параллели (`WIRE_MERIDIANS = 112`, `WIRE_PARALLELS = 54`) + деформированный светлый экваториальный пояс (`WIRE_BELT_LAT = -0.19`). Цвет в коде фиксированный голубой `#4DBCE8` / `#E0F4FF`. | То же (`noxOrb`) | Прежняя разработка «синей проволочной» версии экрана Nox |
| **Система 1: `NoxOrb`** *(добавка из C5/C6/C7)* | `'shutter'` *(«Затвор»)* (`orb-shutter.js`) | 9-лепестковый диафрагменный затвор с оранжевым `#FF6A3D` акцентом. Добавлен параллельной веткой в текущем рабочем дереве (`nox-signature.css`, `orb-shutter.js`). | То же (`noxOrb`, дефолт в `nox-screen.js:575`) | Совпадает с `package/assets/01_current_nox.png` (текущий Nox, внешний вид которого владелец хочет заменить). **В библиотеке Aether не ставится по умолчанию, но код `orb-shutter.js` остаётся нетронутым.** |
| **Система 2: `JarvisOrb`**<br>`apps/jarvis-desktop/renderer/orb.js`<br>+ `orb-variants.js`<br>+ `orb-tune.js` | `'sphere'` *(в `orb-tune.js`: `'Точечная сфера'`)* | 90–700 крупных 3D-спрайтовых точек по спирали Фибоначчи (`n = Math.round(Math.max(90, Math.min(700, (size * size) / 75)) * tune.density)`) + орбитальное кольцо и маркеры шагов `_ring` / `_beads`. Читает CSS-переменные темы (`--hue`, `--warn`, `--err`, `--ok`, `--bg`, `--text-2`, `--orb-*`) и все ручки `JarvisOrbTune`. | `localStorage['jarvis.orbVariant']` + `localStorage['jarvis.orbTune']` | Отдельная сфера классического экрана (`renderer/index.html` → `[data-view="dialog"]`) |
| **Система 2: `JarvisOrb`** *(форма 2)* | `'core'` *(в `orb-tune.js`: `'Ядро'`)* | Светящееся многослойное ядро (`orb-variants.js`). Поддерживает все состояния, голос, жесты и `glow/speed/motion/depth`. | То же (`jarvis.orbVariant` / `jarvis.orbTune`) | Дефолтная форма классического экрана Джарвиса |
| **Система 2: `JarvisOrb`** *(форма 3)* | `'iris'` *(в `orb-tune.js`: `'Диафрагма'`)* | Тонкие вращающиеся концентрические кольца/дуги в палитре текущей темы (`orb-variants.js`). Поддерживает `glow/speed/motion/depth`. | То же (`jarvis.orbVariant` / `jarvis.orbTune`) | Вариант 3 классического экрана |

### Почему сохраняются ОБЕ системы целиком без слияния и переписывания

1. Названия в проекте пересекаются: в системе `JarvisOrb` форма `'sphere'` буквально называется **«Точечная сфера»**, а в системе `NoxOrb` точечной сферой является вариант **`'nox'`** (голубая плотная сфера 1400+200 точек на `02_previous_nox.png`), рядом с проволочной `'wire'`.
2. У систем разные движки и физика анимации: `NoxOrb` — высокая плотность точечной оболочки / проволочная сетка, а `JarvisOrb` — спрайтовая точечная сфера с шаговыми бусинами (`setSteps`), «Ядро» и «Диафрагма» с полным набором `JarvisOrbTune` и адаптацией к `--hue`.
3. **Решение:** обе системы (`orb.js` + `orb-variants.js` + `orb-tune.js` и `orb-nox.js` + `orb-shutter.js`) сохраняются **без единого визуального или математического изменения** и подключаются в Aether через единый слой адаптеров `Orb Library`.

---

## 2. Архитектура `Orb Library`

Новая оболочка `renderer/aether/` работает со сферой только через модульный реестр `OrbLibrary`, состоящий из четырёх частей:

```text
  [ UI: StageOrb / OrbLibrarySheet / AppearanceDrawer ]
                          │
                          ▼
               ┌─────────────────────┐
               │    OrbLibraryHost    │  жизненный цикл активного canvas,
               │  (единый контроллер) │  ResizeObserver, reduced-motion, state/voice
               └──────────┬──────────┘
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
  ┌───────────────────┐       ┌─────────────────────┐
  │    OrbRegistry    │       │   OrbSettingsStore   │
  │ встроенные +      │       │ параметры каждой     │
  │ будущие движки и  │       │ сферы отдельно,     │
  │ пользовательские  │       │ дефолты и пресеты   │
  └─────────┬─────────┘       └─────────────────────┘
            │
     ┌──────┼──────────────────┬───────────────────┐
     ▼      ▼                  ▼                   ▼
NoxAdapter JarvisAdapter   Shader/WebGL       CustomUserOrb
(nox,wire, (sphere,core,   Adapter (будущ.)   Adapter (svg/lottie/
 shutter)   iris)                             procedural / plugin)
```

### 2.1. Реестр сфер (`OrbRegistry`)

Каждая сфера в библиотеке описывается дескриптором `OrbDescriptor`:

```js
/**
 * @typedef {Object} OrbParamSpec
 * @property {string} key         - внутренний ключ ('scale' | 'glow' | 'speed' | 'motion' | 'depth' | 'density' | 'voiceGain' | ...)
 * @property {string} label       - человекопонятная подпись в интерфейсе
 * @property {'range'|'toggle'|'color'|'select'} kind
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {unknown} defaultValue
 * @property {string} [unit]      - '%', '×', ''
 */

/**
 * @typedef {Object} OrbDescriptor
 * @property {string} id                - стабильный ключ ('nox:nox', 'nox:wire', 'jarvis:sphere', 'jarvis:core', 'jarvis:iris', 'nox:shutter', 'user:<uuid>')
 * @property {string} engineId          - движок ('nox-orb' | 'jarvis-orb' | 'custom-*')
 * @property {string} variantId         - вариант внутри движка ('nox', 'wire', 'sphere', 'core', 'iris', ...)
 * @property {string} name              - название для владельца
 * @property {string} family            - семейство в каталоге ('Точечная' | 'Световая' | 'Контурная' | 'Мои сферы')
 * @property {string} summary           - короткое описание визуального характера
 * @property {'builtin'|'user'} origin  - источник
 * @property {boolean} visibleInCatalog - показывать ли по умолчанию (для 'nox:shutter' можно отметить как совместимость/дополнительно)
 * @property {{
 *   themeAccent: boolean,              // true только для JarvisOrb или будущих движков с поддержкой --hue
 *   voiceReactive: boolean,
 *   taskSteps: boolean,                // поддержка _beads / setSteps (JarvisOrb)
 *   composerFocus: boolean,            // attentive при фокусе на поле ввода
 *   reducedMotion: boolean,
 * }} capabilities
 * @property {OrbParamSpec[]} params    - схема настроек именно этой сферы
 * @property {Array<{id: string, name: string, values: Record<string, unknown>}>} builtinPresets
 * @property {(canvas: HTMLCanvasElement, init: OrbMountContext) => OrbEngineAdapter} createAdapter
 */
```

#### Каталог встроенных записей при первом запуске

| `id` | `engineId` | `variantId` | Название в каталоге | Семейство | Поддерживаемые параметры (`params`) | Поддержка акцента темы |
|---|---|---|---|---|---|---|
| `nox:nox` | `nox-orb` | `nox` | **Nox Точечная** | Точечная | `scale` (0.70–1.25), `animated` | Нет (оригинальная бирюзовая палитра `#4DBCE8`) |
| `nox:wire` | `nox-orb` | `wire` | **Nox Контур (Проволока)** | Контурная | `scale` (0.70–1.25), `animated` | Нет (оригинальный голубой контур `#4DBCE8` + пояс) |
| `jarvis:sphere` | `jarvis-orb` | `sphere` | **Jarvis Точечная** | Точечная | `scale`, `glow`, `speed`, `motion`, `depth`, `density`, `voice`, `voiceGain` | **Да** (`--hue` темы/акцента) |
| `jarvis:core` | `jarvis-orb` | `core` | **Jarvis Ядро** | Световая | `scale`, `glow`, `speed`, `motion`, `depth`, `voice`, `voiceGain` | **Да** (`--hue` темы/акцента) |
| `jarvis:iris` | `jarvis-orb` | `iris` | **Jarvis Диафрагма** | Контурная | `scale`, `glow`, `speed`, `motion`, `depth`, `voice`, `voiceGain` | **Да** (`--hue` темы/акцента) |
| `nox:shutter` | `nox-orb` | `shutter` | **Затвор (текущий стиль)** | Механическая | `scale`, `animated` | Нет (оранжевый `#FF6A3D`) |

> Примечание: разделение на `nox:nox` («Nox Точечная») и `jarvis:sphere` («Jarvis Точечная») с явным указанием характеристик («1400 точек · оригинальный голубой свет» vs «Спрайтовые точки · цвет темы и маркеры шагов») исключает путаницу и позволяет владельцу в один клик сравнить обе прямо на живом холсте.

### 2.2. Единый адаптер движка (`OrbEngineAdapter`)

Оба существующих движка не переписываются; каждый оборачивается в тонкий адаптер (~50–70 строк):

1. **`NoxOrbAdapter`** (вызывает `new window.NoxOrb(canvas, { variant, state, animated, scale, dpr })`):
   - `setState(s)` → маппинг единых состояний Aether (`idle`, `attentive`, `listening`, `thinking`, `speaking`, `waiting_approval`, `error`, `success`) в словарь `NoxOrb`.
   - `setVoice(v)` → `instance.setVoice(v)`.
   - `setAnimated(on)` → `instance.setAnimated(on)` (выставляя `window.NoxOrb.ignoreSystemMotion = true` при явном выборе владельца в Aether).
   - `applyParams(p)` → `instance.setScale(p.scale)` *(учитывает также размер сферы из внешнего вида, не искажая внутреннюю геометрию)*.
   - `resize()` → `instance.resize()`.
   - `destroy()` → `instance.destroy()` (останавливает `requestAnimationFrame` и очищает canvas).
2. **`JarvisOrbAdapter`** (вызывает `new window.JarvisOrb(canvas, { variant, density })`):
   - `setState(s)` → `instance.setState(s)`.
   - `setVoice(v)` → `instance.setVoice(v)`.
   - `setAnimated(on)` → `instance.setAnimated(on)`.
   - `applyParams(p)` → `instance.setTune({ glow, speed, motion, depth, density, voice, voiceGain })`; масштаб `p.scale` задаёт CSS-размер/viewbox контейнера холста + при мелких превью библиотеки (`preview: true`) адаптер может временно передавать `density: Math.max(p.density, 1.55)` только для мини-карточки каталога, **не меняя** сохранённые настройки основной сферы *(исправляет проблему разреженных точек на 76 px мини-карточке, отмеченную в `FABLE_PROGRESS.md`)*.
   - `setSteps(steps)` / `setComposer(...)` / `gesture(...)` / `pulse(k)` → пробрасываются напрямую.
   - `onThemeChange()` → вызывает `instance.setState(currentState)` / `resize()`, чтобы `JarvisOrb` перечитал обновлённый `--hue`.
   - `destroy()` → `instance.destroy()`.

### 2.3. Хранение настроек, пресетов и переключение без потерь (`OrbSettingsStore`)

В текущих прототипах (и частично в старом коде) параметры не разделялись на индивидуальные слоты для каждой сферы. В архитектуре `OrbSettingsStore` (ключ `localStorage['nox.orbLibrary.v1']`):

```json
{
  "version": 1,
  "activeOrbId": "nox:nox",
  "perOrb": {
    "nox:nox": { "scale": 1.0, "animated": true },
    "nox:wire": { "scale": 1.0, "animated": true },
    "jarvis:sphere": { "scale": 1.0, "glow": 1.15, "speed": 1.0, "motion": 1.0, "depth": 1.0, "density": 1.25, "voice": true, "voiceGain": 1.0 },
    "jarvis:core": { "scale": 1.0, "glow": 1.0, "speed": 1.0, "motion": 1.0, "depth": 1.0, "voice": true, "voiceGain": 1.0 }
  },
  "presets": [
    {
      "id": "preset-quiet-night",
      "name": "Тихая ночь",
      "orbId": "jarvis:core",
      "values": { "scale": 0.95, "glow": 0.7, "speed": 0.75, "motion": 0.8, "depth": 1.1, "voice": true, "voiceGain": 0.9 }
    }
  ],
  "userOrbs": []
}
```

**Ключевые гарантии при переключении:**
1. **`perOrb[orbId]` изолирован для каждого `orbId`:** если владелец настроил `jarvis:sphere` (`density: 1.4`, `glow: 1.3`), затем переключился на `nox:wire` (`scale: 0.9`), а потом вернулся к `jarvis:sphere`, все параметры `jarvis:sphere` восстанавливаются без сброса и без утечки настроек между сферами.
2. **Сброс по умолчанию точечный:** кнопка «По умолчанию» сбрасывает параметры только текущей `activeOrbId` из `descriptor.params[].defaultValue`, не трогая остальные сферы и пользовательские пресеты.
3. **Пресеты:** сохраняют связку `{ orbId, values, themeHint? }`. Применение пресета переключает сферу и загружает снимок параметров в `perOrb[orbId]`, предварительно проверяя границы через `sanitizeParams(descriptor, values)`.
4. **Безопасная миграция со старых ключей (только чтение при инициализации):** если `'nox.orbLibrary.v1'` отсутствует, при первом запуске адаптер считывает текущие `localStorage['noxOrb']`, `localStorage['jarvis.orbVariant']`, `localStorage['jarvis.orbTune']` (не удаляя их для возможности отката на старый UI) и аккуратно инициализирует `perOrb` и `activeOrbId`.

### 2.4. Подключение будущих движков и пользовательских сфер

Расширяемость заложена двумя механизмами (без правки ядра интерфейса):

1. **`OrbRegistry.registerEngine(engineDescriptor)`:** позволяет подключить новый движок рендеринга (например, WebGL2/Three.js, GLSL-шейдер, WASM-частицы или Canvas 2D), реализующий тот же интерфейс `OrbEngineAdapter`. Интерфейс автоматически строит для него элементы управления по массиву `params`.
2. **`OrbRegistry.registerUserOrb(customSpec)` (будущие пользовательские сферы):**
   - Сохранение пользовательских пресетов и конфигов как отдельных карточек в семействе **«Мои сферы»** (`origin: 'user'`).
   - Поддержка подключаемых локальных пакетов сферы (в будущем Gate 3+: безопасный локальный ассет/параметрический конфиг, прошедший проверку формата без `eval`/произвольного JS при CSP `script-src 'self'`).
   - Карточка пользовательской сферы может дублироваться, переименовываться, удаляться (кроме встроенных) и экспортироваться.
