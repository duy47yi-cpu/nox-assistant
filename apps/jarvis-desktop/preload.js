// Узкий мост между окном и main-процессом: только явные методы, без общего invoke.
const { contextBridge, ipcRenderer } = require('electron');

ipcRenderer.on('voice:overlay', (_event, text) => {
  const target = document.getElementById('voiceOverlayText');
  if (!target) return;
  target.textContent = typeof text === 'string' ? text : '';
  document.body.dataset.voiceCommand = text ? 'yes' : 'no';
});

let microphoneCapture;
ipcRenderer.on('voice:capture', async (_event, config) => {
  microphoneCapture?.stop();
  microphoneCapture = null;
  if (!config) return;

  let stream;
  let audio;
  let processor;
  let active = true;
  const send = (type, payload) => {
    if (active) ipcRenderer.send('voice:capture-event', config.id, type, payload);
  };
  const stop = () => {
    active = false;
    processor?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    audio?.close().catch(() => {});
  };
  microphoneCapture = { stop };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false,
        ...(config.device ? { deviceId: { exact: config.device } } : {}),
      },
    });
    if (!active) { stop(); return; }
    const track = stream.getAudioTracks()[0];
    track.addEventListener('ended', () => { send('error'); stop(); });
    audio = new AudioContext({ sampleRate: 16000 });
    const input = audio.createMediaStreamSource(stream);
    processor = audio.createScriptProcessor(1024, 1, 1);
    processor.onaudioprocess = ({ inputBuffer }) => {
      const samples = inputBuffer.getChannelData(0);
      const pcm = new ArrayBuffer(samples.length * 2);
      const view = new DataView(pcm);
      for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, Math.max(-32768, Math.min(32767, samples[i] * 32768)), true);
      send('pcm', pcm);
    };
    input.connect(processor);
    processor.connect(audio.destination); // выход остаётся нулевым, вход не проигрывается
    await audio.resume();
    send('ready');
  } catch (error) {
    send('error', error.name);
    stop();
  }
});

