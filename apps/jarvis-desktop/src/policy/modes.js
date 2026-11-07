'use strict';

// Детерминированная политика: решение зависит только от режима, риска и аргументов.
// Вердикты: 'allow' | 'ask' | 'deny'. Владелец решил не отказывать, а спрашивать; 'deny' остаётся как возможность.
//
// Решение владельца (01.11.2026):
// - оплата запрещена всегда, в любом режиме: платит владелец сам;
// - явно запрошенные владельцем удаление и установка разрешены в «Полном доступе»;
// - отправка (письмо, отчёт, сообщение) — по режиму: в «Полном доступе» без вопроса;
// - в «Полном доступе» жёсткие запреты на почту, банк и мессенджеры не действуют: иначе отправка невозможна.
//
// Честная оговорка: гарантия «удаление спросит» касается инструментов удаления.
// Команда в PowerShell или клик в чужом окне удалить могут и обходят её, поэтому команды в фоне закрыты целиком
// (см. src/tools/profiles.js), а в чате «Полный доступ» команду на удаление выполняет без вопроса.

const path = require('path');
const { saidByOwner } = require('../tools/memory');
const { looksSecretEgress } = require('../memory/store');
const { isEgress, isHandsAction } = require('./taint');

const RISKS = new Set(['T0', 'T1', 'T2', 'T3']);
// Инструменты, которые могут обратиться за пределы песочницы: их вызовы всегда подтверждаются.
const UNBOUNDED_TOOLS = new Set(['shell_run', 'library_run']);
// Необратимо или за пределами владельца: каждый вызов — отдельное согласие, без «на сессию».
// Нажатие и ввод в браузере тоже: номер элемента на другой странице значит другое.
const ONE_SHOT_TOOLS = /(^|_)(send|publish|delete|remove|post|upload|push)(_|$)|^browser_(click|type)$/i;

// Оплата: запрещена всегда. Признак — слово в названии инструмента: у инструментов из внешних сервисов
// другого признака нет. В команде PowerShell те же слова опаснее: 'subscribe' и 'order' там обычные слова
// (Subscribe-Object, Sort-Object), поэтому в команде берём только однозначные.
const PAY_TOOL_NAME = /(^|_)(charge|checkout|subscribe|order|pay|payment|transfer|purchase|buy)(_|$)/i;
const PAY_SHELL = /\b(checkout|payment|transfer|purchase|charge)\b|stripe|paypal|оплат/i;
// Git checkout — смена ветки/файлов, а не платёж. Исключение применяем только
// к отдельной простой команде, без конвейеров, подстановок и других команд.
const PLAIN_GIT_CHECKOUT = /^\s*git(?:\.exe)?\s+(?:-C\s+(?:"[^";|&`$<>\r\n]*"|'[^';|&`$<>\r\n]*'|[^\s;|&`$<>\r\n]+)\s+)?checkout(?:\s+[^;|&`$<>\r\n]+)?\s*$/i;
// Кнопка оплаты в окне: ловим по названию элемента, а не по вводимому тексту — в тексте письма слово «оплата» обычное.
// «Оформить заказ» и похожие формы добавляем только парой слов: одно «оформить» или «заказ» встречается
// и в безопасных кнопках («Оформить», «Заказать звонок»), поэтому по отдельности их не ловим.
const PAY_ELEMENT = /(оплат|купить|покупк|подписк|оформить\s+(?:заказ|покупк)|подтверд\S*\s+заказ|checkout|\bpay\b|\bbuy\b|\bsubscribe\b|\btransfer\b|\bplace\s+(?:the\s+)?order\b|\bcomplete\s+(?:the\s+)?(?:order|purchase)\b)/i;
// Сайт оплаты: отдельный адрес — верный признак платежа.
const PAY_BROWSER_HOST = /stripe|paypal|klarna|checkout|qiwi|yoomoney/i;
// Удаление: прямой запрос владельца в полном доступе обрабатывается отдельно.
const DELETE_TOOL_NAME = /(^|_)(delete|remove|trash|erase|purge|wipe|unlink)(_|$)/i;

// Имя из внешнего сервиса бывает в camelCase или через дефис и точку: делим на слова через «_»,
// чтобы ни префикс сервера, ни запись не прятали слово оплаты, удаления или отправки.
const toolWords = (name) => String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_');

// Внешние инструменты обычно требуют разрешения в настройках; прямая просьба отправить письмо
// конкретному адресу дополнительно обрабатывается в decide. ownerAllowed проверяет белый список.
const EXTERNAL_SOURCES = new Set(['mcp', 'mail']);
// Виды памяти, которые читаются всегда и не протухают (src/tools/memory.js).
const PINNED_MEMORY_KINDS = new Set(['profile', 'agreement']);

function isOneShot(name) {
  return ONE_SHOT_TOOLS.test(toolWords(name));
}

const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// Относительный путь считается от рабочей папки. Сравнение по префиксу с разделителем,
// чтобы 'D:\\ws2' не попадал в 'D:\\ws'.
// У переноса и копии два пути (from и to): проверяются оба, иначе в авто путь назначения вне папки пройдёт.
function insideWorkspace(args, workspace) {
  if (!args || typeof workspace !== 'string' || workspace === '') return false;
  const keys = args.from !== undefined || args.to !== undefined ? ['from', 'to'] : ['path'];
  const root = fold(path.resolve(workspace));
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return keys.every((k) => {
    if (typeof args[k] !== 'string' || args[k] === '') return false;
    const target = fold(path.resolve(root, args[k]));
    return target === root || target.startsWith(prefix);
  });
}

// Ключ одобрения «на сессию»: имя инструмента и его аргументы. Изменились аргументы — ключ другой,
// и нужно новое подтверждение.
function allowKey(name, args) {
  return `${String(name)}|${JSON.stringify(sortKeys(args || {}))}`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => { acc[k] = sortKeys(value[k]); return acc; }, {});
  }
  return value;
}

