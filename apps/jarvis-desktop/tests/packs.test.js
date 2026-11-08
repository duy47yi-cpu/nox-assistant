'use strict';

// Паки команд «Монтаж», «Игры», «Браузер»: структура, фразы, настоящие инструменты и клавиши,
// гейт по белому списку клавиш, экспорт/импорт файла команд и повторный seed без дублей.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CommandStore, DANGEROUS_TOOLS, normalize, previewCommandImport, applyCommandImport, parseCommandPack,
} = require('../src/commands/store');
const { SAMPLE_COMMANDS } = require('../src/commands/samples');
const { uiTools } = require('../src/tools/ui');
const {
  PACKS, getPack, availableCommands, unsupportedCommands, buildPackCommandJson, seedPackCommands, missingKeys,
} = require('../src/commands/packs');

const PACK_IDS = ['montage', 'games', 'browser'];

// Реестр инструментов — из настоящего ui.js, а не из списка в тесте.
const tools = new Map(uiTools().map((tool) => [tool.name, tool]));
const availableNames = (packId) => availableCommands(packId).map((command) => command.name);
const allPacks = () => PACKS.map((pack) => getPack(pack.id));

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-packs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new CommandStore(path.join(dir, 'commands.json'));
}

test('есть минимум три пака: монтаж, игры, браузер', () => {
  assert.deepEqual(PACKS.map((pack) => pack.id), PACK_IDS);
  for (const pack of PACKS) {
    assert.equal(typeof pack.title, 'string');
    assert.ok(pack.title.trim().length > 0, pack.id);
    assert.equal(typeof pack.description, 'string');
    // В описании честно сказано про активное окно: команда не ищет программу сама.
    assert.match(pack.description, /активн(ом|ого) окн/i, pack.id);
    assert.ok(Array.isArray(pack.commands) && pack.commands.length > 0, pack.id);
    assert.ok(availableCommands(pack).length > 0, `${pack.id}: нет выполнимых команд`);
  }
  assert.equal(getPack('nope'), null);
  assert.throws(() => availableCommands('nope'), /пак не найден/);
});

test('структура команд: имя, фразы, шаги в лимитах store.js', () => {
  for (const pack of PACKS) {
    const names = new Set();
    for (const command of pack.commands) {
      assert.equal(typeof command.name, 'string');
      assert.ok(command.name.trim().length > 0);
      assert.ok(command.name.length <= 80, command.name);
      assert.equal(names.has(command.name), false, `имя повторяется в паке: ${command.name}`);
      names.add(command.name);
      assert.ok(Array.isArray(command.phrases), command.name);
      assert.ok(command.phrases.length >= 1 && command.phrases.length <= 5, command.name);
      assert.ok(Array.isArray(command.steps), command.name);
      assert.ok(command.steps.length >= 1 && command.steps.length <= 20, command.name);
      for (const step of command.steps) {
        assert.equal(typeof step.tool, 'string');
        assert.ok(step.tool.trim().length > 0);
        assert.equal(step.args !== null && typeof step.args === 'object' && !Array.isArray(step.args), true, command.name);
      }
    }
  }
});

test('фразы уникальны во всех паках и не конфликтуют с SAMPLE_COMMANDS', () => {
  const seen = new Map();
  for (const pack of PACKS) {
    for (const command of pack.commands) {
      const own = new Set();
      for (const phrase of command.phrases) {
        const key = normalize(phrase);
        assert.equal(own.has(key), false, `фраза повторяется в команде: ${phrase}`);
        own.add(key);
        assert.equal(seen.has(key), false, `фраза «${phrase}» уже у «${seen.get(key)}» и «${command.name}»`);
        seen.set(key, command.name);
      }
    }
  }
  const samplePhrases = new Set(SAMPLE_COMMANDS.flatMap((command) => command.phrases.map((phrase) => normalize(phrase))));
  for (const [phrase, name] of seen) {
    assert.equal(samplePhrases.has(phrase), false, `фраза «${phrase}» (${name}) совпала с примерным сценарием`);
  }
});

