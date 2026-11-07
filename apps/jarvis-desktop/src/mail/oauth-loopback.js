'use strict';

const http = require('http');

// Вход открывается только по действию владельца. Сервер слушает лишь loopback,
// принимает один подтверждённый state и закрывается после ответа или таймаута.
function connectGmail({ gmail, openExternal, read = false, timeoutMs = 180000 } = {}) {
  if (!gmail || typeof openExternal !== 'function') throw new Error('нужны Gmail и системный браузер');
  return new Promise((resolve) => {
    let done = false;
    let accepting = false;
    let timer;
    let expectedState = '';
    let redirect = '';
    const server = http.createServer(async (req, res) => {
      const reply = (status, text) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" }); res.end(text); };
      // Сокет уже мог закрыться, пока шёл обмен токена: тогда ответ писать некуда, но это не ошибка.
      const replySafe = (status, text) => { try { reply(status, text); } catch { /* соединение уже закрыто */ } };
      // Защита от DNS-rebinding: браузер обращается к loopback, но заголовок Host чужой — это не наш ответ.
      // beginLogin принимает только http://127.0.0.1:<порт>/oauth, поэтому Host ждём ровно этот.
      let expectedHost = '';
      try { expectedHost = new URL(redirect).host; } catch { expectedHost = ''; }
      if (!expectedHost || String(req.headers.host || '').toLowerCase() !== expectedHost.toLowerCase()) {
        replySafe(400, 'Ответ не относится к подключению.');
        return;
      }
      let url;
      try { url = new URL(req.url, redirect); } catch { replySafe(400, 'Неверный ответ.'); return; }
      if (!expectedState || req.method !== 'GET' || `${url.origin}${url.pathname}` !== redirect || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== expectedState || accepting) {
        replySafe(400, 'Ответ не относится к подключению.');
        return;
      }
      accepting = true;
      server.close();
      // Общий таймер входа не снимаем: обмен кода на токен тоже ограничен сроком входа.
      try {
        const result = await gmail.finishLogin(url.href);
        if (done) { replySafe(504, 'Время подключения истекло. Вернитесь в Nox.'); return; }
        replySafe(result.ok ? 200 : 400, result.ok ? 'Готово. Вернитесь в Nox.' : 'Подключение не завершено. Вернитесь в Nox.');
        finish(result);
      } catch {
        if (done) { replySafe(504, 'Время подключения истекло. Вернитесь в Nox.'); return; }
        replySafe(500, 'Подключение не завершено. Вернитесь в Nox.');
        finish({ ok: false, error: 'не удалось завершить подключение Gmail' });
      }
    });
    function finish(result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (server.listening) server.close();
      if (!result.ok) gmail.cancelLogin();
      resolve(result);
    }
    server.on('error', () => finish({ ok: false, error: 'не удалось открыть локальный адрес для входа' }));
    server.listen(0, '127.0.0.1', async () => {
      redirect = `http://127.0.0.1:${server.address().port}/oauth`;
      let begin;
      try { begin = gmail.beginLogin({ read, redirect }); }
      catch { finish({ ok: false, error: 'не удалось начать подключение Gmail' }); return; }
      if (!begin.ok) { finish(begin); return; }
      expectedState = new URL(begin.url).searchParams.get('state');
      timer = setTimeout(() => finish({ ok: false, error: 'время подключения истекло' }), timeoutMs);
      try { await openExternal(begin.url); }
      catch { finish({ ok: false, error: 'не удалось открыть браузер' }); }
    });
  });
}

module.exports = { connectGmail };
