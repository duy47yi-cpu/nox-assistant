'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { mediaTools } = require('../src/tools/media');
const { windowsTools } = require('../src/tools/windows');
const desktopMod = require('../src/tools/desktop');
const { desktopTools, desktopToolsFactory } = desktopMod;
const { uiTools, SCRIPTS: UI_SCRIPTS } = require('../src/tools/ui');
const systemMod = require('../src/tools/system');
const { systemTools, systemToolsFactory } = systemMod;

function byName(tools, name) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `expected tool ${name}`);
  return tool;
}

test('media_control: allowNoSession работает только для pause при NO_SESSION и проверяется STATUS_SCRIPT', async () => {
  const seenScripts = [];
  const toolDefault = byName(mediaTools({
    runner: async (script) => {
      seenScripts.push(script);
      return { ok: true, summary: 'готово', data: { stdout: 'NO_SESSION\n', stderr: '' } };
    },
  }), 'media_control');

  assert.deepEqual(toolDefault.parameters.properties.allowNoSession, { type: 'boolean' });
  assert.deepEqual(toolDefault.parameters.required, ['action']);

  // Без allowNoSession поведение не меняется: честный отказ на NO_SESSION
  const legacyPause = await toolDefault.run({ action: 'pause' });
  assert.equal(legacyPause.ok, false);
  assert.equal(legacyPause.data.action, 'pause');

  // allowNoSession: true не распространяется на play
  const playWithFlag = await toolDefault.run({ action: 'play', allowNoSession: true });
  assert.equal(playWithFlag.ok, false);

  // pause + allowNoSession: true на NO_SESSION даёт мягкий успех
  const softPause = await toolDefault.run({ action: 'pause', allowNoSession: true });
  assert.equal(softPause.ok, true);
  assert.equal(softPause.summary, 'ничего не играет (пауза не потребовалась)');
  assert.deepEqual(softPause.data, { action: 'pause', noSession: true, status: 'None' });

  // verify для noSession: NO_SESSION -> confirmed
  const vNoSession = await toolDefault.verify({ action: 'pause', allowNoSession: true }, softPause);
  assert.deepEqual(vNoSession, { status: 'confirmed', evidence: 'активного воспроизведения нет' });

  // verify для noSession: Paused -> confirmed
  const toolPaused = byName(mediaTools({
    runner: async () => ({ ok: true, data: { stdout: 'STATUS=Paused\n' } }),
  }), 'media_control');
  const vPaused = await toolPaused.verify({}, softPause);
  assert.equal(vPaused.status, 'confirmed');

  // verify для noSession: Playing -> failed
  const toolPlaying = byName(mediaTools({
    runner: async () => ({ ok: true, data: { stdout: 'STATUS=Playing\n' } }),
  }), 'media_control');
  const vPlaying = await toolPlaying.verify({}, softPause);
  assert.equal(vPlaying.status, 'failed');

  // verify для noSession: ошибка чтения -> unknown
  const toolErr = byName(mediaTools({
    runner: async () => ({ ok: false, summary: 'таймаут 10000 мс' }),
  }), 'media_control');
  const vErr = await toolErr.verify({}, softPause);
  assert.equal(vErr.status, 'unknown');

  // При активной сессии pause + allowNoSession работает как обычная пауза
  const responses = [
    { ok: true, data: { stdout: 'OK=True STATUS=Paused APP=Spotify.exe\n' } },
    { ok: true, data: { stdout: 'STATUS=Paused\n' } },
  ];
  const toolActive = byName(mediaTools({
    runner: async () => responses.shift(),
  }), 'media_control');
  const activePause = await toolActive.run({ action: 'pause', allowNoSession: true });
  assert.equal(activePause.ok, true);
  assert.equal(activePause.summary, 'плеер: pause');
  assert.equal(activePause.data.noSession, undefined);
  assert.equal((await toolActive.verify({}, activePause)).status, 'confirmed');
  assert.ok(seenScripts.length > 0);
});

