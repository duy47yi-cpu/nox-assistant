'use strict';

// Скриншот настоящего окна Nox. Запускается отдельным процессом Electron с временным
// профилем и временными данными: настройки, разговор и рабочая папка владельца не читаются.
//
// Из папки apps/jarvis-desktop (ELECTRON_RUN_AS_NODE должен быть снят):
//   electron scripts/nox-shot.js --out <png> [--width 1200] [--height 720]
//     [--state full|empty] [--orb wire|nox] [--wait 2500] [--dump-geometry <json>]
//
// --state full   — временный data/conversation.json в формате ChatBook ({activeId, chats}),
//                  содержимое похоже на кадр muse/01-chat-full.png.
// --state empty  — файла разговора нет: свежий чат, состояние «С чего начнём?».
// --orb          — вид шара: window.NoxScreen.setVariant(name) (или window.NoxOrbScreen),
//                  если API ещё нет — пишем localStorage 'noxOrb' и не падаем.
// Печатает одну строку NOX_SHOT_RESULT <json> и выходит: 0 — снимок сохранён, 1 — ошибка.
// По умолчанию файл: docs/reconstruction/screenshots/nox-<W>x<H>-<state>-<orb>.png

const fs = require('fs');
const os = require('os');
const path = require('path');

let electron = null;
try {
  electron = require('electron');
} catch {
  electron = null;
}
if (!electron || typeof electron !== 'object' || !electron.app || typeof electron.app.whenReady !== 'function') {
  console.error('nox-shot: нужен запуск через electron.exe, а не node: снимите ELECTRON_RUN_AS_NODE');
  process.exit(1);
}
const { app, globalShortcut } = electron;

const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'docs', 'reconstruction', 'screenshots');
const TIMEOUT_MS = 30000;

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}
function has(name) {
  return process.argv.includes(`--${name}`);
}
function bad(message) {
  console.error(`nox-shot: ${message}`);
  process.exit(2);
}

const width = Number.parseInt(arg('width', '1200'), 10) || 1200;
const height = Number.parseInt(arg('height', '720'), 10) || 720;
if (width < 420 || height < 480) bad('окно меньше минимального 420x480');
const rawState = String(arg('state', 'full')).toLowerCase();
if (rawState !== 'full' && rawState !== 'empty') bad(`--state: full|empty, получено «${arg('state')}»`);
const state = rawState;
const rawOrb = String(arg('orb', 'wire')).toLowerCase();
if (rawOrb !== 'wire' && rawOrb !== 'nox') bad(`--orb: wire|nox, получено «${arg('orb')}»`);
const orb = rawOrb;
const waitMs = Math.min(20000, Math.max(0, Number.parseInt(arg('wait', '2500'), 10) || 2500));
const outArg = arg('out', '');
const outPath = path.resolve(outArg || path.join(SHOTS_DIR, `nox-${width}x${height}-${state}-${orb}.png`));
const dumpArg = arg('dump-geometry', '');
const dumpPath = dumpArg ? path.resolve(dumpArg) : '';
const keepTemp = has('keep-temp');
const keepBanner = has('keep-banner');
const keepFocus = has('keep-focus');

// ── Временный профиль и данные ────────────────────────────────────
// Прошлые запуски на Windows не всегда успевают удалить профиль Chromium до выхода
// процесса: подчищаем их при следующем старте, свежие и чужие не трогаем.
function sweepOldTemp() {
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true }); } catch { return; }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^nox-shot-/i.test(entry.name)) continue;
    const full = path.join(os.tmpdir(), entry.name);
    try {
      if (now - fs.statSync(full).mtimeMs < 60000) continue; // возможно, идёт прямо сейчас
      fs.rmSync(full, { recursive: true, force: true });
    } catch { /* занят другим запуском — оставляем */ }
  }
}
sweepOldTemp();

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-shot-'));
const profileDir = path.join(tempRoot, 'profile');
const dataDir = path.join(tempRoot, 'data');
const workspaceDir = path.join(tempRoot, 'workspace');
for (const dir of [profileDir, dataDir, workspaceDir]) fs.mkdirSync(dir, { recursive: true });

