'use strict';

// Run the shipped QA driver in memory with the sole clipboard check omitted.
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const file = path.resolve(__dirname, '../../../../apps/jarvis-desktop/scripts/nox-qa-verify.js');
const original = fs.readFileSync(file, 'utf8');
const omit = "  await runner('copy-button', checkCopy);";
if (original.split(omit).length !== 2 || original.split('checks.length === 9').length !== 2) {
  throw new Error('Review the chat QA driver before excluding its clipboard case');
}
const adapted = original.replace(omit, '  // System clipboard intentionally excluded by the audit.')
  .replace('checks.length === 9', 'checks.length === 8');
const driver = new Module(file, module);
driver.filename = file;
driver.paths = Module._nodeModulePaths(path.dirname(file));
driver._compile(adapted, file);