test('windows_arrange: схема left_right, скрипты видимости/cloaked/IsZoomed, фильтрация и <2 окон', async () => {
  const calls = [];
  const fakeEnum = {
    area: { x: 0, y: 0, w: 1920, h: 1080 },
    windows: [
      { hwnd: 1, process: 'chrome', title: 'Chrome', left: 0, top: 0, right: 800, bottom: 600, minimized: false, visible: true, cloaked: false },
      { hwnd: 2, process: 'notepad', title: 'Свёрнутое', left: 0, top: 0, right: 500, bottom: 500, minimized: true, visible: true, cloaked: false },
      { hwnd: 3, process: 'CalculatorApp', title: 'Скрытое', left: 0, top: 0, right: 500, bottom: 500, minimized: false, visible: true, cloaked: true },
      { hwnd: 4, process: 'ApplicationFrameHost', title: 'Невидимое', left: 0, top: 0, right: 500, bottom: 500, minimized: false, visible: false, cloaked: false },
      { hwnd: 5, process: 'jarvis-desktop', title: 'Nox Assistant', left: 0, top: 0, right: 800, bottom: 600, minimized: false, visible: true, cloaked: false },
      { hwnd: 6, process: 'Electron', title: 'Electron Host', left: 0, top: 0, right: 800, bottom: 600, minimized: false, visible: true, cloaked: false },
      { hwnd: 7, process: 'mspaint', title: 'Нулевой размер', left: 100, top: 100, right: 100, bottom: 500, minimized: false, visible: true, cloaked: false },
      { hwnd: 8, process: 'TextInputHost', title: 'Microsoft Text Input Application', left: 0, top: 0, right: 400, bottom: 400, minimized: false, visible: true, cloaked: false },
    ],
  };

  const arrange = byName(windowsTools(async (script, env) => {
    calls.push({ script, env });
    return { ok: true, data: { stdout: JSON.stringify(fakeEnum) } };
  }), 'windows_arrange');

  assert.deepEqual(arrange.parameters.properties.layout.enum, ['row', 'grid', 'cascade']);
  assert.deepEqual(arrange.parameters.properties.count, { type: 'integer', minimum: 2, maximum: 9 });

  // Неверный count отклоняется до запуска PowerShell
  const badCount = await arrange.run({ layout: 'row', count: 1 });
  assert.equal(badCount.ok, false);
  assert.equal(calls.length, 0);

  const res = await arrange.run({ layout: 'row', count: 2 });
  assert.equal(res.ok, false);
  assert.equal(res.summary, 'подходящих окон: 1, нужно минимум 2');
  assert.deepEqual(res.data, { found: 1, windows: ['Chrome'] });
  // При < 2 окнах раскладка APPLY_SCRIPT не запускается
  assert.equal(calls.length, 1);

  // ENUM_SCRIPT проверяет IsWindowVisible и DwmGetWindowAttribute (DWMWA_CLOAKED = 14)
  assert.match(calls[0].script, /IsWindowVisible/);
  assert.match(calls[0].script, /DwmGetWindowAttribute/);
  assert.match(calls[0].script, /\b14\b/);

  // 0 подходящих окон -> отказ без раскладки
  const arrangeZero = byName(windowsTools(async () => ({
    ok: true,
    data: { stdout: JSON.stringify({ area: { x: 0, y: 0, w: 1920, h: 1080 }, windows: [] }) },
  })), 'windows_arrange');
  const resZero = await arrangeZero.run({ layout: 'left_right' });
  assert.equal(resZero.ok, false);
  assert.equal(resZero.summary, 'подходящих окон: 0, нужно минимум 2');
  assert.deepEqual(resZero.data, { found: 0, windows: [] });
});