// sessionAllow — Set или массив ключей allowKey, одобренных «на сессию».
function inSession(sessionAllow, name, args) {
  if (!sessionAllow || !name) return false;
  const key = allowKey(name, args);
  return typeof sessionAllow.has === 'function' ? sessionAllow.has(key) : sessionAllow.includes(key);
}

// Чувствительные действия: удаление файлов, отправка сообщений, оплаты и переводы. В «Полном доступе» не спрашиваем;
// в остальных режимах спрашиваем (а не отказываем).
const HARD_TOOL_NAME = /(^|_)(delete|remove|send|pay|payment|transfer|purchase|buy)(_|$)/i;
const HARD_SHELL = /Remove-Item|\bdel\b|\berase\b|\brmdir\b|\brd\b|Send-MailMessage|sendmail|smtp|checkout|payment/i;
const HARD_WINDOW = /telegram|ayugram|whatsapp|discord|viber|gmail|outlook|почта|mail\.ru|сбер|тинькофф|tinkoff|альфа-банк|банк|bank|wallet|кошел|paypal|оплат/i;
const HARD_UI = new Set(['mouse_click', 'mouse_scroll', 'windows_focus', 'ui_focus', 'ui_type', 'ui_keys', 'ui_click', 'ui_set_toggle']);

// Браузер: у вызова только номер элемента, поэтому адрес сверяется с открытой страницей.
const HARD_BROWSER = new Set(['browser_click', 'browser_type']);
const HARD_BROWSER_HOST = /mail|outlook|proton|bank|sber|tinkoff|tbank|alfa|vtb|paypal|wallet|qiwi|yoomoney|telegram|whatsapp|discord/i;
let browserHost = () => '';
function setBrowserHost(source) {
  browserHost = source;
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return String(url || ''); // не адрес: пусть проверяется как есть, чтобы не пройти молча
  }
}