contextBridge.exposeInMainWorld('jarvis', {
  send: (text, files, opts) => ipcRenderer.invoke('chat:send', String(text), Array.isArray(files) ? files : [], opts && typeof opts === 'object' ? opts : undefined),
  side: (text) => ipcRenderer.invoke('chat:side', String(text)),
  stop: () => ipcRenderer.invoke('agent:stop'),
  showMain: () => ipcRenderer.invoke('window:showMain'),
  closeMini: () => ipcRenderer.invoke('mini:close'),
  resizeQuick: (height) => ipcRenderer.invoke('quick:resize', height),
  quickHotkey: () => ipcRenderer.invoke('quick:hotkey'),
  setQuickHotkey: (key) => ipcRenderer.invoke('quick:setHotkey', String(key)),
  onQuickShown: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('quick:shown', listener);
    return () => ipcRenderer.removeListener('quick:shown', listener);
  },
  // Диктовка в поле другой программы: действия окна-подсказки (state, insert, cancel, copy) и его состояние.
  fieldDictation: (action) => ipcRenderer.invoke('field-dictation:act', String(action)),
  onFieldDictation: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('field-dictation:state', listener);
    return () => ipcRenderer.removeListener('field-dictation:state', listener);
  },
  setWindowBackground: (color) => ipcRenderer.invoke('window:setBackground', String(color)),
  windowControl: (action) => ipcRenderer.invoke('window:control', String(action)),
  getState: () => ipcRenderer.invoke('state:get'),
  tasksAttention: () => ipcRenderer.invoke('tasks:attention'),
  accountState: () => ipcRenderer.invoke('account:state'),
  accountRegister: (email, password) => ipcRenderer.invoke('account:register', email, password),
  accountLogin: (email, password) => ipcRenderer.invoke('account:login', email, password),
  accountLogout: () => ipcRenderer.invoke('account:logout'),
  mcpState: () => ipcRenderer.invoke('mcp:state'),
  mcpAdd: (name, target, args) => ipcRenderer.invoke('mcp:add', String(name), String(target), String(args || '')),
  mcpToggle: (name, disabled) => ipcRenderer.invoke('mcp:toggle', String(name), disabled === true),
  mcpRemove: (name) => ipcRenderer.invoke('mcp:remove', String(name)),
  mcpApprove: (name) => ipcRenderer.invoke('mcp:approve', String(name)),
  mailState: () => ipcRenderer.invoke('mail:state'),
  mailConnect: (read = false) => ipcRenderer.invoke('mail:connect', { read: read === true }),
  mailDisconnect: () => ipcRenderer.invoke('mail:disconnect'),
  tasksHideAttention: (taskId) => ipcRenderer.invoke('tasks:hideAttention', String(taskId)),
  tasksOpenReport: (taskId) => ipcRenderer.invoke('tasks:openReport', String(taskId)),
  missionsBoard: () => ipcRenderer.invoke('missions:board'),
  setMode: (mode) => ipcRenderer.invoke('mode:set', mode),
  respondApproval: (id, decision, shownToken) => ipcRenderer.invoke('approval:respond', id, decision, shownToken),
  markApprovalShown: (id) => ipcRenderer.invoke('approval:shown', id),
  listApprovals: () => ipcRenderer.invoke('approval:list'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  voiceTest: () => ipcRenderer.invoke('voice:test'),
  voiceModelDownload: () => ipcRenderer.invoke('voice:model-download'),
  voiceModelFolder: () => ipcRenderer.invoke('voice:model-folder'),
  onVoiceModelProgress: (cb) => {
    const listener = (_event, progress) => cb(progress);
    ipcRenderer.on('voice:model-progress', listener);
    return () => ipcRenderer.removeListener('voice:model-progress', listener);
  },
  voiceMicrophones: async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default')
      .map((device, index) => ({ id: device.deviceId, title: device.label || `Микрофон ${index + 1}` }));
  },
  voiceState: () => ipcRenderer.invoke('voice:state'),
  setModelTier: (tier) => ipcRenderer.invoke('settings:setModelTier', tier),
  setThinking: (level) => ipcRenderer.invoke('settings:setThinking', level),
  setReplyStyle: (style) => ipcRenderer.invoke('settings:setReplyStyle', style),
  setMusicService: (service) => ipcRenderer.invoke('music:setService', service),
  recentJournal: (limit) => ipcRenderer.invoke('journal:recent', limit),
  dealsList: () => ipcRenderer.invoke('deals:list'),
  dealClear: (ref) => ipcRenderer.invoke('deals:clear', ref),
  widgetsData: (options) => ipcRenderer.invoke('widgets:data', options),
  widgetsOpenMusic: (last) => ipcRenderer.invoke('widgets:openMusic', last),
  widgetsSetCity: (city) => ipcRenderer.invoke('widgets:setCity', city),
  dictationStart: () => ipcRenderer.invoke('dictation:start'),
  dictationStop: () => ipcRenderer.invoke('dictation:stop'),
  // Режим микрофона: «Слушаю» → «Только имя» → «Микрофон выкл».
  dictationMode: (mode) => ipcRenderer.invoke('dictation:mode', String(mode)),
  dictationState: () => ipcRenderer.invoke('dictation:state'),
  onDictationEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('dictation:event', listener);
    return () => ipcRenderer.removeListener('dictation:event', listener);
  },
  chatHistory: () => ipcRenderer.invoke('chat:history'),
  clearChat: () => ipcRenderer.invoke('chat:clear'),
  chatList: () => ipcRenderer.invoke('chat:list'),
  chatNew: () => ipcRenderer.invoke('chat:new'),
  chatSelect: (id) => ipcRenderer.invoke('chat:select', String(id)),
  chatClose: (id) => ipcRenderer.invoke('chat:close', String(id)),
  workspacesList: () => ipcRenderer.invoke('workspaces:list'),
  workspacesCreate: (name) => ipcRenderer.invoke('workspaces:create', String(name)),
  workspacesSelect: (id) => ipcRenderer.invoke('workspaces:select', String(id)),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  pickRegion: () => ipcRenderer.invoke('region:pick'),
  openWorkspace: () => ipcRenderer.invoke('workspace:open'),
  openSource: (url) => ipcRenderer.invoke('source:open', String(url)),
  artifactAction: (request) => ipcRenderer.invoke('artifact:action', request),
  sourceIcon: (host) => ipcRenderer.invoke('source:icon', host),
  addFolder: () => ipcRenderer.invoke('folders:add'),
  removeFolder: (dir) => ipcRenderer.invoke('folders:remove', String(dir)),
  listCommands: () => ipcRenderer.invoke('commands:list'),
  installPack: (id) => ipcRenderer.invoke('packs:install', id),
  saveCommand: (cmd) => ipcRenderer.invoke('commands:save', cmd),
  buildCommandFromText: (payload) => ipcRenderer.invoke('commands:build-from-text', payload),
  draftCommandFromTurn: (payload) => ipcRenderer.invoke('commands:draft-from-turn', payload),
  deleteCommand: (id) => ipcRenderer.invoke('commands:delete', id),
  runCommand: (id) => ipcRenderer.invoke('commands:run', id),
  updateCommandTriggers: (id, triggers) => ipcRenderer.invoke('commands:triggers-update', { id, triggers }),
  getCommandLaunches: (filters) => ipcRenderer.invoke('commands:launch-overview', filters),
  triggerCommandLaunch: (payload) => ipcRenderer.invoke('commands:trigger', payload),
  fireCommandEvent: (payload) => ipcRenderer.invoke('commands:fire-event', payload),
  clearCommandLaunchLog: (commandId) => ipcRenderer.invoke('commands:launch-clear', { commandId }),
  exportCommands: () => ipcRenderer.invoke('commands:export'),
  pickCommandsImport: () => ipcRenderer.invoke('commands:import-pick'),
  applyCommandsImport: (token, confirm) => ipcRenderer.invoke('commands:import-apply', token, confirm === true),
  recordStart: () => ipcRenderer.invoke('commands:record-start'),
  recordStop: () => ipcRenderer.invoke('commands:record-stop'),
  recordCancel: () => ipcRenderer.invoke('commands:record-cancel'),
  recordState: () => ipcRenderer.invoke('commands:record-state'),
  journalSearch: (filters) => ipcRenderer.invoke('journal:search', filters),
  memoryList: (options) => ipcRenderer.invoke('memory:list', options),
  memoryUpdate: (id, patch) => ipcRenderer.invoke('memory:update', id, patch),
  memoryRemove: (id) => ipcRenderer.invoke('memory:remove', id),
  memoryClear: (confirm) => ipcRenderer.invoke('memory:clear', { confirm: confirm === true }),
  remindersList: (options) => ipcRenderer.invoke('reminders:list', options),
  remindersUpdate: (id, patch) => ipcRenderer.invoke('reminders:update', id, patch),
  remindersCancel: (id) => ipcRenderer.invoke('reminders:cancel', id),
  desksState: () => ipcRenderer.invoke('desks:state'),
  desksCreate: (payload) => ipcRenderer.invoke('desks:create', payload),
  desksRename: (id, name) => ipcRenderer.invoke('desks:rename', id, name),
  desksRemove: (id) => ipcRenderer.invoke('desks:remove', id),
  desksSelect: (id) => ipcRenderer.invoke('desks:select', id),
  desksAddWidget: (deskId, widget) => ipcRenderer.invoke('desks:add-widget', deskId, widget),
  desksMoveWidget: (deskId, widgetId, x, y) => ipcRenderer.invoke('desks:move-widget', deskId, widgetId, x, y),
  desksResizeWidget: (deskId, widgetId, w, h) => ipcRenderer.invoke('desks:resize-widget', deskId, widgetId, w, h),
  desksUpdateWidget: (deskId, widgetId, patch) => ipcRenderer.invoke('desks:update-widget', deskId, widgetId, patch),
  desksRemoveWidget: (deskId, widgetId) => ipcRenderer.invoke('desks:remove-widget', deskId, widgetId),
  calendarState: () => ipcRenderer.invoke('calendar:state'),
  calendarSetSource: (payload) => ipcRenderer.invoke('calendar:setSource', payload),
  calendarPickFile: () => ipcRenderer.invoke('calendar:pickFile'),
  clipboardHistoryState: () => ipcRenderer.invoke('clipboard-history:state'),
  clipboardHistoryList: (options) => ipcRenderer.invoke('clipboard-history:list', options),
  clipboardHistoryRemove: (id) => ipcRenderer.invoke('clipboard-history:remove', id),
  clipboardHistoryClear: () => ipcRenderer.invoke('clipboard-history:clear'),
  clipboardHistoryPause: () => ipcRenderer.invoke('clipboard-history:pause'),
  clipboardHistoryResume: () => ipcRenderer.invoke('clipboard-history:resume'),
  clipboardHistoryTtl: (ttlMs) => ipcRenderer.invoke('clipboard-history:ttl', ttlMs),
  snippetsList: () => ipcRenderer.invoke('snippets:list'),
  snippetsSave: (payload) => ipcRenderer.invoke('snippets:save', payload),
  snippetsRemove: (id) => ipcRenderer.invoke('snippets:remove', id),
  snippetsPreview: (id) => ipcRenderer.invoke('snippets:preview', id),
  snippetsInsert: (id, confirm) => ipcRenderer.invoke('snippets:insert', id, confirm === true),
  downloadsAnalyze: (options) => ipcRenderer.invoke('downloads:analyze', options),
  downloadsRemove: (payload, confirm) => ipcRenderer.invoke('downloads:remove', payload, confirm === true),
  diskFree: () => ipcRenderer.invoke('disk:free'),
  toolCatalog: () => ipcRenderer.invoke('tools:catalog'),
  browserBridgeState: () => ipcRenderer.invoke('browser-bridge:state'),
  libraryList: () => ipcRenderer.invoke('library:list'),
  libraryRun: (id, values) => ipcRenderer.invoke('library:run', id, values),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },
});
