'use strict';

// Стиль ответов чата: правила в CHAT_REPLY_PROMPT (main.js) должны покрывать
// короткую квитанцию, частичный отчёт, «нет данных», источники, русский без англицизмов
// и запрет раскрывать модель/провайдера. main.js не загрузить без Electron — читаем исходник.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function blockOf(name) {
  const start = source.indexOf('const ' + name + ' = [');
  assert.ok(start >= 0, 'в main.js должен быть блок ' + name);
  const end = source.indexOf("].join('\\n');", start);
  assert.ok(end > start, 'блок ' + name + ' должен собираться через join');
  return source.slice(start, end);
}

const reply = blockOf('CHAT_REPLY_PROMPT');

test('ответ по умолчанию — 1–3 предложения, бытовой вопрос без воды', () => {
  assert.match(reply, /1[–-]3 предложения/);
  assert.match(reply, /бытов/i);
  assert.match(reply, /без заголовков|без вступлен/i);
});

test('квитанция о действии — короткий глагол результата', () => {
  assert.match(reply, /квитанц|глаголом результата/i);
  assert.match(reply, /Открыл/);
});

test('составная задача: что сделано, что не вышло, что не проверено', () => {
  assert.match(reply, /Сделано:/);
  assert.match(reply, /Не вышло:/);
  assert.match(reply, /Не проверено:/);
  assert.match(reply, /не пиши «открыл», «разложил», «готово» как факт/);
});

test('неизвестное — «Нет данных», а не догадка', () => {
  assert.match(reply, /«Нет данных»/);
  assert.match(reply, /Нельзя/);
  assert.match(reply, /Не подменяй ответ догадкой/);
});

test('никаких выдуманных источников: только ответы инструментов', () => {
  assert.match(reply, /Источники не выдумывай/);
  assert.match(reply, /только из ответов инструментов/);
});

test('русский без англицизмов, названия программ не переводятся', () => {
  assert.match(reply, /без английских слов и калек/);
  assert.match(reply, /обновление/);
  assert.match(reply, /апдейт/);
  assert.match(reply, /Названия программ, файлов, сайтов/);
  assert.match(reply, /русскими буквами, латиница только в названиях/);
});

test('модель и провайдер не раскрываются даже при прямом вопросе', () => {
  assert.match(reply, /Никогда не называй модель, провайдера/);
  assert.match(reply, /«Быстрая» или «Умная»/);
  assert.doesNotMatch(reply, /deepseek|openai|anthropic|gpt|gemini|claude|llama|qwen|minimax/i);
});

test('ложное «готово» запрещено, подтверждение — только verified: confirmed', () => {
  assert.match(reply, /verified: confirmed/);
  assert.match(reply, /эффект не проверен/);
  assert.match(reply, /Не своди частичный результат к слову «готово»/);
  assert.match(reply, /обязательно скажи «сделал, но не проверил»/);
  assert.match(reply, /не пиши «Открыл», «Сделал», «Готово» как факт/);
  assert.match(reply, /Чтение окон или списка после действия запуск не подтверждает/);
});

test('служебные идентификаторы и формат шагов не попадают в текст', () => {
  assert.match(reply, /внутренние имена инструментов \(например, app_open, remind_in, verified\)/);
  assert.match(reply, /служебного формата «Шаг 1»/);
});

test('ряд чисел — строкой, как в телеметрии', () => {
  assert.match(reply, /процессор 20%, память 61%/);
  assert.match(reply, /Отчёт о состоянии — не больше трёх предложений/);
});

test('нет пустого «проверю» перед инструментом', () => {
  assert.match(reply, /Не пиши заранее «проверю»/);
  assert.match(reply, /сразу вызывай инструмент/);
});

test('один уточняющий вопрос через clarify, без угадывания', () => {
  assert.match(reply, /один уточняющий вопрос/);
  assert.match(reply, /clarify/);
  assert.match(reply, /два или три коротких варианта/);
});

test('CHAT_REPLY_PROMPT входит в общий и в пространственный промпт', () => {
  assert.match(source, /const SYSTEM_PROMPT = \[[\s\S]*?CHAT_REPLY_PROMPT/);
  const occurrences = (source.match(/CHAT_REPLY_PROMPT,/g) || []).length;
  assert.ok(occurrences >= 2, 'CHAT_REPLY_PROMPT должен подключаться и в чате, и в пространствах');
});

test('правила чата не разрослись до простыни', () => {
  // Потолок поднят с 3200/14 после двух правил ночного набора: относительная громкость
  // (volume_get → расчёт → volume_set) и вопрос о последствиях действия. Правила короткие,
  // но их стало больше; потолок остаётся защитой от «простыни».
  assert.ok(reply.length < 3800, 'CHAT_REPLY_PROMPT короче 3800 символов, получено ' + reply.length);
  assert.ok((reply.match(/\n/g) || []).length <= 16, 'не больше 16 строк правил');
});
