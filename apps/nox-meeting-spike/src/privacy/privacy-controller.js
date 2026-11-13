'use strict';

const { EventEmitter } = require('node:events');

class ConsentRequiredError extends Error {
  constructor(message = 'Запись и обработка невозможны без явного согласия пользователя') {
    super(message);
    this.name = 'ConsentRequiredError';
    this.code = 'CONSENT_REQUIRED';
  }
}

class HardwareAccessForbiddenError extends Error {
  constructor(message = 'На этапе прототипа доступ к реальному микрофону и системному звуку заблокирован') {
    super(message);
    this.name = 'HardwareAccessForbiddenError';
    this.code = 'HARDWARE_CAPTURE_FORBIDDEN';
  }
}

class StorageIsolationError extends Error {
  constructor(message = 'Путь хранения нарушает изоляцию и затрагивает основную историю Nox') {
    super(message);
    this.name = 'StorageIsolationError';
    this.code = 'STORAGE_ISOLATION_VIOLATION';
  }
}

class StorageWriteError extends Error {
  constructor(message = 'Не удалось сохранить данные тестовой сессии на диск', options = {}) {
    super(message);
    this.name = 'StorageWriteError';
    this.code = 'STORAGE_WRITE_FAILED';
    if (options.cause) this.cause = options.cause;
    this.sessionId = options.sessionId || null;
  }
}

const ALLOWED_PHASE1_SOURCES = new Set(['synthetic', 'synthetic_stream', 'synthetic_file']);

/**
 * Управляет явным согласием пользователя, политикой локальности и запретом на реальный аудиозахват в прототипе.
 */
class PrivacyController extends EventEmitter {
  constructor(options = {}) {
    super();
    this._captureConsent = false;
    this._storageConsent = false;
    this._consentActor = null;
    this._consentGrantedAt = null;
    this._consentRevokedAt = null;
    this._externalNetworkAllowed = false;
    this._microphoneAccessAllowed = false;
    this._systemAudioAccessAllowed = false;
    this._onRevokeHandlers = new Set();

    if (options.initialConsent) {
      throw new ConsentRequiredError('Согласие не может быть включено по умолчанию без явного действия пользователя');
    }
  }

  /**
   * Фиксирует явное согласие на обработку потока и (отдельно) на локальное сохранение итогов.
   */
  grantConsent({ captureConsent, storageConsent = false, actor = 'user' } = {}) {
    if (captureConsent !== true) {
      throw new ConsentRequiredError('Для запуска требуется явное подтверждение captureConsent: true');
    }
    this._captureConsent = true;
    this._storageConsent = Boolean(storageConsent);
    this._consentActor = String(actor || 'user');
    this._consentGrantedAt = new Date().toISOString();
    this._consentRevokedAt = null;

    const snapshot = this.getPolicySnapshot();
    this.emit('consent_granted', snapshot);
    return snapshot;
  }

  /**
   * Обновляет только разрешение на локальное сохранение итогов при активном согласии на обработку.
   */
  setStorageConsent(enabled) {
    if (!this._captureConsent && enabled) {
      throw new ConsentRequiredError('Нельзя включить сохранение без согласия на обработку потока');
    }
    this._storageConsent = Boolean(enabled);
    const snapshot = this.getPolicySnapshot();
    this.emit('policy_updated', snapshot);
    return snapshot;
  }

  /**
   * Отзывает согласие и запускает немедленную очистку памяти/остановку.
   */
  async revokeConsent(reason = 'user_revoked') {
    this._captureConsent = false;
    this._storageConsent = false;
    this._consentRevokedAt = new Date().toISOString();

    const errors = [];
    for (const handler of this._onRevokeHandlers) {
      try {
        await handler(reason);
      } catch (err) {
        errors.push(err);
      }
    }

    const snapshot = this.getPolicySnapshot();
    this.emit('consent_revoked', { reason, snapshot, errors });
    return snapshot;
  }

  onRevoke(handler) {
    if (typeof handler !== 'function') return () => {};
    this._onRevokeHandlers.add(handler);
    return () => this._onRevokeHandlers.delete(handler);
  }

  /**
   * Проверяет допустимость запуска обработки для указанного типа источника.
   */
  assertCanCapture(sourceKind = 'synthetic') {
    if (!ALLOWED_PHASE1_SOURCES.has(sourceKind)) {
      throw new HardwareAccessForbiddenError(
        `Источник "${sourceKind}" запрещён на первом этапе: допустимы только синтетические потоки`
      );
    }
    if (!this._captureConsent) {
      throw new ConsentRequiredError('Запись запрещена: пользователь не дал явного согласия на обработку');
    }
    return true;
  }

  /**
   * Проверяет допустимость записи итогов на диск.
   */
  canPersist() {
    return this._captureConsent === true && this._storageConsent === true;
  }

  assertExternalNetworkBlocked() {
    if (this._externalNetworkAllowed) {
      throw new Error('Нарушение политики прототипа: внешние API должны быть запрещены');
    }
    return true;
  }

  getPolicySnapshot() {
    return {
      captureConsent: this._captureConsent,
      storageConsent: this._storageConsent,
      persistenceMode: this.canPersist() ? 'isolated_local_only' : 'memory_only',
      consentActor: this._consentActor,
      consentGrantedAt: this._consentGrantedAt,
      consentRevokedAt: this._consentRevokedAt,
      externalNetworkAllowed: this._externalNetworkAllowed,
      microphoneAccessAllowed: this._microphoneAccessAllowed,
      systemAudioAccessAllowed: this._systemAudioAccessAllowed,
      hardwareCaptureStatus: 'disabled_synthetic_only',
    };
  }
}

module.exports = {
  PrivacyController,
  ConsentRequiredError,
  HardwareAccessForbiddenError,
  StorageIsolationError,
  StorageWriteError,
  ALLOWED_PHASE1_SOURCES,
};
