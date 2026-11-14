'use strict';

// Локальные черновики писем: атомарное хранение на диске (или в памяти), готовые русские шаблоны,
// подсказки получателей без дубликатов и защита от случайной записи паролей/ключей.
// Черновики никогда не отправляют письма сами по себе.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { looksSecret, looksSecretEgress } = require('../memory/store');

const ADDRESS = /^[^\s@<>,;:"'()\\[\]]+@[^\s@<>,;:"'()\\[\]]+\.[^\s@<>,;:"'()\\[\]]+$/;
const MAX_DRAFTS = 200;
const MAX_SUBJECT = 300;
const MAX_BODY = 10000;
const MAX_ATTACHMENTS = 20;

const MAIL_TEMPLATES = [
  {
    id: 'встреча',
    title: 'Приглашение на встречу',
    subjectTemplate: 'Встреча: {{topic}}',
    bodyTemplate: [
      'Здравствуйте{{greetingName}}!',
      '',
      'Предлагаю обсудить тему «{{topic}}».',
      'Удобное время: {{when}}.',
      '{{details}}',
      '',
      'Подскажите, пожалуйста, подойдёт ли этот слот.',
    ].join('\n'),
    placeholders: ['topic', 'when', 'name', 'details'],
  },
  {
    id: 'уточнение',
    title: 'Запрос уточнений',
    subjectTemplate: 'Уточнение по теме: {{topic}}',
    bodyTemplate: [
      'Здравствуйте{{greetingName}}!',
      '',
      'Чтобы двигаться дальше по «{{topic}}», уточните, пожалуйста:',
      '{{questions}}',
      '',
      'Буду признателен за ответ, когда будет удобно.',
    ].join('\n'),
    placeholders: ['topic', 'name', 'questions'],
  },
  {
    id: 'документ',
    title: 'Сопроводительное письмо к документу',
    subjectTemplate: 'Документ: {{topic}}',
    bodyTemplate: [
      'Здравствуйте{{greetingName}}!',
      '',
      'Направляю материалы по теме «{{topic}}».',
      '{{summary}}',
      '',
      'Если потребуются правки или комментарии, дайте знать.',
    ].join('\n'),
    placeholders: ['topic', 'name', 'summary'],
  },
  {
    id: 'напоминание',
    title: 'Вежливое напоминание',
    subjectTemplate: 'Напоминание: {{topic}}',
    bodyTemplate: [
      'Здравствуйте{{greetingName}}!',
      '',
      'Напоминаю о вопросе «{{topic}}» ({{deadline}}).',
      '{{note}}',
      '',
      'Подскажите, пожалуйста, актуальный статус.',
    ].join('\n'),
    placeholders: ['topic', 'name', 'deadline', 'note'],
  },
  {
    id: 'спасибо',
    title: 'Благодарность',
    subjectTemplate: 'Спасибо: {{topic}}',
    bodyTemplate: [
      'Здравствуйте{{greetingName}}!',
      '',
      'Спасибо за помощь и время по вопросу «{{topic}}».',
      '{{nextStep}}',
    ].join('\n'),
    placeholders: ['topic', 'name', 'nextStep'],
  },
];

const TEMPLATE_MAP = new Map(MAIL_TEMPLATES.map((t) => [t.id, t]));

function containsSecret(value) {
  const s = String(value ?? '').trim();
  if (!s) return false;
  return looksSecret(s) || looksSecretEgress(s);
}

function normEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function findTemplate(templateId) {
  if (!templateId) return null;
  const key = String(templateId).trim().toLowerCase();
  return TEMPLATE_MAP.get(key) || null;
}