// Настройки без голоса и фоновых запусков модели: первый запуск не должен ничего спрашивать.
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  voice: false,
  backgroundModelRuns: false,
  alwaysListen: false,
  dictation: false,
  desktopOverlay: false,
  alwaysOnTop: false,
  motion: true,
  seededBrief: true,
}), 'utf8');

// Разговор для полного состояния. Структура повторяет кадр muse/01-chat-full.png:
// активный разговор — «сегодня», остальные — «ранее» (chat:list отдаёт updatedAt).
// Заголовок строки истории строится из первого сообщения пользователя (src/chats/book.js: titleOf).
function fullConversation() {
  const user = (content) => ({ role: 'user', content });
  const assistant = (content) => ({ role: 'assistant', content });
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const later = (days) => now - days * day;
  return {
    activeId: 'shot-active',
    chats: [
      {
        id: 'shot-active',
        updatedAt: now,
        history: [
          user('Джарвис, сейчас я буду работать над дизайном, не мешай'),
          assistant('Понял, Сер. Работаю тихо.'),
          // Ещё пара реплик до длинного ответа: лента должна переполниться, чтобы
          // прокрутка вниз показывала хвост ответа, а не начало разговора.
          user('Джарвис, включи тихий режим и не показывай уведомления'),
          assistant('Хорошо, Сер. Уведомления выключены, голос молчит.'),
          user('И не переключай окна, я работаю'),
          assistant('Понял, остаюсь в фоне.'),
          user('Проанализируй, пожалуйста, картинки из папки «Изображения». Что там нового?'),
          assistant('Хорошо, Сер. Открыл папку «Изображения» и посмотрел, что в ней изменилось с прошлого раза.\n\nТам появился один новый снимок — судя по времени, его сохранили пару минут назад. Остальные файлы на месте, ничего не пропало.\n\nСер, синяя машина на увеличенном картинке слева — **Lamborghini Temerario**.'),
          user('что это за модель'),
          assistant('Сер, на увеличенном изображении слева — стилизованный **Lamborghini Revuelto** в чёрно-золотом цвете. Судя по необычному обвесу, это, вероятно, рендер.'),
        ],
      },
      { id: 'shot-plans', updatedAt: later(2), history: [user('Джарвис, покажи мои планы на сегодня'), assistant('Сегодня в планах: разбор почты и подготовка отчёта.')] },
      { id: 'shot-reminder', updatedAt: later(3), history: [user('Создай напоминание через час размяться'), assistant('Напоминание на 60 минут вперёд создано.')] },
      { id: 'shot-text', updatedAt: later(4), history: [user('Только текст в чате: проверка режима'), assistant('Хорошо, отвечаю только текстом.')] },
      { id: 'shot-short', updatedAt: later(5), history: [user('Одним коротким предложением опиши проект'), assistant('Nox — настольный помощник, который делает задачи на компьютере и отчитывается проверкой результата.')] },
      { id: 'shot-diploma', updatedAt: later(6), history: [user('Джарвис, напиши дипломную работу'), assistant('Соберу структуру и список источников.')] },
      { id: 'shot-table', updatedAt: later(7), history: [user('выведи таблицу качки по дням'), assistant('Собрал таблицу тренировок по дням недели.')] },
      { id: 'shot-design', updatedAt: later(8), history: [user('дизайнес, помоги с макетом'), assistant('Открыл макет и набросал сетку экрана.')] },
      { id: 'shot-sound', updatedAt: later(8), history: [user('Лимонт, что по звуку?'), assistant('Звук слышно, микрофон работает.')] },
    ],
  };
}

if (state === 'full') {
  fs.writeFileSync(path.join(dataDir, 'conversation.json'), JSON.stringify(fullConversation(), null, 2), 'utf8');
}