// Признак оплаты в вызове инструмента. Оплата запрещена всегда, поэтому проверка идёт по всем признакам сразу.
function isPayment({ name, args } = {}) {
  const n = String(name || '');
  if (PAY_TOOL_NAME.test(toolWords(n))) return true;
  if (n === 'shell_run') {
    const command = String((args && args.command) || '');
    if (!PLAIN_GIT_CHECKOUT.test(command) && PAY_SHELL.test(command)) return true;
  }
  // Название элемента окна: кнопка «Оплатить».
  if (HARD_UI.has(n) && args && typeof args.name === 'string' && PAY_ELEMENT.test(args.name)) return true;
  if (HARD_BROWSER.has(n) && PAY_BROWSER_HOST.test(String(browserHost()))) return true;
  return false;
}

// Удаление и перезапись в чужом окне: кнопка по имени или окно подтверждения замены файла.
// Кнопка «Да» в окне без такого заголовка так не распознаётся — это честный предел проверки по тексту.
const DELETE_ELEMENT = /удал|корзин|перезапис|заменить|\bdelete\b|\bremove\b|\breplace\b|overwrite|\btrash\b/i;
const REPLACE_WINDOW = /подтвер\S*\s+сохранен|подтвер\S*\s+замен|confirm save|replace or skip|замена или пропуск/i;

// Признак удаления: инструмент удаляет что-то без возможности отмены.
function isDeletion({ name, args } = {}) {
  if (DELETE_TOOL_NAME.test(toolWords(name))) return true;
  if (!HARD_UI.has(String(name || '')) || !args) return false;
  if ((typeof args.name === 'string' && DELETE_ELEMENT.test(args.name)) || REPLACE_WINDOW.test(String(args.window || ''))) return true;
  // Сохранение редактируемого файла — запись; решение о ней принимает режим доступа.
  return false;
}

// Установка программ и пакетов: прямой запрос владельца в полном доступе обрабатывается отдельно.
const INSTALL_TOOL_NAME = /(^|_)(install|uninstall|setup)(_|$)/i;
const INSTALL_SHELL = /\b(winget|choco|scoop)\s+(install|upgrade|uninstall)\b|msiexec|Install-(Package|Module)|Add-AppxPackage|\bnpm\s+(i|install)\s+-g\b|\bpip3?\s+install\b/i;

// Драйверы и обновления Windows — изменение системы: команды и кнопки установки тоже спрашиваются.
const SYSTEM_CHANGE_SHELL = /\bpnputil\b[^\n]*\/(add-driver|install|delete-driver|scan-devices|restart-device|remove-device|disable-device|enable-device)|\bdevcon\b[^\n]*\b(update|install|remove|rescan|enable|disable|restart)\b|\b(Install|Update|Enable|Disable)-\w*(Driver|WindowsUpdate|PnpDevice)\b|\bInstall-\w+|\bwusa\b|UsoClient\b[^\n]*\b(StartInstall|ScanInstallWait|RestartDevice|StartDownload)\b|\bDISM\b[^\n]*\/(add-driver|add-package|remove-driver)/i;
const INSTALL_ELEMENT = /установ|обновить драйвер|скачать и|перезагрузить сейчас|\binstall\b|update driver|restart now|download and/i;

function isInstall({ name, args } = {}) {
  if (INSTALL_TOOL_NAME.test(toolWords(name))) return true;
  const n = String(name || '');
  if (n === 'shell_run') return INSTALL_SHELL.test(String((args && args.command) || '')) || SYSTEM_CHANGE_SHELL.test(String((args && args.command) || ''));
  return HARD_UI.has(n) && n !== 'ui_type' && Boolean(args) && typeof args.name === 'string' && INSTALL_ELEMENT.test(args.name);
}

