// Audit probe: does a Chrome extension service worker send Origin on a loopback WebSocket,
// and does the same CSP shape as the audited manifest allow the connection?
const PORT = 28417;

function attempt(tag) {
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/nox`);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ probe: tag, url: chrome.runtime.getURL('/') }));
    });
    ws.addEventListener('error', () => {});
  } catch (error) {
    // A CSP block surfaces asynchronously; nothing to do for the probe.
  }
}

attempt('sw-start');
chrome.runtime.onInstalled.addListener(() => attempt('installed'));
