'use strict';

// Подбор инструментов под задачу: модель видит ядро и только те группы, что нужны разговору.
// Короче запрос — быстрее ответ. Скрытый инструмент остаётся в реестре: политика и запуск не меняются.
// Группа открывается по словам владельца или по уже вызванным действиям и держится, пока они в хвосте истории:
// состав меняется редко, чтобы не сбивать кэш запроса.

const GROUPS = [
  {
    id: 'hands',
    tool: /^(ui_|mouse_)|^(desktop_click|desktop_type|wait_for)$/,
    // Посмотрел на экран или открыл программу — дальше, скорее всего, нужны руки.
    after: /^(desktop_observe|screen_look|screen_region_look|app_open|windows_focus)$/,
    words: /нажм|нажат|клик|щ[её]лк|введи|ввод|напечата|набери|впиши|кнопк|пол[ея]\b|окн|галочк|флаж|меню|вкладк|прокрут|листа|перетащ|блокнот|настройк|проводник|экран|программ|приложени|рабоч\S+ стол|открой|запусти|закрой|выбери|сохрани|click|type|press/i,
  },
  {
    id: 'browser',
    tool: /^browser_/,
    after: /^url_open$/,
    words: /сайт|страниц|браузер|вкладк|логин|войди|войти|аккаунт|зарегистр|форм[аеуы]\b|https?:|www\.|\.(ru|com|org|net|io)\b|закаж|корзин|ютуб|youtube|вконтакт|телеграм|telegram|whatsapp|онлайн|лайк|коммент|пост/i,
  },
  {
    id: 'documents',
    tool: /^(document_|presentation_open$)/,
    words: /документ|word|ворд|excel|эксел|таблиц|pdf|пдф|презентац|слайд|pptx|docx|xlsx|csv|диплом|справк|договор|резюме|шаблон/i,
  },
  {
    id: 'project',
    tool: /^project_/,
    words: /проект|сборк|собери|тест|npm|git|код|репозитор|скрипт|журнал ошибок|\.log\b|диагност/i,
  },
  {
    id: 'commands',
    tool: /^command_/,
    words: /команд|сценари|горяч|макрос|хоткей|по фразе/i,
  },
  {
    id: 'missions',
    tool: /^(mission_|long_task_|task_)/,
    words: /кажд\S+ (день|утро|вечер|час|недел)|расписани|мисси|задач|в фоне|фонов|долг\S+ (работ|поручени)|поручени|ежедневн|по утрам|по вечерам|регулярно|пока меня нет|без меня/i,
  },
  {
    id: 'mail',
    tool: /^mail_/,
    words: /почт|письм|mail|gmail|\S+@\S+/i,
  },
  {
    id: 'apps',
    tool: /^(app_search|app_install|apps_)/,
    words: /установ|скача|программ|приложени|winget|что у меня стоит|какие игры/i,
  },
  {
    id: 'layout',
    tool: /^(windows_snap|windows_arrange|organize_workspace|restore_workspace)$/,
    words: /окн|расклад|расстав|половин|разверн|сверн|рядом|слева|справа/i,
  },
];

// Сколько последних сообщений истории решают, какие группы открыты.
const TAIL = 40;

function groupOf(name) {
  const group = GROUPS.find((g) => g.tool.test(name));
  return group ? group.id : null;
}

// Какие группы открыты для этого разговора: по словам владельца и по недавно вызванным действиям.
function openGroups(history) {
  const open = new Set();
  const tail = (Array.isArray(history) ? history : []).slice(-TAIL);
  for (const message of tail) {
    if (message.role === 'user' && !message.fromTool && typeof message.content === 'string') {
      for (const g of GROUPS) if (g.words.test(message.content)) open.add(g.id);
    }
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const name = String((call.function && call.function.name) || call.name || '');
      const own = groupOf(name);
      if (own) open.add(own);
      for (const g of GROUPS) if (g.after && g.after.test(name)) open.add(g.id);
    }
  }
  return open;
}

// Список инструментов для запроса: ядро (всё, что не в группах, включая MCP) и открытые группы. Порядок прежний.
function visibleTools(list, history) {
  const open = openGroups(history);
  return list.filter((tool) => {
    const group = groupOf(tool.name);
    return !group || open.has(group);
  });
}

module.exports = { GROUPS, groupOf, openGroups, visibleTools };
