'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('после хода не появляется предложение сохранить его как команду', () => {
  for (const file of ['main.js', 'renderer/app.js', 'renderer/tools-extra.css']) {
    assert.doesNotMatch(read(file), /command_suggest|suggestCommand|command-suggest|openSuggestedCommand/i, file);
  }
  assert.doesNotMatch(read('main.js'), /observeTurnEvent|turnTrace|noSuggest/);
});
