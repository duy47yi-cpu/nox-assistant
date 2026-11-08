'use strict';

// Руки на рабочем столе: живой PowerShell, серия действий без модели, Esc-стоп, удаление и замена в чужом окне.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPsHost, asciiJson } = require('../src/tools/ps-host');
const { EscStop } = require('../src/control/esc-stop');
const { DesktopLock, guardDesktopTools } = require('../src/control/desktop-lock');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { ApprovalBroker } = require('../src/policy/approvals');
const modes = require('../src/policy/modes');
const { parseKeys, keysToVk, KEY_MAP } = require('../src/tools/ui');

const win = process.platform === 'win32';

test('ps-host: escape не-ASCII, чтобы кириллица дошла через stdin консоли', () => {
  assert.equal(asciiJson({ a: 'ё' }), '{"a":"\\u0451"}');
  assert.deepEqual(JSON.parse(asciiJson({ a: 'Привет', b: 'x' })), { a: 'Привет', b: 'x' });
});

test('ps-host: ответы по порядку, кириллица, env не протекает, таймаут перезапускает процесс', { skip: !win, timeout: 60000 }, async () => {
  const host = createPsHost();
  try {
    const [a, b] = await Promise.all([
      host.run('[string]$env:JARVIS_T1', { JARVIS_T1: 'Привет, я JARVIS' }),
      host.run('"второй:" + [string]$env:JARVIS_T1', { JARVIS_T2: 'x' }),
    ]);
    assert.equal(a.ok, true);
    assert.equal(a.data.stdout.trim(), 'Привет, я JARVIS');
    assert.equal(b.data.stdout.trim(), 'второй:', 'переменная прошлого запроса стёрта');
    const slow = await host.run('Start-Sleep -Seconds 5; "поздно"', {}, { timeoutMs: 300 });
    assert.equal(slow.ok, false);
    assert.match(slow.summary, /таймаут/);
    const after = await host.run('"снова"', {});
    assert.equal(after.data.stdout.trim(), 'снова');
    const thrown = await host.run("throw 'сбой'", {});
    assert.equal(thrown.ok, false);
  } finally {
    host.close();
  }
});

test('ps-host: остановленный сигнал не запускает скрипт', async () => {
  let spawned = 0;
  const host = createPsHost({ spawnFn: () => { spawned += 1; throw new Error('нельзя'); } });
  const res = await host.run('1', {}, { signal: AbortSignal.abort() });
  assert.equal(res.summary, 'остановлено');
  assert.equal(spawned, 0);
});

test('ps-host: не запустился — обычный запуск PowerShell', async () => {
  const host = createPsHost({ spawnFn: () => { throw new Error('нет'); }, fallback: async () => ({ ok: true, summary: 'запасной', data: { stdout: '1' } }) });
  assert.equal((await host.run('1', {})).summary, 'запасной');
});

function escSetup() {
  const keys = new Map();
  let stops = 0;
  const timers = [];
  const esc = new EscStop({
    register: (k, fn) => { keys.set(k, fn); return true; },
    unregister: (k) => keys.delete(k),
    onStop: () => { stops += 1; },
    setTimer: (fn) => timers.push(fn),
  });
  return { esc, keys, timers, stops: () => stops };
}

test('Esc: занят только с первого действия рук и до конца хода; нажатие останавливает ход', () => {
  const s = escSetup();
  assert.equal(s.keys.has('Escape'), false);
  assert.equal(s.esc.action('ui_click', { name: 'ОК' }), null);
  assert.equal(s.keys.has('Escape'), true);
  s.keys.get('Escape')();
  assert.equal(s.stops(), 1);
  assert.equal(s.keys.has('Escape'), false, 'после стопа Esc отдан программам');
  s.esc.action('ui_click', {});
  s.esc.disarm();
  assert.equal(s.keys.has('Escape'), false);
});

