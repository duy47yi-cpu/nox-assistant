'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { projectRoot, unpacked } = require('../src/config/paths');

const APP = path.join('C:', 'repo', 'apps', 'jarvis-desktop');
const USER = path.join('C:', 'Users', 'me', 'AppData', 'Roaming', 'Nox Assistant');
const fakeApp = (isPackaged) => ({ isPackaged, getPath: (name) => (name === 'userData' ? USER : assert.fail(name)) });

test('в разработке корень — папка репозитория, данные в её data/', () => {
  const root = projectRoot(fakeApp(false), APP);
  assert.equal(root, path.join('C:', 'repo'));
  assert.equal(path.join(root, 'data'), path.join('C:', 'repo', 'data'));
});

test('в установленном приложении данные идут в папку пользователя, не в папку программы', () => {
  const asar = path.join('C:', 'Programs', 'Nox Assistant', 'resources', 'app.asar');
  const root = projectRoot(fakeApp(true), asar);
  assert.equal(root, USER);
  assert.equal(path.join(root, 'data'), path.join(USER, 'data'));
});

test('скрипты Python берутся из распакованной копии, в разработке путь не меняется', () => {
  const res = path.join('C:', 'Programs', 'Nox Assistant', 'resources');
  assert.equal(unpacked(path.join(res, 'app.asar', 'scripts', 'tts', 'silero_server.py')),
    path.join(res, 'app.asar.unpacked', 'scripts', 'tts', 'silero_server.py'));
  const dev = path.join(APP, 'scripts', 'commands');
  assert.equal(unpacked(dev), dev);
});