// Сессия, кэш и Chromium — во временном профиле, а не у владельца.
app.setPath('userData', profileDir);

// Пиксели 1:1 с CSS: сравнение с референсом не должно зависеть от масштаба экрана.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
// Скрытое/перекрытое окно не должно замирать: capturePage берёт кадр из отрисовки страницы.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Настройки владельца из окружения не используем.
for (const key of Object.keys(process.env)) {
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
}

// Корень данных — временная папка (та же подмена, что в scripts/check-app-startup.js).
require('../src/config/paths').projectRoot = () => tempRoot;

// Глобальные горячие клавиши в проверке не нужны и не должны занимать клавиши владельца.
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};

let finished = false;
let mainWin = null;
const consoleErrors = [];
const startedAt = Date.now();

function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  const payload = { ...result, elapsedMs: Date.now() - startedAt };
  if (keepTemp) payload.tempRoot = tempRoot;
  console.log(`NOX_SHOT_RESULT ${JSON.stringify(payload)}`);
  app.exit(result && result.ok ? 0 : 1);
}

process.on('exit', () => {
  if (keepTemp) {
    console.error(`NOX_SHOT_TEMP ${tempRoot}`);
    return;
  }
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  catch { console.error(`NOX_SHOT_TEMP_REMAINS ${tempRoot}`); }
});
process.on('uncaughtException', (err) => {
  finish({ ok: false, error: `uncaught: ${err && err.message ? err.message : err}` });
});

const deadline = setTimeout(() => {
  finish({
    ok: false,
    error: `timeout: за ${TIMEOUT_MS} мс окно не было снято (окно ${mainWin ? 'найдено' : 'не найдено'})`,
  });
}, TIMEOUT_MS);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(win) {
  // Шрифты и два кадра отрисовки: после этого текст не перескакивает.
  const page = await win.webContents.executeJavaScript(`(async () => {
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));
    return { innerWidth, innerHeight, dpr: window.devicePixelRatio || 1, title: document.title };
  })()`).catch(() => ({}));

  // Окружение временного профиля, а не экран: в свежем профиле нет ключа модели,
  // поэтому приложение показывает баннер «не подключён — отвечает заглушкой» и сдвигает
  // панели вниз. В рабочей сборке с ключом баннера нет; для снимка убираем его.
  // Заодно снимаем фокус с поля ввода: кадр без случайного focus-ring.
  const cleaned = await win.webContents.executeJavaScript(`(() => {
    const out = { banner: false, blurred: false };
    if (!${keepBanner}) {
      const wrap = document.getElementById('bannerWrap');
      if (wrap && !wrap.hidden) { wrap.hidden = true; out.banner = true; }
    }
    if (!${keepFocus} && document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
      out.blurred = true;
    }
    return out;
  })()`).catch(() => ({}));
  if (cleaned && (cleaned.banner || cleaned.blurred)) await sleep(350);

  // Вид шара. API может появиться позже загрузки — ждём до 2 с; без API просто пишем localStorage.
  const variant = await win.webContents.executeJavaScript(`(async () => {
    const name = ${JSON.stringify(orb)};
    for (let i = 0; i < 20; i += 1) {
      const api = window.NoxScreen || window.NoxOrbScreen || null;
      if (api && typeof api.setVariant === 'function') {
        try { api.setVariant(name); return { applied: 'api', name }; }
        catch (e) { return { applied: 'api-error', name, error: String(e && e.message || e) }; }
      }
      try { localStorage.setItem('noxOrb', name); } catch (e) {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { applied: 'localStorage', name };
  })()`).catch((err) => ({ applied: 'error', name: orb, error: err.message }));

  // Ждём шар, шрифты и переход варианта.
  await sleep(waitMs);
  return { page, variant, cleaned };
}