test('Esc: свой Esc из ui_keys стопом не считается, фон Esc не занимает', () => {
  const s = escSetup();
  assert.equal(s.esc.action('ui_click', {}, { background: true }), null);
  assert.equal(s.keys.has('Escape'), false);
  const after = s.esc.action('ui_keys', { keys: 'escape' });
  assert.equal(s.esc.press(), false);
  after();
  assert.equal(s.esc.press(), false, 'ещё 300 мс после шага');
  s.timers.forEach((fn) => fn());
  assert.equal(s.esc.press(), true);
  assert.equal(s.stops(), 1);
});

test('Esc: занятый другой программой Esc не ломает действие', () => {
  const esc = new EscStop({ register: () => { throw new Error('занято'); }, unregister: () => {}, onStop: () => {} });
  esc.action('ui_click', {});
  assert.equal(esc.armed, false);
});

test('замок стола зовёт хук до действия и «после» по окончании', async () => {
  const lock = new DesktopLock();
  const seen = [];
  lock.onAction = (name, args) => { seen.push(`до:${name}`); return () => seen.push('после'); };
  const [t] = guardDesktopTools([{ name: 'ui_keys', risk: 'T1', run: async () => { seen.push('шаг'); return { ok: true, summary: '' }; } }], lock);
  await t.run({ keys: 'escape' }, {});
  assert.deepEqual(seen, ['до:ui_keys', 'шаг', 'после']);
});

test('клавиши для Проводника и Блокнота в белом списке; голый Delete и alt+f4 нет; shift+delete есть', () => {
  assert.equal(parseKeys('ctrl+shift+n').sendkeys, '^+n');
  assert.equal(parseKeys('ctrl+l').sendkeys, '^l');
  assert.equal(parseKeys('ctrl+n').sendkeys, '^n');
  assert.equal(parseKeys('delete').ok, false);
  assert.equal(parseKeys('alt+f4').ok, false);
  assert.equal(parseKeys('shift+delete').sendkeys, '+{DEL}');
});

test('каждая клавиша белого списка имеет код виртуальной клавиши', () => {
  for (const k of Object.keys(KEY_MAP)) assert.match(keysToVk([k]), /^\d+(,\d+)*$/, k);
  assert.equal(keysToVk(parseKeys('ctrl+s enter').tokens), '17,83;13');
  assert.equal(keysToVk(['ctrl+shift+n']), '17,16,78');
  // Клавиши паков: Delete — только в составе Shift+Delete, F5 — свой код.
  assert.equal(keysToVk(['shift+delete']), '16,46');
  assert.equal(keysToVk(['f5']), '116');
  assert.equal(keysToVk(['ctrl+tab']), '17,9');
  assert.equal(keysToVk(['ctrl+w']), '17,87');
});

test('удаление и замена в чужом окне спрашиваются даже в «Полном доступе»', () => {
  const ask = (name, args) => modes.decide({ mode: 'full', name, risk: 'T1', args });
  assert.equal(ask('ui_click', { window: 'Проводник', name: 'Удалить' }), 'ask');
  assert.equal(ask('ui_click', { window: 'Блокнот', name: 'Replace' }), 'ask');
  assert.equal(ask('ui_click', { window: 'Подтвердить сохранение в виде', name: 'Да' }), 'ask');
  assert.equal(ask('ui_keys', { window: 'Подтвердить сохранение в виде', keys: 'enter' }), 'ask');
  assert.equal(ask('ui_click', { window: 'Блокнот', name: 'Сохранить' }), 'allow');
  assert.equal(ask('ui_type', { window: 'Блокнот', text: 'удалить всё' }), 'allow', 'текст ввода — не кнопка');
});

