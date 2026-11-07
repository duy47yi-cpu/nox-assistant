'use strict';

// Что команды библиотеки могут делать. Списки меняются только после живой проверки.
//
// Включено (ENABLED) — только то, что проверено живьём:
// - VERIFIED_SANDBOX: пишут или открывают только внутри песочницы;
// - VERIFIED_READONLY: только читают системную информацию, файлов не трогают.
// Остальные команды библиотеки выключены, даже если они не трогают файлы: их не проверяли.
//
// DISABLED — команды, которые обращаются за пределы песочницы или удаляют данные. Выключены по границам,
// а не по непроверенности. Правило: команда, которая читает или меняет файлы, должна быть в ENABLED
// (только песочница) или в DISABLED. Проверяет src/library/validator.js.
//
// Песочница передаётся скриптам через переменную окружения JARVIS_SANDBOX (её задаёт main.js).

// Проверено живьём: пишут или открывают только внутри песочницы.
const VERIFIED_SANDBOX = ['new_note', 'open_jarvis_notes', 'open_jarvis_workspace'];

// Проверено живьём 30.10.2026: только чтение данных компьютера, без файлов и без действий.
// Не входят network_status и wifi_status: их вывод искажён кодировкой (кракозябры), wifi_status ещё и
// отвечает «Ошибка» с кодом 0.
const VERIFIED_READONLY = ['time', 'date', 'battery', 'uptime', 'ram_usage', 'disk_space', 'ip_address', 'top_processes', 'running_apps'];

const ENABLED = [...VERIFIED_SANDBOX, ...VERIFIED_READONLY];

// Выключено по границам или по риску. Причины:
// - ходят за пределы песочницы (домашняя папка, Загрузки, Документы, Рабочий стол);
// - удаляют или перемещают данные;
// - сохраняют снимки вне песочницы (снимки по умолчанию не хранятся, см. JARVIS-DECISIONS J-7).
const DISABLED = [
  // Папки вне песочницы
  'open_downloads', 'open_documents', 'open_desktop',
  'count_files', 'folder_size', 'disk_free', 'recent_downloads', 'large_files',
  'find_duplicates', 'find_file', 'file_info', 'read_text_file', 'rename_bulk_preview',
  'new_folder', 'zip_folder', 'unzip_here', 'open_file',
  // Удаление и перемещение данных
  'sort_downloads_by_type', 'clean_temp', 'empty_downloads_old', 'empty_recycle_bin',
  // Снимки экрана на диск вне песочницы
  'screenshot',
];

// Признаки обращения к файлам. Если скрипт совпал хотя бы с одним, он обязан быть в ENABLED или DISABLED.
// shutil.disk_usage — запрос к томам, не работа с файлами: в список не входит.
const FILE_ACCESS = [
  /\bexpanduser\b/,
  /USERPROFILE|OneDrive|Documents|Downloads|Desktop|Рабочий|Загрузки|Документы/,
  /\bopen\(/,
  /\bshutil\.(copy\w*|move|rmtree|make_archive|unpack_archive)\b/,
  /\bos\.(walk|listdir|remove|unlink|rename|mkdir|makedirs|scandir)\b/,
  /\bglob\./,
  /\bzipfile\b/,
  /\brmtree\b/,
];

// Абсолютный путь в тексте скрипта. Ловим и прямые слэши, и обратные:
// иначе путь вида C:\Users\... проходит незамеченным.
const ABSOLUTE_PATH = /[A-Za-z]:[\\/][^'"\s]*/g;
// Проверенные скрипты получают песочницу из переменной окружения (её задаёт main.js),
// поэтому абсолютных путей в них быть не должно вовсе: путь на диске владельца им неизвестен.
const SANDBOX_ENV = 'JARVIS_SANDBOX';

function touchesFiles(source) {
  return FILE_ACCESS.some((re) => re.test(source));
}

function absolutePaths(source) {
  return (source.match(ABSOLUTE_PATH) || []).map((p) => p.replace(/\+$/, ''));
}

module.exports = {
  VERIFIED_SANDBOX, VERIFIED_READONLY, ENABLED, DISABLED,
  touchesFiles, absolutePaths, SANDBOX_ENV,
};
