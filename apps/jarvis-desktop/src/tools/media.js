'use strict';

// Управление текущим плеером Windows (Spotify, Яндекс Музыка, браузер с видео): играть, пауза, следующий, предыдущий.
// Через встроенные средства Windows (System Media Transport Controls), без установки пакетов.
const { runPowerShell } = require('./system');

const ACTIONS = new Set(['play', 'pause', 'toggle', 'next', 'previous']);
const EXPECTED = { play: 'Playing', pause: 'Paused' };

// Действие передаётся через переменную окружения, а не в тексте скрипта.
const CONTROL_SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like "IAsyncOperation*" })[0]',
  'Function Await($op, $type) { $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }',
  '[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null',
  '$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])',
  '$s = $mgr.GetCurrentSession()',
  'if (-not $s) { "NO_SESSION"; exit 0 }',
  '$op = switch ($env:JARVIS_MEDIA) { "play" { $s.TryPlayAsync() } "pause" { $s.TryPauseAsync() } "toggle" { $s.TryTogglePlayPauseAsync() } "next" { $s.TrySkipNextAsync() } "previous" { $s.TrySkipPreviousAsync() } }',
  '$ok = Await $op ([bool])',
  '"OK=" + $ok + " STATUS=" + $s.GetPlaybackInfo().PlaybackStatus + " APP=" + $s.SourceAppUserModelId',
].join('\n');

const STATUS_SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like "IAsyncOperation*" })[0]',
  'Function Await($op, $type) { $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }',
  '[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null',
  '$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])',
  '$s = $mgr.GetCurrentSession()',
  'if (-not $s) { "NO_SESSION"; exit 0 }',
  '"STATUS=" + $s.GetPlaybackInfo().PlaybackStatus',
].join('\n');

function parseLine(out) {
  const text = String(out || '').trim();
  if (text === 'NO_SESSION') return { session: false };
  const m = /OK=(True|False) STATUS=(\S+)/.exec(text) || /STATUS=(\S+)/.exec(text);
  if (!m) return { session: true, ok: false, status: null, raw: text };
  return { session: true, ok: m[1] === 'True' || m[1] === undefined, status: m[2] || m[1] };
}

function mediaTools({ runner = runPowerShell } = {}) {
  return [
    {
      name: 'media_control',
      description: 'Управление текущим плеером Windows: play (играть), pause (пауза), toggle (переключить), next (следующий трек), previous (предыдущий). Работает с Spotify, Яндекс Музыкой и вкладкой браузера с видео, если плеер сообщает о себе Windows.',
      risk: 'T1',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: [...ACTIONS] } },
        required: ['action'],
      },
      async run(args, ctx) {
        const action = String((args && args.action) || '');
        if (!ACTIONS.has(action)) return { ok: false, summary: 'неизвестное действие плеера', data: {} };
        const res = await runner(CONTROL_SCRIPT, { JARVIS_MEDIA: action }, { signal: ctx && ctx.signal, timeoutMs: 15000 });
        if (!res.ok) return { ok: false, summary: res.summary, data: {} };
        const parsed = parseLine(res.data && res.data.stdout);
        if (!parsed.session) return { ok: false, summary: 'плеер не найден: ничего не играет или не сообщает о себе Windows', data: { action } };
        return { ok: parsed.ok, summary: parsed.ok ? `плеер: ${action}` : `плеер не ответил на «${action}»`, data: { action, status: parsed.status } };
      },
      // Сверка: play и pause проверяем по статусу; переключение треков честно «не проверено».
      async verify(args, result, ctx = {}) {
        const action = result && result.data && result.data.action;
        if (!EXPECTED[action]) return { status: 'unknown', evidence: 'смену трека Windows не сообщает' };
        const res = await runner(STATUS_SCRIPT, {}, { signal: ctx.signal, timeoutMs: 10000 });
        if (!res.ok) return { status: 'unknown', evidence: `статус не прочитан: ${res.summary}` };
        const parsed = parseLine(res.data && res.data.stdout);
        if (!parsed.session) return { status: 'unknown', evidence: 'плеер не найден при проверке' };
        return parsed.status === EXPECTED[action]
          ? { status: 'confirmed', evidence: `статус ${parsed.status}` }
          : { status: 'failed', evidence: `статус ${parsed.status}, ожидали ${EXPECTED[action]}` };
      },
    },
  ];
}

module.exports = { mediaTools, parseLine, CONTROL_SCRIPT, STATUS_SCRIPT, ACTIONS };