test('app_open с папкой: проверка по окну Проводника с этим путём, а не по процессу', async () => {
  const { systemTools } = require('../src/tools/system');
  const appOpen = systemTools.find((t) => t.name === 'app_open');
  const result = { ok: true, data: { process: 'x', folder: 'Тест', target: 'C:\\tmp\\Тест' } };
  const seen = [];
  const yes = await appOpen.verify({}, result, { probeFolderWindow: async (p) => { seen.push(p); return true; } });
  assert.equal(yes.status, 'confirmed');
  assert.deepEqual(seen, ['C:\\tmp\\Тест']);
  const no = await appOpen.verify({}, result, { probeFolderWindow: async () => false, pollTimeoutMs: 50 });
  assert.equal(no.status, 'unknown');
});

function brainOf(steps) {
  let i = 0;
  return { async chat() { const s = steps[i++]; if (!s) throw new Error('конец'); return { content: s.content || '', reasoningContent: null, toolCalls: s.toolCalls || [] }; } };
}

test('серия действий одним ответом: идёт подряд, после ошибки остальные действия не выполняются, чтение выполняется', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cu-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ran = [];
  const reg = new ToolRegistry();
  const mk = (name, risk, ok) => reg.register({ name, risk, description: name, parameters: { type: 'object', properties: {} }, run: async () => { ran.push(name); return { ok, summary: ok ? 'да' : 'нет' }; } });
  mk('a_focus', 'T1', true);
  mk('b_type', 'T1', false);
  mk('c_keys', 'T1', true);
  mk('d_read', 'T0', true);
  const events = [];
  const agent = new Agent({
    brain: brainOf([
      { toolCalls: [{ id: '1', name: 'a_focus', args: {} }, { id: '2', name: 'b_type', args: {} }, { id: '3', name: 'c_keys', args: {} }, { id: '4', name: 'd_read', args: {} }] },
      { content: 'итог' },
    ]),
    tools: reg,
    approvals: new ApprovalBroker({ timeoutMs: 1000 }),
    journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => events.push(e),
    mode: 'full',
    workspace: dir,
  });
  await agent.run('сделай');
  assert.deepEqual(ran, ['a_focus', 'b_type', 'd_read']);
  const skipped = events.find((e) => e.type === 'tool_result' && e.id === '3');
  assert.match(skipped.summary, /пропущено/);
  const toolMsg = agent.history.find((m) => m.role === 'tool' && m.tool_call_id === '3');
  assert.match(toolMsg.content, /предыдущий шаг серии не удался/);
});

test('владелец печатает в другом окне: руки ждут короткой паузы и действуют, без сообщений', async () => {
  let t = 10000;
  const agos = [200, 400, 5000];
  const lock = new DesktopLock({ inputAgoMs: async () => agos.shift() ?? 5000, pollMs: 1, now: () => t });
  let ran = 0;
  const res = await lock.run(async () => { ran += 1; return { ok: true, summary: '' }; });
  assert.equal(res.ok, true);
  assert.equal(ran, 1);
});

test('владелец не отпускает ввод: руки ждут не дольше ownerWaitMs и всё равно действуют', async () => {
  let t = 0;
  const lock = new DesktopLock({ inputAgoMs: async () => { t += 500; return 100; }, pollMs: 1, ownerWaitMs: 2000, now: () => t });
  let ran = 0;
  const res = await lock.run(async () => { ran += 1; return { ok: true }; });
  assert.equal(res.ok, true);
  assert.equal(ran, 1);
  assert.ok(t <= 2600, 'ждали не дольше срока');
  const bg = await lock.run(async () => { ran += 1; return { ok: true }; }, { background: true });
  assert.equal(bg.ok, true, 'фон и так ждёт 2 минуты простоя по idleSeconds');
});

test('открыть ссылку или программу не ждёт паузы в вводе владельца', async () => {
  let t = 0;
  const lock = new DesktopLock({ inputAgoMs: async () => { t += 500; return 100; }, pollMs: 1, ownerWaitMs: 2000, now: () => t });
  const [open] = guardDesktopTools([{ name: 'url_open', risk: 'T1', run: async () => ({ ok: true, summary: 'открыто' }) }], lock);
  const res = await open.run({ url: 'https://example.com' }, {});
  assert.equal(res.ok, true);
  assert.equal(t, 0, 'ожидания не было');
});

