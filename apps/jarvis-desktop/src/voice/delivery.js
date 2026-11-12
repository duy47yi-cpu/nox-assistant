'use strict';

// Как доставить ответ (идея JARVIS-OS): очевидный успех видимого действия — текстом без голоса,
// ошибка — всегда голосом, обычный ответ — как раньше. Чистая функция без Electron и сети.
const SELF_EVIDENT = Object.freeze([
  'app_open', 'app_close',
  'windows_list', 'windows_focus', 'windows_snap', 'windows_close_all', 'window_close_active',
  'windows_minimize_all', 'windows_restore_all', 'windows_arrange',
  'ui_click', 'ui_type', 'ui_keys', 'ui_focus', 'ui_wait',
  'desktop_click', 'desktop_type', 'desktop_observe',
  'browser_', 'media_control', 'volume_set', 'mouse_click', 'mouse_scroll',
]);

// Видимое действие: его результат владелец и так видит на экране.
function selfEvident(name) {
  const tool = String(name || '');
  return SELF_EVIDENT.some((item) => (item.endsWith('_') ? tool.startsWith(item) : tool === item));
}

// mode: silent — ничего; brief — только строка в окне (результат виден); full — текст и голос.
// Ошибку и отказ не скрываем никогда: молчание об ошибке хуже лишней фразы.
function classifyDelivery({ text = '', tools = [], failed = false, terse = false } = {}) {
  const clean = String(text || '').trim();
  if (failed) return { mode: 'full', reason: 'ошибка всегда слышна' };
  if (!clean) return { mode: 'silent', reason: 'ответа нет' };
  if (!terse) return { mode: 'full', reason: 'настройка «тише» выключена' };
  const names = (Array.isArray(tools) ? tools : []).filter(Boolean);
  if (names.length > 0 && names.every(selfEvident)) {
    return { mode: 'brief', reason: 'результат виден на экране' };
  }
  return { mode: 'full', reason: 'в ответе есть пояснение или чтение' };
}

const DEFAULT_NOTIFICATION_CATEGORIES = Object.freeze(['reminders', 'tasks', 'apps', 'files', 'budget']);
const NOTIFICATION_CATEGORIES = [...DEFAULT_NOTIFICATION_CATEGORIES, 'breaks'];
const LOCAL_TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const isTime = (value) => typeof value === 'string' && LOCAL_TIME.test(value);
const isVolume = (value) => Number.isFinite(value) && value >= 0 && value <= 1;

function readNotificationVoice(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: value.enabled === true,
    categories: Array.isArray(value.categories)
      ? NOTIFICATION_CATEGORIES.filter((category) => value.categories.includes(category))
      : [...DEFAULT_NOTIFICATION_CATEGORIES],
    volume: isVolume(value.volume) ? value.volume : 0.7,
    quietEnabled: value.quietEnabled !== false,
    quietFrom: isTime(value.quietFrom) ? value.quietFrom : '23:00',
    quietTo: isTime(value.quietTo) ? value.quietTo : '08:00',
    importantAtNight: value.importantAtNight === true,
  };
}

function validNotificationVoice(value) {
  return Boolean(value && typeof value === 'object'
    && ['enabled', 'quietEnabled', 'importantAtNight'].every((key) => typeof value[key] === 'boolean')
    && Array.isArray(value.categories) && value.categories.every((key) => NOTIFICATION_CATEGORIES.includes(key))
    && isVolume(value.volume) && isTime(value.quietFrom) && isTime(value.quietTo));
}

function inNotificationQuietHours(cfg, now) {
  if (!cfg.quietEnabled) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const from = minutes(cfg.quietFrom);
  const to = minutes(cfg.quietTo);
  // Равные границы означают тишину на весь день. Конец интервала не входит в тихие часы.
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

function notificationVolume(item, settings, now) {
  const cfg = readNotificationVoice(settings.notificationVoice);
  if (settings.quiet === true || !cfg.enabled || !cfg.volume || !cfg.categories.includes(item.category)) return null;
  if (inNotificationQuietHours(cfg, now) && !(item.important === true && cfg.importantAtNight)) return null;
  return cfg.volume;
}

class NotificationSpeech {
  constructor({ speak, settings, now = () => new Date(), isBusy = () => false, onError = () => {} }) {
    Object.assign(this, { speak, settings, now, isBusy, onError });
    this.queue = [];
    this.active = null;
    this.drain = null;
    this.foregroundCount = 0;
  }

  volume(item) {
    return this.foregroundCount || this.isBusy() || item.isCurrent?.() === false
      ? null : notificationVolume(item, this.settings(), this.now());
  }

  enqueue(items) {
    // Устаревшие поводы не копим: тихий час, чтение и микрофон пропускают озвучку.
    for (const item of items) {
      if (this.queue.length >= 12) break;
      if (this.volume(item) !== null) this.queue.push(item);
    }
    if (!this.drain && this.queue.length) {
      // Резервируем очередь до вызова голоса; обработчик синтеза может вызвать другой код.
      this.drain = Promise.resolve().then(async () => {
        try {
          do { await this.playQueue(); } while (this.queue.length);
        } finally {
          this.drain = null;
        }
      });
    }
    return this.drain;
  }

  async playQueue() {
    while (this.queue.length) {
      const item = this.queue.shift();
      const volume = this.volume(item);
      if (volume === null) continue;
      const controller = new AbortController();
      this.active = { item, controller };
      // Проверяем границу тихих часов также во время синтеза и длинной фразы.
      const timer = setInterval(() => this.recheck(), 250);
      timer.unref();
      try {
        await this.speak(item.text, { volume, signal: controller.signal });
      } catch (err) {
        if (!controller.signal.aborted) this.onError(err);
      } finally {
        clearInterval(timer);
        this.active = null;
      }
    }
  }

  recheck() {
    this.queue = this.queue.filter((item) => this.volume(item) !== null);
    if (this.active && this.volume(this.active.item) === null) this.active.controller.abort();
  }

  stop() {
    this.queue.length = 0;
    this.active?.controller.abort();
    return this.drain;
  }

  // Чтение, ответы и явная проверка голоса не накладываются на хвост отменённого уведомления.
  async foreground(run) {
    this.foregroundCount += 1;
    try {
      const drain = this.stop();
      if (drain) await drain;
      return await run();
    } finally {
      this.foregroundCount -= 1;
    }
  }
}

module.exports = {
  classifyDelivery, selfEvident, SELF_EVIDENT,
  readNotificationVoice, validNotificationVoice, inNotificationQuietHours, notificationVolume, NotificationSpeech,
};