// Выключение, перезагрузка, выход из системы: инструмент, команда или кнопка.
const POWER_SHELL = /\b(Restart|Stop)-Computer\b|\bshutdown(\.exe)?\b[^\n]*(\/|-)(r|s|p|g|h|l|f)\b|Win32Shutdown|\.(Reboot|Shutdown)\s*\(|\bwmic\b[^\n]*\bos\b[^\n]*\b(reboot|shutdown)\b|ExitWindowsEx|\blogoff(\.exe)?\b/i;
const POWER_ELEMENT = /перезагруз|завершение работы|выключение|выключить компьютер|выход из системы|выйти из системы|\brestart\b|shut ?down|sign out/i;
// Удаление командой PowerShell (инструменты удаления по имени и так спрашивают всегда, см. isDeletion).
const SHELL_DELETE = /Remove-Item|\b(del|erase|rmdir|rd|rm|ri)\b\s|\[System\.IO\.(File|Directory)\]::Delete|Clear-RecycleBin|\.Delete\s*\(/i;

function isPowerOff({ name, args } = {}) {
  const n = String(name || '');
  if (n === 'pc_shutdown') return true;
  if (n === 'shell_run') return POWER_SHELL.test(String((args && args.command) || ''));
  return HARD_UI.has(n) && n !== 'ui_type' && Boolean(args) && typeof args.name === 'string' && POWER_ELEMENT.test(args.name);
}

function isShellDeletion({ name, args } = {}) {
  return String(name || '') === 'shell_run' && SHELL_DELETE.test(`${String((args && args.command) || '')} `);
}

// Прямая просьба владельца: только повелительное слово действия в его сообщении этого хода.
// Существительные («перезагрузка», «удаление», «установка») командой не считаются:
// «сколько длится перезагрузка» или «обсуди удаление файла» — не просьба выполнить действие.
// Английские delete/remove/install/restart оставлены только для явных команд (см. ownerAsked).
const OWNER_WORDS = {
  power: ['перезагрузи', 'перезагрузите', 'перезагрузить', 'выключи', 'выключите', 'выключить', 'restart', 'reboot', 'shutdown'],
  delete: ['удали', 'удалите', 'удалить', 'сотри', 'сотрите', 'стереть', 'delete', 'remove'],
  install: ['установи', 'установите', 'установить', 'install'],
};
// Вежливые слова, которые могут стоять перед повелительным глаголом в начале предложения или клаузы.
const OWNER_LEAD_WORDS = new Set(['пожалуйста', 'please', 'ну', 'давай', 'теперь', 'джарвис', 'нокс', 'nox']);
// Вопрос, обсуждение, цитата или пересылка чужой команды — не просьба выполнить действие.
const OWNER_TALK = /(?:^|[^\p{L}\p{N}])(?:что\s+такое|сколько|почему|зачем|можно\s+ли|как\s+мне|объясн[\p{L}\p{N}]*|расскаж[\p{L}\p{N}]*|покаж[\p{L}\p{N}]*|подскаж[\p{L}\p{N}]*|обсуд[\p{L}\p{N}]*|обсуж[\p{L}\p{N}]*|провер[\p{L}\p{N}]*|напиш[\p{L}\p{N}]*|перешл[\p{L}\p{N}]*|цитат[\p{L}\p{N}]*|инструкц[\p{L}\p{N}]*|пример[\p{L}\p{N}]*|how\s+to|what\s+is|what's|explain|discuss|tell\s+me|show\s+me)(?:$|[^\p{L}\p{N}])/iu;
// Текст в кавычках — цитата, а не команда. Вырезаем её перед проверкой начала фразы,
// чтобы «удали "D:/docs/a.txt"» оставалось командой, а «"перезагрузи компьютер"» — нет.
const OWNER_QUOTED = /«[^»]*»|“[^”]*”|"[^"]*"|'[^']*'|`[^`]*`/g;

// Повелительный глагол стоит первым словом предложения/клаузы (впереди допустимы вежливые слова).
function ownerImperative(kind, ownerText) {
  const words = OWNER_WORDS[kind];
  if (!words) return false;
  const bare = String(ownerText || '').toLowerCase().replace(/ё/g, 'е').replace(OWNER_QUOTED, ' ');
  return bare.split(/[.!?;\n]+/).some((clause) => {
    const tokens = clause.match(/[\p{L}\p{N}]+/gu) || [];
    let i = 0;
    while (i < tokens.length && OWNER_LEAD_WORDS.has(tokens[i])) i += 1;
    return i < tokens.length && words.includes(tokens[i]);
  });
}

function ownerAsked(kind, ownerText) {
  const text = String(ownerText || '');
  // Вопрос — не просьба: «Удали файл?» спрашиваем.
  if (text.includes('?')) return false;
  // Условные и отрицательные поручения нельзя считать безусловным разрешением по одному глаголу.
  if (/(?:^|[^\p{L}\p{N}])(не|нельзя|запрещаю|спроси|подтверждения|разрешения|согласия|если|когда|потом|позже|сначала|после)(?:$|[^\p{L}\p{N}])/iu.test(text)) return false;
  // Обсуждение, вопрос, цитата или пересылка чужой команды — не просьба выполнить действие сейчас.
  if (OWNER_TALK.test(text)) return false;
  return ownerImperative(kind, text);
}

// Пока нет проверенной связи между фразой и найденным объектом, учитываем только
// явно указанную полную цель. Совпадение части пути или wildcard не подходит.
function ownerNamedTarget(ownerText, target) {
  if (typeof target !== 'string' || !target.trim() || /[*?]/.test(target)) return false;
  const text = String(ownerText || '').toLocaleLowerCase();
  const value = target.trim().toLocaleLowerCase();
  let from = 0;
  while (true) {
    const index = text.indexOf(value, from);
    if (index < 0) return false;
    const pathChar = /[\p{L}\p{N}_./\\:-]/u;
    if ((!index || !pathChar.test(text[index - 1])) && (index + value.length === text.length || !pathChar.test(text[index + value.length]))) return true;
    from = index + 1;
  }
}

// Относительный путь владельца отсчитывается от рабочей папки, в которой
// запускается shell_run. Не сокращаем вложенный путь до одного имени файла.
function ownerNamedWorkspaceTarget(ownerText, target, workspace) {
  if (ownerNamedTarget(ownerText, target)) return true;
  if (typeof target !== 'string' || /[*?]/.test(target) || !path.isAbsolute(target)
      || typeof workspace !== 'string' || !path.isAbsolute(workspace)) return false;
  const relative = path.relative(workspace, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  return ownerNamedTarget(String(ownerText || '').replace(/\\/g, '/'), relative.replace(/\\/g, '/'));
}

// Разрешаем сопоставить с просьбой только простое удаление одного явно названного
// пути. Составные команды и выражения PowerShell остаются на подтверждении.
function ownerNamedShellDelete(ownerText, command, workspace) {
  if (typeof command !== 'string') return false;
  if (ownerNamedTarget(ownerText, command)) return true;
  const match = /^\s*Remove-Item\s+(?:-(?:LiteralPath|Path)\s+)?(?:'([^']+)'|"([^"]+)"|([^\s'";|&`$(){}]+))(?:\s+-(?:Force|Recurse))*\s*$/i.exec(command);
  if (!match) return false;
  const target = match[1] || match[2] || match[3];
  if (/[*?`$;|&(){}\[\]]/.test(target)) return false;
  return ownerNamedWorkspaceTarget(ownerText, target, workspace);
}

// Имя должно относиться к просьбе установить, а не к другому действию в той же фразе.
function ownerAskedInstallTarget(ownerText, target) {
  if (typeof target !== 'string' || !target.trim()) return false;
  const clean = (s) => String(s).toLocaleLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}.+_-]+/gu, ' ').trim();
  const value = clean(target);
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`(?:^| )(?:установи|установите|установить|install) +(?:(?:мне|пожалуйста|программу|приложение|браузер|пакет|please|the|app|package) +)*${escaped}(?= |$|\\.(?: |$))`, 'u');
  return expression.test(clean(ownerText || ''));
}

// Исключение для прямой просьбы отправить одному явно указанному адресату.
// Не выводим адрес из письма, страницы или из неоднозначного поручения.
function ownerAskedMail(ownerText, args) {
  const text = String(ownerText || '');
  const target = typeof args?.to === 'string' ? args.to.trim().toLowerCase() : '';
  if (/(?:^|[^\p{L}\p{N}])(?:не|нельзя|запрещаю|если|когда|спроси|подтверждения|согласия)(?:$|[^\p{L}\p{N}])/iu.test(text)) return false;
  if (!/(?:^|[^\p{L}\p{N}])(?:отправь|отправьте|отправить|пошли|пошлите|send)(?:$|[^\p{L}\p{N}])/iu.test(text)) return false;
  const addresses = text.match(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu) || [];
  return addresses.length === 1 && addresses[0].toLowerCase() === target;
}

// Почему действие ограничено: показываем владельцу и в вопросе, и в отказе.
function describe({ name, args } = {}) {
  if (isPayment({ name, args })) return 'оплату делает владелец сам';
  if (isDeletion({ name, args })) return 'удаление: отменить может быть невозможно';
  if (isInstall({ name, args })) return 'установка программы: подтверждая, вы соглашаетесь с её лицензией';
  if (isPowerOff({ name, args })) return 'выключение или перезагрузка компьютера: несохранённое в программах пропадёт';
  if (isShellDeletion({ name, args })) return 'удаление файлов командой: отменить нельзя';
  return null;
}

// Причина запрета или null. Не зависит от режима.
function hardDeny({ name, args }) {
  const n = String(name || '');
  if (HARD_TOOL_NAME.test(toolWords(n))) return `запрет: ${n} (удаление, отправка, оплата — только с владельцем)`;
  if (n === 'shell_run' && HARD_SHELL.test(String((args && args.command) || ''))) {
    return 'запрет: команда удаляет файлы, отправляет почту или платит';
  }
  if (HARD_UI.has(n) && HARD_WINDOW.test(String((args && args.window) || ''))) {
    return 'запрет: ввод в окне почты, мессенджера или банка';
  }
  if (HARD_BROWSER.has(n) && HARD_BROWSER_HOST.test(String(browserHost()))) {
    return 'запрет: действие на сайте почты, мессенджера или банка';
  }
  // Браузер хранит входы владельца: чужая страница не должна заставить молча прочитать его почту или банк.
  if (n === 'browser_open' && HARD_BROWSER_HOST.test(hostOf(args && args.url))) return 'запрет: чтение сайта почты, мессенджера или банка';
  if ((n === 'browser_read' || n === 'browser_scroll') && HARD_BROWSER_HOST.test(String(browserHost()))) return 'запрет: чтение сайта почты, мессенджера или банка';
  return null;
}

// Чувствительное: удаление, отправка сообщений, оплаты и переводы. Решение владельца (31.10.2026):
// в «Спрашивать» и «Авто» на такие действия спрашиваем каждый раз, а не отказываем.
function isSensitive({ name, args } = {}) {
  return hardDeny({ name, args }) !== null;
}

// Секрет в исходящем: письмо, команда, ввод в браузере, ссылка или буфер. Спрашиваем даже в «Полном доступе»:
// пароль и ключ не должны уйти наружу по невнимательности. Это вопрос, а не отказ: владелец подтвердит.
const SECRET_EGRESS_TOOLS = new Set(['mail_send', 'shell_run', 'browser_type', 'url_open', 'clipboard_set']);
function hasSecretEgress({ name, args } = {}) {
  if (!SECRET_EGRESS_TOOLS.has(name)) return false;
  try {
    return looksSecretEgress(JSON.stringify(args || {}));
  } catch {
    return true; // не смогли проверить — спрашиваем
  }
}

// Решение политики. Правило владельца:
// «Полный доступ» — прямые просьбы владельца разрешены; оплата запрещена, внешние источники проверяются отдельно.
// «Спрашивать» — как ручной режим Claude Code: чтение и поиск сразу, любое действие, которое что-то меняет,
// спрашиваем (кроме уже разрешённого «на сессию»).
// «Авто» — как авторежим Claude Code: чтение и правки внутри рабочей папки сразу, остальное спрашиваем.
function decide({ mode, name, risk, args, workspace, sessionAllow, hasPathParam = true, source, ownerAllowed = false, ownerText = '', ownerCommand = false, tainted = false, handsTainted = false, installEvidence = null } = {}) {
  // Оплата запрещена всегда: платит владелец сам.
  if (isPayment({ name, args })) return 'deny';
  // Для удаления и установки без прямой просьбы требуется подтверждение.
  if (isDeletion({ name, args }) && !(mode === 'full' && (ownerCommand || (ownerAsked('delete', ownerText) && ownerNamedWorkspaceTarget(ownerText, args && args.path, workspace))))) return 'ask';
  const searchMatches = name === 'app_install' && installEvidence && args && typeof args.id === 'string'
    && typeof installEvidence.id === 'string' && installEvidence.id.toLowerCase() === args.id.trim().toLowerCase()
    && ownerAskedInstallTarget(ownerText, installEvidence.query);
  const explicitInstall = name === 'shell_run' ? ownerNamedTarget(ownerText, args && args.command) : ownerAskedInstallTarget(ownerText, args && args.id);
  if (isInstall({ name, args }) && !(mode === 'full' && (ownerCommand || (ownerAsked('install', ownerText) && (explicitInstall || searchMatches))))) return 'ask';
  // В полном доступе прямое поручение владельца разрешает отправку указанному адресату.
  const directMail = mode === 'full' && name === 'mail_send' && source === 'mail' && ownerAskedMail(ownerText, args);
  const selectedCommand = mode === 'full' && ownerCommand === true;
  if (EXTERNAL_SOURCES.has(source) && ownerAllowed !== true && !directMail && !selectedCommand) return 'ask';
  // Заражение контекста: если в этом ходу уже читали страницу, экран или файл, исходящее действие
  // в «Полном доступе» спрашиваем. Владелец подтвердит, если это его настоящая просьба.
  if (tainted && isEgress(name)) return 'ask';
  // Чужой текст и руки: клик или ввод после чужой страницы/файла могут выполнить чужое указание
  // (например, нажать «Отправить» в чужом окне). В «Полном доступе» спрашиваем, владелец подтвердит.
  if (handsTainted && isHandsAction(name)) return 'ask';
  // Секрет в исходящем аргументе — тоже вопрос в любом режиме.
  if (hasSecretEgress({ name, args })) return 'ask';
  // Намеренное ужесточение (03.11.2026): профиль и договорённость попадают в каждый промпт, поэтому их запись
  // спрашивается в любом режиме и каждый раз: иначе текст сайта мог бы закрепиться в памяти навсегда.
  // Исключение (03.11.2026): текст записи целиком из сообщения владельца в этом ходу — это его слова, не сайта.
  if (name === 'remember' && PINNED_MEMORY_KINDS.has(args && args.kind) && !saidByOwner(args.text, ownerText)) return 'ask';
  // Решение владельца (05.11.2026): в «Полном доступе» выключение, перезагрузка и удаление командой спрашиваются,
  // кроме случая, когда владелец сам прямо попросил это в своём сообщении этого хода (ownerText — только его слова из чата).
  if (mode === 'full') {
    const kind = isPowerOff({ name, args }) ? 'power' : isShellDeletion({ name, args }) ? 'delete' : null;
    if (kind && !ownerCommand && (!ownerAsked(kind, ownerText) || (kind === 'delete' && !ownerNamedShellDelete(ownerText, args && args.command, workspace)))) return 'ask';
    return 'allow';
  }
  if (isSensitive({ name, args })) return 'ask';
  if (mode === 'ask') {
    if (risk === 'T0') return 'allow';
    return inSession(sessionAllow, name, args) ? 'allow' : 'ask';
  }
  // Авто-умный: отправка, публикация и удаление — каждый раз отдельно; «на сессию» не распространяется.
  if (isOneShot(name)) return 'ask';
  if (UNBOUNDED_TOOLS.has(name)) return inSession(sessionAllow, name, args) ? 'allow' : 'ask';
  if (inSession(sessionAllow, name, args)) return 'allow';
  if (!RISKS.has(risk)) return 'ask';
  if (mode === 'auto') {
    if (risk === 'T0') return 'allow';
    // Лишний аргумент path у инструмента без пути не считается: иначе им открывалось бы что угодно.
    if (risk === 'T1') return hasPathParam && insideWorkspace(args, workspace) ? 'allow' : 'ask';
    return 'ask';
  }
  return 'ask';
}

module.exports = { decide, insideWorkspace, hardDeny, isSensitive, allowKey, isOneShot, setBrowserHost, RISKS, isPayment, isDeletion, isInstall, isPowerOff, isShellDeletion, hasSecretEgress, describe };