test('ввод в окне самого Nox не считается вводом владельца', async () => {
  const { inputAgoVia } = require('../src/control/desktop-lock');
  const runner = async () => ({ ok: true, data: { stdout: '120;4242\r\n' } });
  assert.equal(await inputAgoVia(runner, 4242)(), null, 'фокус на Nox: руки не ждут');
  assert.equal(await inputAgoVia(runner, 9999)(), 120, 'фокус на другом окне: ввод виден');
  assert.equal(await inputAgoVia(runner)(), 120);
  assert.equal(await inputAgoVia(async () => ({ ok: true, data: { stdout: 'none' } }))(), null);
});

test('свой ввод Джарвиса не считается вводом владельца', async () => {
  let t = 100000;
  const lock = new DesktopLock({ inputAgoMs: async () => 300, pollMs: 1, ownerWaitMs: 50, now: () => t });
  lock.lastOwnEnd = t - 250; // ввод 300 мс назад был раньше конца нашего шага
  const res = await lock.run(async () => ({ ok: true }));
  assert.equal(res.ok, true);
});

test('установка без прямой просьбы спрашивается даже в «Полном доступе» и «на сессию»', () => {
  const session = new Set([modes.allowKey('app_install', { id: 'Mozilla.Firefox' })]);
  assert.equal(modes.decide({ mode: 'full', name: 'app_install', risk: 'T3', args: { id: 'Mozilla.Firefox' }, sessionAllow: session }), 'ask');
  assert.equal(modes.decide({ mode: 'full', name: 'shell_run', risk: 'T2', args: { command: 'winget install vlc' } }), 'ask');
  assert.equal(modes.decide({ mode: 'full', name: 'shell_run', risk: 'T2', args: { command: 'pip install requests' } }), 'ask');
  assert.equal(modes.decide({ mode: 'full', name: 'app_search', risk: 'T0', args: { query: 'vlc' } }), 'allow');
  assert.match(modes.describe({ name: 'app_install', args: {} }), /лицензией/);
});

test('app_install: Id по шаблону через env, проверка по списку установленных', async () => {
  const { installTools } = require('../src/tools/install');
  const calls = [];
  const runner = async (script, env) => { calls.push({ script, env }); return { ok: true, summary: 'готово', data: { stdout: script.includes('winget list') ? 'Name        Id              Version\n----------------------------------------\nVLC         VideoLAN.VLC    1.0\n' : 'Успешно установлено\r\n' } }; };
  const install = installTools({ runner }).find((x) => x.name === 'app_install');
  assert.equal((await install.run({ id: 'vlc; Remove-Item C:/' })).ok, false);
  assert.equal(calls.length, 0);
  const r = await install.run({ id: 'VideoLAN.VLC' });
  assert.equal(r.ok, true);
  assert.equal(calls[0].env.JARVIS_ID, 'VideoLAN.VLC');
  assert.doesNotMatch(calls[0].script, /VideoLAN/);
  assert.equal((await install.verify({}, r, {})).status, 'confirmed');
  const no = installTools({ runner: async () => ({ ok: false, summary: 'код выхода 1', data: {} }) }).find((x) => x.name === 'app_install');
  assert.equal((await no.verify({}, r, {})).status, 'unknown');
});

test('проверка установки не подтверждает успех только по коду выхода winget', async () => {
  const { installTools } = require('../src/tools/install');
  const result = { ok: true, data: { id: 'VideoLAN.VLC' } };
  for (const stdout of ['', 'No installed package found matching input criteria.', 'Name        Id              Version\n----------------------------------------\nOther       Other.App       1.0\n']) {
    const install = installTools({ runner: async () => ({ ok: true, data: { stdout } }) }).find((tool) => tool.name === 'app_install');
    assert.equal((await install.verify({}, result)).status, 'unknown');
  }
});

