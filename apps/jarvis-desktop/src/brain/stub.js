'use strict';

// Заглушка мозга для запуска без ключа: тот же интерфейс chat(), без вызовов инструментов.
const STUB_TEXT = 'Джарвис пока не подключён к модели. Войдите в аккаунт или свяжитесь с нами.';

class StubBrain {
  async chat() {
    return { content: STUB_TEXT, reasoningContent: null, toolCalls: [] };
  }
}

module.exports = { StubBrain, STUB_TEXT };
