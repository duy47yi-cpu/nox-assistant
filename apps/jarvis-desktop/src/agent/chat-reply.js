'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { maskSecretText } = require('../journal/journal');

const ARTIFACT_WRITERS = new Set(['document_write', 'document_fill', 'workspace_write']);
const ARTIFACT_EXTENSIONS = new Set(['.pptx', '.xlsx', '.csv', '.docx', '.pdf', '.md', '.txt']);
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const ACTION_LABELS = {
  app_open: 'Открытие программы', app_close: 'Закрытие программы',
  document_write: 'Создание документа', document_fill: 'Заполнение документа',
  presentation_open: 'Открытие презентации', workspace_write: 'Запись файла',
  workspace_move: 'Перенос файла', workspace_copy: 'Копирование файла', workspace_mkdir: 'Создание папки',
  url_open: 'Открытие сайта', browser_open: 'Открытие сайта', mail_send: 'Отправка письма',
  windows_focus: 'Переключение окна', windows_arrange: 'Раскладка окон',
  windows_minimize_all: 'Сворачивание окон', windows_restore_all: 'Возврат окон',
  windows_close_all: 'Закрытие окон', window_close_active: 'Закрытие окна',
  ui_click: 'Нажатие', ui_type: 'Ввод текста', youtube_play: 'Запуск видео',
};

const CLARIFY_SPEC = {
  type: 'function',
  function: {
    name: 'clarify',
    description: 'Задать один уточняющий вопрос, если без ответа нельзя выбрать нужное действие. Дай два или три коротких варианта ответа владельца. Вызывай отдельно, без текста и других инструментов.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', minLength: 1, maxLength: 240 },
        options: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 64 } },
      },
      required: ['question', 'options'],
    },
  },
};

function compactText(value, limit) {
  return typeof value === 'string' ? maskSecretText(value).replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function clarificationFrom(args) {
  const question = compactText(args?.question, 240);
  if (!question || question.replace(/\?$/, '').includes('?') || !Array.isArray(args?.options) || args.options.length < 2 || args.options.length > 3) return null;
  const options = args.options.map((value) => compactText(value, 64));
  if (options.some((value) => !value) || new Set(options.map((value) => value.toLocaleLowerCase('ru-RU'))).size !== options.length) return null;
  return { question: question.endsWith('?') ? question : `${question}?`, options };
}

// Для карточек чата и действий по ним принимаем только обычные файлы в рабочей папке.
function artifactFile(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 1024) return null;
  if (/[\\<>:"|?*\x00-\x1f]/.test(relativePath) || !ARTIFACT_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) return null;
  const parts = relativePath.split('/');
  if (parts.some((part) => !part || part.startsWith('.') || /[. ]$/.test(part) || RESERVED_NAME.test(part))) return null;
  try {
    let file = fs.realpathSync(root);
    let stat;
    for (const part of parts) {
      file = path.join(file, part);
      stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) return null;
    }
    const real = fs.realpathSync(file);
    const samePath = process.platform === 'win32' ? real.toLowerCase() === file.toLowerCase() : real === file;
    return samePath && stat.isFile() ? { file: real, size: stat.size } : null;
  } catch {
    return null;
  }
}

function artifactFrom(root, tool, result) {
  if (!ARTIFACT_WRITERS.has(tool) || result?.ok !== true || result.verified !== 'confirmed') return null;
  const relativePath = result.data?.path;
  if (maskSecretText(relativePath) !== relativePath) return null;
  const info = artifactFile(root, relativePath);
  if (!info) return null;
  const { slides, rows } = result.data;
  return {
    path: relativePath, name: path.basename(relativePath), size: info.size,
    ...(Number.isSafeInteger(slides) && slides > 0 ? { slides } : {}),
    ...(Number.isSafeInteger(rows) && rows >= 0 ? { rows } : {}),
  };
}

function actionReport({ name, step, target, status, result, hideDetails }) {
  const action = ACTION_LABELS[name] || `Шаг ${step}`;
  const value = hideDetails ? '' : compactText(target?.name || target?.app || target?.path || target?.file || target?.url || target?.window || target?.to || target?.query, 100);
  const label = value ? `${action} «${value}»` : action;
  if (status === 'succeeded') return { status: 'done', label };
  const unknown = status === 'unverified';
  const details = hideDetails ? '' : compactText((unknown && result?.evidence) || result?.summary, 200);
  return {
    status: unknown ? 'unverified' : 'failed', label,
    reason: details || (unknown ? 'Результат не подтверждён' : 'Действие не выполнено'),
  };
}

function partialReport(actions) {
  return actions.some((action) => action.status === 'done') && actions.some((action) => action.status !== 'done') ? actions : null;
}

// Наблюдение — это не действие: у снимка экрана, списка окон и чтения файла проверки эффекта
// нет, поэтому их «не проверено» не понижает итог хода. Иначе подтверждённый клик рядом с
// обязательным снимком экрана превращался в «Не подтверждено» — ровно то, что видел владелец.
// Автоснимки (args.auto) исключены так же: это служебное наблюдение, а не шаг руками.
const READ_ONLY_STATUS_ACTIONS = new Set([
  'screen_look', 'screen_region_look', 'desktop_observe', 'ui_windows', 'ui_elements',
  'windows_list', 'ui_wait', 'wait_for', 'browser_read', 'browser_tab_read', 'browser_tabs',
  'browser_snapshot', 'image_look', 'image_read_text', 'clipboard_get',
  'workspace_read', 'workspace_list', 'workspace_search', 'document_read', 'document_batch',
  'code_read', 'web_search', 'web_wiki', 'web_fetch', 'web_research', 'web_check_claims',
]);

// Чтение или автоснимок: такой шаг не может понизить итог хода до «не подтверждено».
function isReadOnlyStatusTool(name, args) {
  if (args && typeof args === 'object' && args.auto === true) return true;
  const tool = String(name || '');
  return READ_ONLY_STATUS_ACTIONS.has(tool) || /^read_/.test(tool);
}

// Есть ли среди шагов действие (не чтение и не автоснимок), оставшееся без подтверждения.
function hasUnverifiedAction(entries) {
  return (Array.isArray(entries) ? entries : []).some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.status !== 'unverified') return false;
    return !isReadOnlyStatusTool(entry.tool, entry.args);
  });
}

