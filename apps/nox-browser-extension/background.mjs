import { createController } from './background-core.mjs';
const controller = createController({ api: chrome, origin: chrome.runtime.getURL('/').replace(/\/$/, '') });
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  controller.handle(message).then(sendResponse, () => sendResponse({ connection: 'error', access: 'revoked', error: 'Ошибка расширения' }));
  return true;
});
chrome.tabs.onUpdated.addListener((id, change) => controller.updated(id, change));
chrome.tabs.onRemoved.addListener(id => controller.removed(id));
chrome.tabs.onActivated.addListener(() => controller.deactivate());
