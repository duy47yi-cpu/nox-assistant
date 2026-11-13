const $ = id => document.getElementById(id);
const send = message => chrome.runtime.sendMessage(message);

function render(state) {
  const labels = {
    disconnected: 'Не подключено',
    pairing: 'Сопряжение…',
    connected: 'Мост подтверждён',
    error: 'Ошибка подключения',
  };
  $('connection').textContent = state.error || labels[state.connection] || 'Не подключено';
  if (state.access === 'granted') {
    const leftSec = state.grantExpires ? Math.max(0, Math.ceil((state.grantExpires - Date.now()) / 1000)) : 60;
    $('grant').textContent = `Одноразовый доступ: ${state.origin} (${leftSec} с)`;
  } else {
    $('grant').textContent = state.accessError || 'Доступ отозван';
  }
  $('connect').disabled = state.connection === 'pairing' || state.connection === 'connected';
  $('disconnect').disabled = state.connection === 'disconnected';
  $('revoke').disabled = state.access !== 'granted';
}

async function update(message) {
  try {
    const state = await send(message);
    render(state);
    return state;
  } catch {
    render({ connection: 'error', access: 'revoked', error: 'Фоновый процесс недоступен' });
  }
}

$('connect').addEventListener('click', async () => {
  const pairing = {
    id: $('pair-id').value.trim(),
    secret: $('secret').value.trim(),
    expires: Number($('expires').value),
  };
  const port = Number($('port').value);
  $('secret').value = '';
  $('pair-id').value = '';
  $('expires').value = '';
  await update({ type: 'pair', port, pairing });
});

$('disconnect').addEventListener('click', () => update({ type: 'disconnect' }));
$('revoke').addEventListener('click', async () => {
  $('output').textContent = '';
  await update({ type: 'revoke' });
});
$('allow').addEventListener('click', async () => {
  $('output').textContent = '';
  const result = await update({ type: 'read-current' });
  if (result?.access === 'granted') $('output').textContent = result.text || 'Нет доступного текста';
});

update({ type: 'status' });

// Refresh while the popup is visible; the worker remains the source of truth.
setInterval(async () => {
  const state = await update({ type: 'status' });
  if (state?.access !== 'granted') $('output').textContent = '';
}, 1000);