function verifiedReceipt(text, actions) {
  const bareReceipt = /^\s*(?:\*\*)?(?:(?:всё|все) (?:готово|сделано|выполнено)|готово|сделано|выполнено)[.!]?(?:\*\*)?[.!]?\s*$/iu;
  if (!bareReceipt.test(text) || !actions.some((action) => action.status !== 'done')) return null;
  if (partialReport(actions)) return 'Часть действий выполнена.';
  return actions.some((action) => action.status === 'failed')
    ? 'Не удалось выполнить поручение.' : 'Результат действий подтвердить не удалось.';
}

// Служебные следы инструментов в тексте ответа: имена инструментов и формат «Шаг N (…)».
// Модель иногда пересказывает протокол, а владельцу нужен человеческий текст.
function stripServiceTokens(text, toolNames = []) {
  let out = String(text == null ? '' : text);
  if (!out) return out;
  const names = [...new Set((Array.isArray(toolNames) ? toolNames : []).filter((x) => typeof x === 'string' && x.trim()))]
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('[ \\t]*\\(?' + escaped + '\\)?[ \\t]*', 'gi'), ' ');
  }
  // «Шаг 1 (remind_in):» или «Шаг 3 —» — служебный формат, в ответе владельцу ему не место.
  out = out.replace(/[ \t]*[-—–:]?[ \t]*Шаг[ \t]+\d+[ \t]*\([^)]*\)[ \t]*[:—–-]?[ \t]*/gi, ' ');
  out = out.replace(/[ \t]*[-—–:]?[ \t]*Шаг[ \t]+\d+[ \t]*[:—–-]?[ \t]*/gi, ' ');
  out = out.replace(/\bverified[ \t]*:[ \t]*[a-z_]+/gi, '');
  out = out.replace(/[ \t]*\([ \t]*\)/g, '');
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/[ \t]+([.,;:!?])/g, '$1');
  out = out.replace(/^[ \t.,;:—-]+|([.,;:!?])[ \t]*([.,;:!?])/g, (m, a, b) => (a && b ? b : ''));
  return out.trim();
}


// Хвост про кнопку в ответе на вопрос о последствиях: «если скажете, где кнопка — уточню»,
// «зависит от того, что за кнопка». Владелец спрашивал о последствиях, а не просил искать кнопку,
// поэтому такие предложения убираем из конца ответа. Действуем только на вопрос о последствиях,
// в обычных ответах текст не трогаем.
const CONSEQUENCE_QUESTION = /что\s+будет\s*,?\s*если.*(нажм|удал|оплат|отправ|установ|очист|снест|запуст)|какие\s+последствия/i;
const BUTTON_TAIL = /(где|что\s+за|какая|какую|назов|скажите|уточн|подскаж|если\s+скажете).{0,50}кнопк|кнопк.{0,50}(где|что\s+за|назов|скажите|уточн|подскаж)/i;
function stripButtonLocationTail(text, ownerText = '') {
  const out = String(text == null ? '' : text);
  const ask = String(ownerText == null ? '' : ownerText);
  if (!out.trim() || !CONSEQUENCE_QUESTION.test(ask)) return out;
  const sentences = out.split(/(?<=[.!?])\s+/u);
  const kept = sentences.filter((sentence) => !BUTTON_TAIL.test(sentence));
  if (kept.length === sentences.length || !kept.length) return out;
  const cleaned = kept.join(' ').replace(/\s{2,}/g, ' ').trim();
  return cleaned || out;
}

module.exports = {
  CLARIFY_SPEC, clarificationFrom, artifactFile, artifactFrom, actionReport, partialReport, verifiedReceipt,
  READ_ONLY_STATUS_ACTIONS, isReadOnlyStatusTool, hasUnverifiedAction, stripServiceTokens, stripButtonLocationTail,
};