test('проверка ввода: GetLastInputInfo через живой PowerShell даёт число мс', { skip: !win, timeout: 30000 }, async () => {
  const { inputAgoVia } = require('../src/control/desktop-lock');
  const host = createPsHost();
  try {
    const ago = await inputAgoVia(host.run)();
    assert.ok(Number.isFinite(ago) && ago >= 0, String(ago));
  } finally {
    host.close();
  }
});

test('надпись «Nox работает на вашем ПК · Esc — остановить»: есть в главном окне (скрыта до работы рук) и в плашке поверх окон', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'renderer', f), 'utf8');
  const index = read('index.html');
  const banner = /<div class="hands-banner" id="handsBanner" hidden>([\s\S]*?)<\/div><\/div>/.exec(index);
  assert.ok(banner, 'в главном окне есть скрытая надпись');
  assert.match(banner[1], /Nox работает на вашем ПК/);
  assert.match(banner[1], /<kbd>Esc<\/kbd><span class="hands-hint">— остановить/);
  assert.match(index, /href="hands.css"/);
  const overlay = read('hands.html');
  assert.match(overlay, /Nox работает на вашем ПК/);
  assert.match(overlay, /<kbd>Esc<\/kbd>/);
  assert.match(read('app.js'), /case 'hands':[\s\S]{0,200}banner\.hidden = ev\.active !== true/);
});

test('надпись включается с первым действием рук и гаснет в конце хода и по Esc', () => {
  const changes = [];
  const keys = new Map();
  const esc = new EscStop({ register: (k, fn) => { keys.set(k, fn); return true; }, unregister: (k) => keys.delete(k), onStop: () => {}, onChange: (a) => changes.push(a) });
  esc.action('ui_click', {});
  esc.action('ui_type', {});
  assert.deepEqual(changes, [true], 'один раз за ход');
  esc.disarm();
  assert.deepEqual(changes, [true, false]);
  esc.action('ui_click', {});
  keys.get('Escape')();
  assert.deepEqual(changes, [true, false, true, false]);
  esc.action('ui_click', {}, { background: true });
  assert.deepEqual(changes, [true, false, true, false], 'фон надпись не включает');
});

test('Ctrl+S следует режиму доступа как запись, а не удаление', () => {
  const d = (mode, window) => modes.decide({ mode, name: 'ui_keys', risk: 'T1', args: { window, keys: 'ctrl+s' } });
  assert.equal(d('full', 'привет.txt — Блокнот'), 'allow');
  assert.equal(d('full', '*Без имени — Блокнот'), 'allow');
  assert.equal(d('ask', 'привет.txt — Блокнот'), 'ask');
  assert.equal(d('auto', 'привет.txt — Блокнот'), 'ask');
});

test('ui_type не печатает пометку журнала «[скрыто, N симв.]» из сохранённой истории', async () => {
  const { uiTools } = require('../src/tools/ui');
  let calls = 0;
  const t = uiTools({ runner: async () => { calls += 1; return { ok: true, data: { stdout: '{}' } }; } }).find((x) => x.name === 'ui_type');
  const r = await t.run({ window: 'Проводник', text: '[скрыто, 4 симв.]' }, {});
  assert.equal(r.ok, false);
  assert.match(r.summary, /пометка журнала/);
  assert.equal(calls, 0);
});