test('каждый шаг — настоящий ui_keys; опасных инструментов нет', () => {
  for (const pack of PACKS) {
    for (const command of pack.commands) {
      for (const step of command.steps) {
        const tool = tools.get(step.tool);
        assert.ok(tool, `${command.name}: нет инструмента ${step.tool}`);
        assert.equal(tool.name, 'ui_keys');
        assert.equal(DANGEROUS_TOOLS.has(step.tool), false, `${command.name}: ${step.tool}`);
        assert.equal(step.tool.startsWith('mission_') || step.tool.startsWith('command_'), false);
        assert.equal(typeof (step.args && step.args.keys), 'string', `${command.name}: нет клавиш`);
      }
    }
  }
  // Опасное в паке не только по имени инструмента: у всех шагов нет своих путей и команд оболочки.
  const text = JSON.stringify(PACKS);
  assert.doesNotMatch(text, /shell_run|pc_shutdown|app_close|mail_send/);
});

test('все клавиши паков есть в белом списке: невыполнимых команд нет, экспорт получает все', () => {
  for (const pack of PACKS) {
    assert.deepEqual(unsupportedCommands(pack.id), [], pack.id);
    assert.equal(availableCommands(pack.id).length, pack.commands.length, pack.id);
    const exported = parseCommandPack(buildPackCommandJson(pack.id)).commands.map((command) => command.name);
    assert.deepEqual(exported.sort(), pack.commands.map((command) => command.name).sort(), pack.id);
  }
});

test('гейт по белому списку по-прежнему отсекает клавиши вне списка', () => {
  const withKeys = (keys) => ({ name: 'проба', steps: [{ tool: 'ui_keys', args: { keys } }] });
  // Сознательно не добавленные клавиши и голый Delete остаются вне списка.
  assert.deepEqual(missingKeys(withKeys('alt+f4')), ['alt+f4']);
  assert.deepEqual(missingKeys(withKeys('win+r')), ['win+r']);
  assert.deepEqual(missingKeys(withKeys('delete')), ['delete']);
  assert.deepEqual(missingKeys(withKeys('ctrl+k')), []);
});

test('выполнимые команды: все клавиши проходят parseKeys', () => {
  const { parseKeys } = require('../src/tools/ui');
  for (const pack of PACKS) {
    for (const command of availableCommands(pack)) {
      assert.ok(command.steps.length > 0);
      for (const step of command.steps) {
        const parsed = parseKeys(step.args.keys);
        assert.equal(parsed.ok, true, `${command.name}: ${parsed.error}`);
        assert.ok(parsed.tokens.length > 0);
      }
    }
  }
});

test('экспорт пака — файл команд Nox: preview видит все команды, apply добавляет без потерь', (t) => {
  for (const pack of PACKS) {
    const json = buildPackCommandJson(pack.id);
    const target = tmpStore(t);
    const preview = previewCommandImport(json, target);
    assert.equal(preview.ok, true, preview.error);
    assert.equal(preview.preview.counts.add, availableCommands(pack).length, pack.id);
    assert.equal(preview.preview.counts.conflict, 0, pack.id);
    assert.equal(preview.preview.counts.update, 0, pack.id);
    assert.equal(preview.preview.applicable, true, pack.id);
    assert.deepEqual(preview.preview.warnings, [], pack.id);
    const applied = applyCommandImport(json, target, { confirm: true });
    assert.equal(applied.ok, true, applied.error);
    assert.equal(applied.added, availableCommands(pack).length, pack.id);

    const stored = target.list();
    assert.equal(stored.length, availableCommands(pack).length, pack.id);
    for (const command of availableCommands(pack)) {
      const saved = stored.find((item) => item.name === command.name);
      assert.ok(saved, `${pack.id}: не импортирована ${command.name}`);
      assert.equal(saved.schemaVersion, 2);
      assert.equal(saved.origin, 'sample');
      assert.equal(saved.enabled, true);
      assert.equal(saved.folder, pack.title);
      assert.deepEqual(saved.collections, ['Паки']);
      assert.deepEqual(saved.phrases, command.phrases.map((phrase) => normalize(phrase)));
      assert.deepEqual(saved.steps, command.steps);
    }
  }
});

test('повторный seed не дублирует команды', (t) => {
  const store = tmpStore(t);
  const first = seedPackCommands(store);
  const total = PACK_IDS.reduce((sum, id) => sum + availableCommands(id).length, 0);
  assert.equal(first.length, total);
  assert.equal(store.list().length, total);
  // Имена в порядке паков и команд: монтаж, затем игры, затем браузер.
  const expected = PACK_IDS.flatMap((id) => availableNames(id));
  assert.deepEqual(first, expected);
  assert.deepEqual(seedPackCommands(store), []);
  assert.equal(store.list().length, total);
});

