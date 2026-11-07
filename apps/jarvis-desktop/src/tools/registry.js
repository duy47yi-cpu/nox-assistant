'use strict';

// Реестр инструментов. Сами инструменты здесь не описываются:
// объект {name, description, risk, parameters, run(args, ctx)} регистрирует вызывающий код.
class ToolRegistry {
  constructor() {
    this._tools = new Map();
  }

  register(tool) {
    if (!tool || typeof tool.name !== 'string' || tool.name === '') {
      throw new Error('Инструмент без имени');
    }
    if (typeof tool.run !== 'function') {
      throw new Error(`Инструмент ${tool.name}: нет метода run()`);
    }
    if (this._tools.has(tool.name)) {
      throw new Error(`Инструмент уже зарегистрирован: ${tool.name}`);
    }
    this._tools.set(tool.name, tool);
  }

  get(name) {
    return this._tools.get(name);
  }

  // Снять инструмент по имени: нужно подключениям MCP при выключении сервиса.
  unregister(name) {
    return this._tools.delete(name);
  }

  list() {
    return [...this._tools.values()];
  }
}

module.exports = { ToolRegistry };