function renderTemplate(templateId, vars = {}) {
  const tpl = findTemplate(templateId);
  if (!tpl) return null;
  const cleanVars = vars && typeof vars === 'object' ? vars : {};
  const name = cleanVars.name ? String(cleanVars.name).trim() : '';
  const values = {
    greetingName: name ? `, ${name}` : '',
    topic: cleanVars.topic ? String(cleanVars.topic).trim() : '[тема]',
    when: cleanVars.when ? String(cleanVars.when).trim() : '[дата и время]',
    details: cleanVars.details ? String(cleanVars.details).trim() : '',
    questions: cleanVars.questions ? String(cleanVars.questions).trim() : '- [вопрос 1]',
    summary: cleanVars.summary ? String(cleanVars.summary).trim() : '',
    deadline: cleanVars.deadline ? String(cleanVars.deadline).trim() : 'без жёсткого срока',
    note: cleanVars.note ? String(cleanVars.note).trim() : '',
    nextStep: cleanVars.nextStep ? String(cleanVars.nextStep).trim() : '',
  };
  const fill = (src) => src
    .replace(/\{\{(\w+)\}\}/g, (_, k) => (Object.prototype.hasOwnProperty.call(values, k) ? values[k] : ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    templateId: tpl.id,
    title: tpl.title,
    subject: fill(tpl.subjectTemplate).slice(0, MAX_SUBJECT),
    body: fill(tpl.bodyTemplate).slice(0, MAX_BODY),
  };
}

function parseRecipientEntry(raw, source) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const angle = trimmed.match(/^(.+?)\s*<([^<>]+)>$/);
    if (angle) {
      const email = normEmail(angle[2]);
      const name = angle[1].trim().replace(/^["']|["']$/g, '');
      if (ADDRESS.test(email)) return { email, ...(name ? { name } : {}), source };
      return null;
    }
    const email = normEmail(trimmed);
    if (ADDRESS.test(email)) return { email, source };
    return null;
  }
  if (typeof raw === 'object') {
    const email = normEmail(raw.email || raw.address || raw.to);
    if (!ADDRESS.test(email)) return null;
    const name = raw.name ? String(raw.name).trim() : '';
    return { email, ...(name ? { name } : {}), source: raw.source || source };
  }
  return null;
}

function suggestRecipients({ knownRecipients = [], hints = [], query = '' } = {}) {
  const byEmail = new Map();
  const add = (entry) => {
    if (!entry || !ADDRESS.test(entry.email)) return;
    if (containsSecret(entry.email) || (entry.name && containsSecret(entry.name))) return;
    const existing = byEmail.get(entry.email);
    if (!existing) {
      byEmail.set(entry.email, entry);
      return;
    }
    if (!existing.name && entry.name) existing.name = entry.name;
    if (existing.source !== 'known' && entry.source === 'known') existing.source = 'known';
  };

  for (const item of Array.isArray(knownRecipients) ? knownRecipients : []) {
    add(parseRecipientEntry(item, 'known'));
  }
  for (const item of Array.isArray(hints) ? hints : []) {
    add(parseRecipientEntry(item, 'hint'));
  }

  let list = [...byEmail.values()];
  const q = String(query || '').trim().toLowerCase();
  if (q) {
    list = list.filter((r) => (
      r.email.includes(q) || (r.name && r.name.toLowerCase().includes(q))
    ));
  }
  return list;
}

function normalizeAttachments(rawList) {
  if (!Array.isArray(rawList) || rawList.length === 0) return [];
  const out = [];
  for (const raw of rawList.slice(0, MAX_ATTACHMENTS)) {
    let name = '';
    let note = '';
    if (typeof raw === 'string') {
      name = path.basename(raw.trim());
    } else if (raw && typeof raw === 'object') {
      const candidate = raw.name || raw.path || '';
      name = path.basename(String(candidate).trim());
      note = raw.note ? String(raw.note).trim().slice(0, 300) : '';
    }
    if (!name) continue;
    if (containsSecret(name) || containsSecret(note)) {
      throw new Error('вложение похоже на секрет или ключ, не сохраняю');
    }
    out.push({
      name: name.slice(0, 260),
      ...(note ? { note } : {}),
      status: 'noted_only',
    });
  }
  return out;
}

class MailDraftStore {
  constructor(filePath = null) {
    this.filePath = filePath || null;
    this._mem = { items: [] };
  }

  _load() {
    if (!this.filePath) return this._mem;
    try {
      if (!fs.existsSync(this.filePath)) return { items: [] };
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const items = Array.isArray(parsed && parsed.items) ? parsed.items : [];
      return { items };
    } catch {
      return { items: [] };
    }
  }

  _save(data) {
    if (!this.filePath) {
      this._mem = data;
      return;
    }
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  save({ id, to, subject, body, templateId, templateVars, attachments } = {}) {
    const rawTo = to !== undefined && to !== null ? String(to).trim() : '';
    const cleanTo = rawTo ? normEmail(rawTo) : '';
    if (cleanTo && !ADDRESS.test(cleanTo)) {
      throw new Error('неверный адрес получателя: нужен один адрес вида name@example.com');
    }

    let cleanSubject = subject !== undefined && subject !== null ? String(subject).trim().slice(0, MAX_SUBJECT) : '';
    let cleanBody = body !== undefined && body !== null ? String(body).trim().slice(0, MAX_BODY) : '';
    let usedTemplate = null;

    if (templateId) {
      const rendered = renderTemplate(templateId, templateVars);
      if (!rendered) throw new Error(`неизвестный шаблон письма: ${templateId}`);
      usedTemplate = rendered.templateId;
      if (!cleanSubject) cleanSubject = rendered.subject;
      if (!cleanBody) cleanBody = rendered.body;
    }

    const cleanAttachments = normalizeAttachments(attachments);

    if (!cleanTo && !cleanSubject && !cleanBody && !usedTemplate && cleanAttachments.length === 0) {
      throw new Error('пустой черновик: укажите адресата, тему, текст, шаблон или вложения');
    }

    if (containsSecret(cleanTo) || containsSecret(cleanSubject) || containsSecret(cleanBody)) {
      throw new Error('черновик похож на пароль, токен или ключ — не сохраняю');
    }

    const data = this._load();
    const nowIso = new Date().toISOString();
    const existingIdx = id ? data.items.findIndex((d) => d.id === id) : -1;
    const prev = existingIdx >= 0 ? data.items[existingIdx] : null;

    const draft = {
      id: prev ? prev.id : (id ? String(id).trim() : crypto.randomUUID()),
      to: cleanTo || (prev ? prev.to : ''),
      subject: cleanSubject || (prev && subject === undefined ? prev.subject : ''),
      body: cleanBody || (prev && body === undefined ? prev.body : ''),
      ...(usedTemplate ? { templateId: usedTemplate } : (prev && prev.templateId ? { templateId: prev.templateId } : {})),
      attachments: cleanAttachments.length > 0 || attachments !== undefined
        ? cleanAttachments
        : (prev && Array.isArray(prev.attachments) ? prev.attachments : []),
      createdAt: prev ? prev.createdAt : nowIso,
      updatedAt: nowIso,
    };

    if (existingIdx >= 0) data.items[existingIdx] = draft;
    else data.items.push(draft);

    if (data.items.length > MAX_DRAFTS) {
      data.items.splice(0, data.items.length - MAX_DRAFTS);
    }
    this._save(data);
    return { ...draft, attachments: draft.attachments.map((a) => ({ ...a })) };
  }

  list() {
    const { items } = this._load();
    return items
      .slice()
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .map((d) => ({ ...d, attachments: Array.isArray(d.attachments) ? d.attachments.map((a) => ({ ...a })) : [] }));
  }

  get(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    const hit = this._load().items.find((d) => d.id === key);
    return hit ? { ...hit, attachments: Array.isArray(hit.attachments) ? hit.attachments.map((a) => ({ ...a })) : [] } : null;
  }

  delete(id) {
    const key = String(id || '').trim();
    if (!key) return false;
    const data = this._load();
    const next = data.items.filter((d) => d.id !== key);
    if (next.length === data.items.length) return false;
    this._save({ items: next });
    return true;
  }
}

module.exports = {
  MailDraftStore,
  MAIL_TEMPLATES,
  renderTemplate,
  suggestRecipients,
  ADDRESS,
  containsSecret,
};