test('seed не трогает существующую команду с тем же именем', (t) => {
  const store = tmpStore(t);
  seedPackCommands(store, ['browser']);
  const saved = store.list().find((item) => item.name === 'Браузер: новая вкладка');
  store.save({ ...saved, phrases: ['моя новая вкладка'], enabled: false });
  const again = seedPackCommands(store, ['browser']);
  assert.deepEqual(again, []);
  const changed = store.list().find((item) => item.name === saved.name);
  assert.deepEqual(changed.phrases, ['моя новая вкладка']);
  assert.equal(changed.enabled, false);
  assert.equal(store.list().length, availableCommands('browser').length);
});

test('seed по выбранным пакам добавляет только их команды', (t) => {
  const store = tmpStore(t);
  const added = seedPackCommands(store, ['games']);
  assert.deepEqual(added, availableNames('games'));
  assert.deepEqual(store.list().map((item) => item.name).sort(), availableNames('games').sort());
  assert.equal(store.list().some((item) => item.name.startsWith('Монтаж:')), false);
});

test('фраза, занятая чужой командой, не перезаписывается и не роняет seed', (t) => {
  const store = tmpStore(t);
  store.save({
    name: 'Моя вкладка',
    phrases: ['новая вкладка'],
    steps: [{ tool: 'ui_keys', args: { keys: 'ctrl+t' } }],
    origin: 'manual',
  });
  const added = seedPackCommands(store, ['browser']);
  assert.equal(added.includes('Браузер: новая вкладка'), false);
  const own = store.findByPhrase('новая вкладка');
  assert.equal(own.name, 'Моя вкладка');
  // Остальные команды браузера добавились.
  assert.equal(added.length, availableCommands('browser').length - 1);
  assert.ok(store.list().some((item) => item.name === 'Браузер: адресная строка'));
});

test('после seed фразы находят команды паков', (t) => {
  const store = tmpStore(t);
  seedPackCommands(store);
  assert.equal(store.findByPhrase('новая вкладка').name, 'Браузер: новая вкладка');
  assert.equal(store.findByPhrase('Новая вкладка.').name, 'Браузер: новая вкладка');
  assert.equal(store.findByPhrase('кадр назад в монтаже').name, 'Монтаж: кадр назад');
  assert.equal(store.findByPhrase('прыжок в игре').name, 'Игры: прыжок');
});

test('неизвестный пак в seed — ошибка до записи', (t) => {
  const store = tmpStore(t);
  assert.throws(() => seedPackCommands(store, ['browser', 'nope']), /пак не найден/);
  assert.equal(store.list().length, 0);
  assert.throws(() => buildPackCommandJson('nope'), /пак не найден/);
  assert.throws(() => seedPackCommands({}), /нужно хранилище команд/);
});

test('каждый выполнимый шаг проходит политику «Спрашивать» без отказа', () => {
  const { decide } = require('../src/policy/modes');
  for (const pack of PACKS) {
    for (const command of availableCommands(pack)) {
      for (const step of command.steps) {
        const tool = tools.get(step.tool);
        assert.ok(tool, `${command.name}: нет инструмента ${step.tool}`);
        const verdict = decide({
          mode: 'ask',
          name: tool.name,
          risk: tool.risk,
          args: step.args,
          workspace: os.tmpdir(),
          sessionAllow: new Set(),
          hasPathParam: false,
        });
        assert.notEqual(verdict, 'deny', `${command.name}: ${step.tool} отклонён политикой`);
        // ui_keys — действие (T1): в ручном режиме спрашивается, а не выполняется молча.
        if (tool.risk === 'T1') assert.equal(verdict, 'ask', `${command.name}: ${step.tool} должно спрашиваться`);
      }
    }
  }
});

test('установка одного пака по клику: повтор не плодит дубли', (t) => {
  const store = tmpStore(t);
  const first = seedPackCommands(store, ['games']);
  assert.equal(first.length, availableCommands('games').length);
  assert.deepEqual(seedPackCommands(store, ['games']), []);
  assert.equal(store.list().length, first.length);
});