test('Ctrl+S без имени файла в window: проверка заголовка в окне включена; с именем файла — Risk Gate, проверка выключена', async () => {
  const { uiTools } = require('../src/tools/ui');
  const calls = [];
  const runner = async (script, env) => { calls.push(env); return { ok: true, data: { stdout: JSON.stringify({ status: 'save_existing', window: 'привет.txt — Блокнот' }) } }; };
  const keys = uiTools({ runner }).find((x) => x.name === 'ui_keys');
  const r = await keys.run({ window: 'Блокнот', keys: 'ctrl+s' }, {});
  assert.equal(r.ok, false);
  assert.match(r.summary, /перезапишет/);
  assert.equal(calls[0].JARVIS_UI_SAVE_GUARD, '1');
  await keys.run({ window: 'привет.txt — Блокнот', keys: 'ctrl+s' }, {});
  assert.equal(calls[1].JARVIS_UI_SAVE_GUARD, '');
  await keys.run({ window: 'Блокнот', keys: 'enter' }, {});
  assert.equal(calls[2].JARVIS_UI_SAVE_GUARD, '');
});

test('живое состояние стола можно перечитывать в ходе: ui_windows трижды не считается зацикливанием', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cu-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reg = new ToolRegistry();
  let runs = 0;
  reg.register({ name: 'ui_windows', risk: 'T0', description: '', parameters: { type: 'object', properties: {} }, run: async () => { runs += 1; return { ok: true, summary: 'окна' }; } });
  const call = (id) => ({ toolCalls: [{ id, name: 'ui_windows', args: {} }] });
  const agent = new Agent({ brain: brainOf([call('1'), call('2'), call('3'), { content: 'ок' }]), tools: reg, approvals: new ApprovalBroker({ timeoutMs: 1000 }), journal: new Journal(path.join(dir, 'j.jsonl')), emit: () => {}, mode: 'full', workspace: dir });
  await agent.run('окна');
  assert.equal(runs, 3);
});

test('драйверы и обновления Windows: кнопки и команды установки спрашиваются даже в «Полном доступе», чтение — нет', () => {
  const d = (name, args, risk = 'T1') => modes.decide({ mode: 'full', name, risk, args });
  assert.equal(d('ui_click', { window: 'Параметры', name: 'Установить сейчас' }), 'ask');
  assert.equal(d('ui_click', { window: 'Параметры', name: 'Скачать и установить' }), 'ask');
  assert.equal(d('ui_click', { window: 'Свойства: NVIDIA GeForce', name: 'Обновить драйвер' }), 'ask');
  assert.equal(d('ui_click', { window: 'Settings', name: 'Restart now' }), 'ask');
  assert.equal(d('shell_run', { command: 'pnputil /add-driver C:/d/x.inf /install' }, 'T2'), 'ask');
  assert.equal(d('shell_run', { command: 'UsoClient StartInstall' }, 'T2'), 'ask');
  assert.equal(d('shell_run', { command: 'pnputil /enum-drivers' }, 'T2'), 'allow', 'список драйверов — чтение');
  assert.equal(d('ui_click', { window: 'Параметры', name: 'Проверить наличие обновлений' }), 'allow');
  assert.equal(d('ui_click', { window: 'Диспетчер устройств', name: 'Видеоадаптеры' }), 'allow');
  assert.match(modes.describe({ name: 'ui_click', args: { name: 'Обновить драйвер' } }), /установка/);
});

test('команды, меняющие драйверы и устройства, спрашиваются; чтение — нет (найдено вживую: Update-PnpDeviceDriver и pnputil /scan-devices прошли без вопроса)', () => {
  const d = (command) => modes.decide({ mode: 'full', name: 'shell_run', risk: 'T2', args: { command } });
  assert.equal(d('$x = Get-PnpDevice; Update-PnpDeviceDriver -InstanceId $x'), 'ask');
  assert.equal(d('pnputil /scan-devices'), 'ask');
  assert.equal(d('Disable-PnpDevice -InstanceId x -Confirm:$false'), 'ask');
  assert.equal(d('Install-Module PSWindowsUpdate'), 'ask');
  assert.equal(d('Get-PnpDevice -Class Display'), 'allow');
  assert.equal(d('pnputil /enum-drivers /class Display'), 'allow');
  assert.equal(d('Get-CimInstance Win32_VideoController'), 'allow');
});