async function readGeometry(win) {
  const geometry = await win.webContents.executeJavaScript(`(() => {
    const out = { inner: [innerWidth, innerHeight], dpr: window.devicePixelRatio || 1, elements: {} };
    const selectors = [
      '.app', '.rail', '.history', '.chat', '.sphere', '.convo', '.stage', '.composer',
      '#stage', '#orbWrap', '#orb', '#feed', '#chatTabs', '#chatInput', '#chatEmpty',
      '.orb-wrap', '.scene', '[data-nox-panel]', '[data-panel]', '[data-screen]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      out.elements[sel] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }
    if (window.NoxScreen && typeof window.NoxScreen.geometry === 'function') {
      try { out.noxScreen = window.NoxScreen.geometry(); } catch (e) { out.noxScreenError = String(e && e.message || e); }
    }
    return out;
  })()`).catch(() => null);
  if (geometry && dumpPath) {
    fs.mkdirSync(path.dirname(dumpPath), { recursive: true });
    fs.writeFileSync(dumpPath, JSON.stringify(geometry, null, 2), 'utf8');
  }
  return geometry;
}

async function capture(win) {
  // Окно создано скрытым или сразу показанным — показываем его без захвата фокуса,
  // чтобы не мешать живому отладочному окну. content — то, что вернёт capturePage.
  try { win.showInactive(); } catch { try { win.show(); } catch { /* окно уже видимо */ } }
  // Эталонный размер 1200x720, но для сверки с кадром 865x520 нужен 864x520:
  // у окна minWidth/minHeight 960x640, временно снимаем нижнюю границу.
  try { win.setMinimumSize(200, 200); } catch { /* старые версии Electron */ }
  win.setContentSize(width, height);
  // setContentSize может сработать не мгновенно (минимальные размеры, DPI).
  for (let i = 0; i < 40; i += 1) {
    const [w, h] = win.getContentSize();
    if (w === width && h === height) break;
    await sleep(50);
  }

  const { page, variant, cleaned } = await settle(win);
  // Лента прокручена вниз: видимая верхушка — хвост последнего длинного ответа, как в кадре 01.
  await win.webContents.executeJavaScript(`(() => {
    const feed = document.querySelector('#feed');
    if (feed) feed.scrollTop = 1e9;
    return feed ? feed.scrollTop : null;
  })()`).catch(() => null);
  await sleep(250);
  const geometry = await readGeometry(win);

  const image = await win.webContents.capturePage();
  if (!image || image.isEmpty()) throw new Error('capturePage вернул пустой кадр');
  const size = image.getSize();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, image.toPNG());

  finish({
    ok: true,
    out: outPath,
    width,
    height,
    imageWidth: size.width,
    imageHeight: size.height,
    state,
    orb,
    variant,
    cleaned,
    page,
    noxGeometry: geometry && geometry.noxScreen ? geometry.noxScreen : null,
    geometryPath: dumpPath || null,
    geometry: geometry ? geometry.elements || null : null,
    consoleErrors,
  });
}

app.on('browser-window-created', (_event, win) => {
  try {
    win.webContents.on('console-message', (_e, level, message) => {
      const noisy = typeof level === 'object' && level ? level : null;
      const severity = noisy ? noisy.level : level;
      const text = noisy ? noisy.message : message;
      if ((severity === 'error' || severity === 3) && consoleErrors.length < 20) {
        consoleErrors.push(String(text || '').slice(0, 300));
      }
    });
  } catch { /* старые версии Electron: подписка не критична */ }

  win.webContents.once('did-finish-load', () => {
    if (mainWin) return;
    const url = win.webContents.getURL();
    if (!/renderer[\\/]index\.html/i.test(url)) return;
    mainWin = win;
    capture(win).catch((err) => finish({ ok: false, error: err && err.message ? err.message : String(err) }));
  });
});

try {
  require('../main');
} catch (err) {
  finish({ ok: false, error: `main.js не загрузился: ${err && err.message ? err.message : err}` });
}