test('windows_arrange: { layout: "row", count: 2 } и alias "left_right" раскладывают ровно 2 верхних окна и проверяются в verify', async () => {
  const calls = [];
  let stage = 'initial';

  const arrange = byName(windowsTools(async (script, env) => {
    calls.push({ script, env });
    if (script.includes('GetWindowRect')) {
      if (stage === 'initial') {
        return {
          ok: true,
          data: {
            stdout: JSON.stringify({
              area: { x: 0, y: 0, w: 1920, h: 1080 },
              windows: [
                { hwnd: 10, process: 'nox-assistant', title: 'Nox', left: 0, top: 0, right: 900, bottom: 700, minimized: false },
                // Окна без visible/cloaked/bounds (как в упрощённых моках) не отбрасываются
                { hwnd: 11, title: 'Chrome', minimized: false },
                { hwnd: 12, process: 'Code', title: 'VS Code', left: 10, top: 10, right: 1000, bottom: 900, minimized: false, visible: true, cloaked: false },
                { hwnd: 13, process: 'notepad', title: 'Третье окно', left: 20, top: 20, right: 600, bottom: 600, minimized: false, visible: true, cloaked: false },
              ],
            }),
          },
        };
      }
      if (stage === 'verified') {
        return {
          ok: true,
          data: {
            stdout: JSON.stringify({
              area: { x: 0, y: 0, w: 1920, h: 1080 },
              windows: [
                { hwnd: 11, title: 'Chrome', left: 0, top: 0, right: 956, bottom: 1080, minimized: false, visible: true, cloaked: false },
                { hwnd: 12, title: 'VS Code', left: 964, top: 0, right: 1920, bottom: 1080, minimized: false, visible: true, cloaked: false },
              ],
            }),
          },
        };
      }
      return {
        ok: true,
        data: {
          stdout: JSON.stringify({
            area: { x: 0, y: 0, w: 1920, h: 1080 },
            windows: [
              { hwnd: 11, title: 'Chrome', left: 0, top: 0, right: 956, bottom: 1080, minimized: false, visible: false, cloaked: false },
              { hwnd: 12, title: 'VS Code', left: 964, top: 0, right: 1920, bottom: 1080, minimized: false, visible: true, cloaked: true },
            ],
          }),
        },
      };
    }
    return { ok: true, data: { stdout: '{"moved":2}' } };
  }), 'windows_arrange');

  const resRowCount2 = await arrange.run({ layout: 'row', count: 2 });
  assert.equal(resRowCount2.ok, true);
  assert.equal(resRowCount2.summary, 'разложил 2 окна рядом: «Chrome» и «VS Code»');
  assert.equal(resRowCount2.data.layout, 'row');
  assert.equal(resRowCount2.data.placed.length, 2);
  assert.deepEqual(resRowCount2.data.placed[0], { hwnd: 11, title: 'Chrome', x: 0, y: 0, w: 956, h: 1080 });
  assert.deepEqual(resRowCount2.data.placed[1], { hwnd: 12, title: 'VS Code', x: 964, y: 0, w: 956, h: 1080 });

  const resAlias = await arrange.run({ layout: 'left_right' });
  assert.equal(resAlias.ok, true);
  assert.equal(resAlias.summary, 'разложил 2 окна рядом: «Chrome» и «VS Code»');
  assert.equal(resAlias.data.layout, 'left_right');
  assert.deepEqual(resAlias.data.placed, resRowCount2.data.placed);

  // APPLY_SCRIPT проверяет IsZoomed и восстанавливает (SW_RESTORE = 9) до MoveWindow; без дубля параметра `int h`
  const applyCall = calls[1];
  assert.match(applyCall.script, /IsZoomed/);
  assert.match(applyCall.script, /ShowWindow\([^,]+,\s*9\)/);
  assert.match(applyCall.script, /MoveWindow\(IntPtr hwnd/);
  assert.equal(JSON.parse(applyCall.env.JARVIS_ARRANGE).length, 2);

  stage = 'verified';
  const okVerify = await arrange.verify({ layout: 'row', count: 2 }, resRowCount2);
  assert.equal(okVerify.status, 'confirmed');

  stage = 'hidden';
  const failVerify = await arrange.verify({ layout: 'row', count: 2 }, resRowCount2);
  assert.equal(failVerify.status, 'failed');
  assert.match(failVerify.evidence, /скрыто/);
});

test('desktopToolsFactory сохраняет прежний набор инструментов и использует injected runner', async () => {
  assert.equal(typeof desktopToolsFactory, 'function');
  assert.ok(Array.isArray(desktopTools));
  assert.equal(desktopTools.some((t) => t.name === 'pc_lock'), false);
  assert.deepEqual(
    desktopTools.map((t) => t.name),
    ['wait', 'windows_minimize_all', 'windows_restore_all', 'monitor_off', 'app_close', 'speak', 'pc_shutdown', 'read_clipboard_aloud']
  );
  assert.equal(typeof desktopMod.setSpeaker, 'function');
  assert.equal(typeof desktopMod.readDocumentText, 'function');

  const runs = [];
  const mocked = desktopToolsFactory({
    runner: async (script, env) => {
      runs.push({ script, env });
      return { ok: true, summary: 'готово', data: { stdout: '' } };
    },
    speak: async () => {},
  });

  // Остальные инструменты сценариев используют injected runner / speak
  const minimize = byName(mocked, 'windows_minimize_all');
  const minRes = await minimize.run({});
  assert.equal(minRes.ok, true);
  assert.equal(minRes.summary, 'окна свёрнуты');

  const shutdown = byName(mocked, 'pc_shutdown');
  assert.equal(shutdown.risk, 'T3');
  const shutRes = await shutdown.run({ delay_seconds: 15 });
  assert.equal(shutRes.ok, true);
  assert.equal(runs[runs.length - 1].env.JARVIS_DELAY, '15');

  const reader = byName(mocked, 'read_clipboard_aloud');
  assert.equal((await reader.run({ action: 'status' })).ok, true);
});

test('ui_keys win+l: скрипт использует LockWorkStation до self_foreground, run/verify работают без реальной блокировки', async () => {
  assert.match(UI_SCRIPTS.ui_keys, /LockWorkStation\(\)/);
  assert.match(UI_SCRIPTS.ui_keys, /\$plan -eq '91,76' -and \$wname\.Trim\(\) -eq ''/);
  assert.ok(
    UI_SCRIPTS.ui_keys.indexOf("if ($plan -eq '91,76' -and $wname.Trim() -eq '')")
    < UI_SCRIPTS.ui_keys.indexOf("status = 'self_foreground'")
  );

  const callsOk = [];
  const uiOk = byName(uiTools({
    runner: async (script, env) => {
      callsOk.push({ script, env });
      return { ok: true, data: { stdout: JSON.stringify({ status: 'ok', window: '' }) + '\n' } };
    },
    selfPid: 4242,
  }), 'ui_keys');
  assert.equal(uiOk.risk, 'T1');

  const lockOk = await uiOk.run({ keys: 'win+l' }, {});
  assert.deepEqual(lockOk, {
    ok: true,
    summary: 'экран заблокирован',
    data: { lock: true, keys: 'win+l' },
  });
  assert.equal(callsOk[0].env.JARVIS_UI_VK, '91,76');
  assert.equal(callsOk[0].env.JARVIS_UI_WINDOW, '');

  const v = await uiOk.verify({ keys: 'win+l' }, lockOk);
  assert.equal(v.status, 'unknown');
  assert.match(v.evidence, /блокировку экрана нельзя проверить до входа/);

  const uiFail = byName(uiTools({
    runner: async () => ({
      ok: true,
      data: { stdout: JSON.stringify({ status: 'lock_failed', window: '' }) + '\n' },
    }),
  }), 'ui_keys');
  const lockFail = await uiFail.run({ keys: 'win+l' }, {});
  assert.equal(lockFail.ok, false);
  assert.match(lockFail.summary, /не удалось заблокировать экран/);

  // Если указан window — ветка обычных клавиш сохраняется
  const uiWithWindow = byName(uiTools({
    runner: async () => ({
      ok: true,
      data: { stdout: JSON.stringify({ status: 'ok', window: 'Блокнот' }) + '\n' },
    }),
  }), 'ui_keys');
  const winRes = await uiWithWindow.run({ keys: 'win+l', window: 'Блокнот' }, {});
  assert.equal(winRes.ok, true);
  assert.equal(winRes.data.lock, undefined);
  assert.deepEqual(winRes.data.keys, ['win+l']);
});

test('systemToolsFactory: экспорты сохранены, volume_set/app_open/url_open тестируются с моками без реальных процессов', async () => {
  assert.equal(typeof systemToolsFactory, 'function');
  assert.ok(Array.isArray(systemTools));
  for (const key of [
    'systemTools',
    'systemToolsFactory',
    'runPowerShell',
    'probeProcess',
    'probeProcessWindow',
    'probeBrowserTitle',
    'probeFolderWindow',
    'brandOf',
    'pollUntil',
    'setBrowserExe',
    'findBrowserExe',
    'setAppResolver',
    'setAppLaunchHook',
    'parseOpenOutput',
    'windowMatches',
    'MAX_ENCODED',
  ]) {
    assert.ok(key in systemMod, `missing export ${key}`);
  }

  const psCalls = [];
  const spawnCalls = [];
  const launchedNames = [];

  const tools = systemToolsFactory({
    runner: async (script, env) => {
      psCalls.push({ script, env });
      if (script.includes('WScript.Shell')) return { ok: true, data: { stdout: '' } };
      if (env && env.JARVIS_APP) {
        return {
          ok: true,
          data: {
            stdout: JSON.stringify({
              title: 'Telegram',
              pid: 4242,
              process: 'Telegram',
              path: 'C:\\Apps\\Telegram\\Telegram.exe',
              startedPid: 4242,
            }),
          },
        };
      }
      if (script.includes('JARVIS_PROCS')) return { ok: true, data: { stdout: 'True\n' } };
      return { ok: true, data: { stdout: 'True\n' } };
    },
    spawn: (exe, args, opts) => {
      spawnCalls.push({ exe, args, opts });
      const child = new EventEmitter();
      child.unref = () => { child.unreffed = true; };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    getAppResolver: () => (name) => (name === 'telegram' ? 'C:\\Apps\\Telegram\\Telegram.exe' : null),
    getBrowserExe: () => 'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    getAppLaunchHook: () => (name) => launchedNames.push(name),
    fsImpl: {
      statSync: (p) => ({
        isDirectory: () => false,
        isFile: () => p.endsWith('Telegram.exe'),
      }),
    },
  });

  // volume_set(0)
  const volumeSet = byName(tools, 'volume_set');
  assert.equal(volumeSet.risk, 'T0');
  const volRes = await volumeSet.run({ percent: 0 });
  assert.equal(volRes.ok, true);
  assert.equal(volRes.summary, 'громкость ~0%');
  assert.match(psCalls[0].script, /\[char\]174/);
  assert.match(psCalls[0].script, /\$i -lt 0;/);
  assert.equal((await volumeSet.verify({}, volRes)).status, 'unknown');

  // app_open с mock getAppResolver и verify через mock runner
  const appOpen = byName(tools, 'app_open');
  const openRes = await appOpen.run({ name: 'telegram' });
  assert.equal(openRes.ok, true);
  assert.equal(openRes.data.process, 'Telegram');
  assert.deepEqual(launchedNames, ['telegram']);
  assert.equal(psCalls[1].env.JARVIS_APP, 'C:\\Apps\\Telegram\\Telegram.exe');
  const openVerify = await appOpen.verify({ name: 'telegram' }, openRes, { pollTimeoutMs: 50 });
  assert.equal(openVerify.status, 'confirmed');

  // Прямая передача resolver-функции (не getter) тоже поддерживается
  const directResolverCalls = [];
  const toolsDirect = systemToolsFactory({
    runner: async (script, env) => {
      directResolverCalls.push(env.JARVIS_APP);
      return { ok: true, data: { stdout: '{}' } };
    },
    getAppResolver: (name) => (name === 'notepad' ? 'C:\\Windows\\notepad.exe' : null),
    fsImpl: { statSync: () => ({ isDirectory: () => false, isFile: () => false }) },
  });
  await byName(toolsDirect, 'app_open').run({ name: 'notepad' });
  assert.deepEqual(directResolverCalls, ['C:\\Windows\\notepad.exe']);

  // url_open с mock spawn и verify через mock runner
  const urlOpen = byName(tools, 'url_open');
  const urlRes = await urlOpen.run({ url: 'https://example.com' });
  assert.equal(urlRes.ok, true);
  assert.equal(urlRes.data.host, 'example.com');
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].exe, 'C:\\Program Files\\Mozilla Firefox\\firefox.exe');
  assert.deepEqual(spawnCalls[0].args, ['-new-tab', 'https://example.com/']);
  const urlVerify = await urlOpen.verify({ url: 'https://example.com' }, urlRes, { pollTimeoutMs: 50 });
  assert.equal(urlVerify.status, 'confirmed');
});
