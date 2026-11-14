'use strict';

// Картинки в рабочей папке: image_read_text читает текст встроенным распознаванием Windows,
// image_look отдаёт модели само изображение — так она понимает схемы, фотографии и графики,
// где одного текста мало. Файлы — только внутри рабочей папки, сканы PDF сюда не входят.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runPowerShell } = require('./system');
const { insideWorkspace } = require('../policy/modes');

const MAX_TEXT = 6000;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff']);
// Сколько байт картинки готовы отправить модели. 8 МБ хватает скриншоту или фотографии;
// больше — уже не картинка для разговора, а большой файл, и честнее отказать.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// Эти форматы модель понимает как есть: отдаём байты без перевода.
const LOOK_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);
// BMP и TIFF модель не принимает: переводим в JPEG встроенным средством Windows.
const CONVERT_EXT = new Set(['.bmp', '.tif', '.tiff']);
const LOOK_EXT = new Set([...LOOK_MIME.keys(), ...CONVERT_EXT]);
const MIME_TITLE = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/gif': 'GIF' };

// Путь передаётся через переменную окружения, вывод — в UTF-8.
const OCR_SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like "IAsyncOperation*" })[0]',
  'Function Await($op, $type) { $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }',
  '[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null',
  '$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:JARVIS_IMG)) ([Windows.Storage.StorageFile])',
  '$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
  '$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
  '$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
  '$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
  'if (-not $engine) { "NO_ENGINE"; exit 1 }',
  '$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
  '$lines = @($result.Lines | ForEach-Object { $text = ($_.Words | ForEach-Object { $_.Text }) -join " "; [pscustomobject]@{ text = $text; x = [math]::Round($_.BoundingRect.X); y = [math]::Round($_.BoundingRect.Y); width = [math]::Round($_.BoundingRect.Width); height = [math]::Round($_.BoundingRect.Height) } }); ConvertTo-Json -InputObject $lines -Depth 4 -Compress',
].join('\n');

// Постраничный OCR сканов PDF встроенным движком Windows: путь и лимит страниц передаются только через env.
const PDF_OCR_SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like "IAsyncOperation*" })[0]',
  '$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncAction" })[0]',
  'Function Await($op, $type) { $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }',
  'Function AwaitAction($op) { $t = $asTaskAction.Invoke($null, @($op)); $t.Wait(-1) | Out-Null }',
  '[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null',
  '$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
  'if (-not $engine) { [pscustomobject]@{ status = "no_engine"; pageCount = 0; pages = @() } | ConvertTo-Json -Compress; exit 0 }',
  '$maxPages = 15',
  'if ($env:JARVIS_PDF_MAX_PAGES) { [void][int]::TryParse($env:JARVIS_PDF_MAX_PAGES, [ref]$maxPages) }',
  'if ($maxPages -lt 1) { $maxPages = 1 }',
  'try {',
  '  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:JARVIS_PDF)) ([Windows.Storage.StorageFile])',
  '  $pdf = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])',
  '} catch {',
  '  $msg = $_.Exception.ToString()',
  '  $st = if ($msg -match "password|0x80070056|0x8007052b|decrypt") { "password" } else { "error" }',
  '  [pscustomobject]@{ status = $st; pageCount = 0; pages = @(); error = $_.Exception.Message } | ConvertTo-Json -Compress',
  '  exit 0',
  '}',
  '$total = [int]$pdf.PageCount',
  'if ($total -le 0) { [pscustomobject]@{ status = "empty"; pageCount = 0; pages = @() } | ConvertTo-Json -Compress; exit 0 }',
  '$limit = [Math]::Min($total, $maxPages)',
  '$pages = @()',
  'for ($i = 0; $i -lt $limit; $i++) {',
  '  $page = $null; $stream = $null; $bitmap = $null',
  '  try {',
  '    $page = $pdf.GetPage([uint32]$i)',
  '    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream',
  '    AwaitAction ($page.RenderToStreamAsync($stream))',
  '    $stream.Seek(0)',
  '    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
  '    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
  '    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
  '    $lines = @($result.Lines | ForEach-Object { ($_.Words | ForEach-Object { $_.Text }) -join " " })',
  '    $txt = ($lines -join "`n").Trim()',
  '    if ($txt) { $pages += [pscustomobject]@{ page = ($i + 1); text = $txt } }',
  '  } finally {',
  '    if ($bitmap -is [System.IDisposable]) { $bitmap.Dispose() }',
  '    if ($stream -is [System.IDisposable]) { $stream.Dispose() }',
  '    if ($page -is [System.IDisposable]) { $page.Dispose() }',
  '  }',
  '}',
  '$status = if ($pages.Count -gt 0) { "ok" } else { "empty" }',
  '[pscustomobject]@{ status = $status; pageCount = $total; pages = $pages } | ConvertTo-Json -Depth 4 -Compress',
].join('\n');

const VALID_PDF_OCR_STATUSES = new Set(['ok', 'no_engine', 'password', 'empty', 'error']);

async function ocrPdfFile(absPath, { runner = runPowerShell, signal, maxPages = 15, timeoutMs = 90000 } = {}) {
  if (!absPath || typeof absPath !== 'string') {
    return { status: 'error', pageCount: 0, pages: [], error: 'не указан путь к PDF' };
  }
  const limit = Math.max(1, Math.min(50, Math.floor(Number(maxPages) || 15)));
  try {
    const res = await runner(
      PDF_OCR_SCRIPT,
      { JARVIS_PDF: absPath, JARVIS_PDF_MAX_PAGES: String(limit) },
      { signal, timeoutMs, maxOutput: 131072 },
    );
    const out = String((res && res.data && res.data.stdout) || '').trim();
    if (!out) {
      return {
        status: 'error',
        pageCount: 0,
        pages: [],
        error: (res && res.summary) || 'пустой ответ OCR PDF',
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch {
      return {
        status: 'error',
        pageCount: 0,
        pages: [],
        error: (res && !res.ok && res.summary) ? res.summary : 'не удалось разобрать ответ OCR PDF',
      };
    }
    const rawPages = Array.isArray(parsed?.pages) ? parsed.pages : parsed?.pages ? [parsed.pages] : [];
    const pages = rawPages
      .map((p) => ({
        page: Number(p && p.page),
        text: String((p && p.text) || '').trim(),
      }))
      .filter((p) => Number.isInteger(p.page) && p.page >= 1 && p.text.length > 0);
    let status = VALID_PDF_OCR_STATUSES.has(parsed?.status) ? parsed.status : 'error';
    if (status === 'ok' && pages.length === 0) status = 'empty';
    const pageCount = Math.max(0, Number(parsed?.pageCount) || pages.length);
    const result = { status, pageCount, pages };
    if (parsed?.error) result.error = String(parsed.error);
    else if (!res?.ok && status === 'error' && res?.summary) result.error = res.summary;
    return result;
  } catch (err) {
    return {
      status: 'error',
      pageCount: 0,
      pages: [],
      error: err && err.message ? err.message : String(err),
    };
  }
}

// Пути источника и результата — через переменные окружения, как в снимке экрана (src/tools/screen.js).
// System.Drawing читает BMP и TIFF и сохраняет JPEG: внешние программы не нужны.
const CONVERT_SCRIPT = [
  'Add-Type -AssemblyName System.Drawing',
  '$img = [System.Drawing.Image]::FromFile($env:JARVIS_LOOK_SRC)',
  'try { $img.Save($env:JARVIS_LOOK_OUT, [System.Drawing.Imaging.ImageFormat]::Jpeg) } finally { $img.Dispose() }',
].join('; ');

// Размер понятным языком: владелец не должен считать байты.
function humanBytes(n) {
  const size = Number(n) || 0;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
  if (size >= 1024) return `${Math.round(size / 1024)} КБ`;
  return `${size} Б`;
}

// Путь текстом и lstat не видят junction-папку в середине пути: она выглядит обычной папкой.
// realpath сверяет настоящий путь файла с настоящим путём рабочей папки, чтобы картинка
// не ушла за границу через такую папку.
function realInside(abs, root) {
  if (!root) return false;
  // Корень не разрешается (например, проверка с подменным runner без настоящей папки):
  // текстовой проверки insideWorkspace достаточно, файла внутри несуществующего корня всё равно нет.
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { return true; }
  try {
    const real = fs.realpathSync(abs);
    const rel = path.relative(realRoot, real);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

// Успешный ответ «смотрю картинку»: в image — то, что цикл агента отправит модели (поле image),
// в data — сведения для журнала и истории.
function lookedAt(rel, mime, bytes, convertedFrom = null) {
  const what = convertedFrom
    ? `перевёл ${convertedFrom === '.bmp' ? 'BMP' : 'TIFF'} в JPEG, смотрю: ${rel}`
    : `смотрю ${MIME_TITLE[mime] || mime}: ${rel}`;
  return {
    ok: true,
    summary: `${what}, ${humanBytes(bytes.length)}`,
    data: { path: rel, mime, bytes: bytes.length },
    image: `data:${mime};base64,${bytes.toString('base64')}`,
  };
}

function imageTools({ runner = runPowerShell, workspace = null } = {}) {
  return [
    {
      name: 'image_read_text',
      description: 'Прочитать текст с картинки (PNG, JPG, BMP, TIFF) из рабочей папки. Скриншоты, фото документов, интерфейсы. PDF-сканы не читает.',
      risk: 'T1',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', minLength: 1, maxLength: 1024 } },
        required: ['path'],
      },
      async run(args, ctx = {}) {
        const rel = String((args && args.path) || '');
        const root = (ctx && ctx.workspace) || workspace;
        if (!rel) return { ok: false, summary: 'не указан путь к картинке', data: {} };
        if (!IMAGE_EXT.has(path.extname(rel).toLowerCase())) return { ok: false, summary: 'это не картинка (нужен PNG, JPG, BMP или TIFF)', data: {} };
        if (!insideWorkspace({ path: rel }, root)) return { ok: false, summary: 'картинка вне рабочей папки', data: {} };
        const abs = path.resolve(root, rel);
        if (!realInside(abs, root)) return { ok: false, summary: 'картинка вне рабочей папки: путь уводит за неё через ссылку', data: {} };
        const res = await runner(OCR_SCRIPT, { JARVIS_IMG: abs }, { signal: ctx && ctx.signal, timeoutMs: 60000 });
        if (!res.ok) return { ok: false, summary: res.summary, data: {} };
        const out = String((res.data && res.data.stdout) || '').trim();
        if (out === 'NO_ENGINE') return { ok: false, summary: 'в Windows не установлено распознавание для вашего языка', data: {} };
        let lines;
        try { const parsed = JSON.parse(out || '[]'); lines = Array.isArray(parsed) ? parsed : [parsed]; }
        catch { lines = out ? [{ text: out, x: 0, y: 0, width: 0, height: 0 }] : []; }
        lines = lines.filter((line) => line && typeof line.text === 'string').slice(0, 200);
        const text = lines.map((line) => line.text).join('\n').slice(0, MAX_TEXT);
        const ocrStatus = text ? 'recognized' : 'empty';
        return {
          ok: true,
          summary: text ? `распознано ${text.length} символов в ${lines.length} строках; координаты строк сохранены` : 'текста на картинке не нашёл',
          data: { text, lines, lineCount: lines.length, ocrStatus, path: rel },
        };
      },
    },
    {
      name: 'image_look',
      description: 'Посмотреть картинку из рабочей папки: модель видит само изображение (PNG, JPG, WebP, GIF; BMP и TIFF переводятся в JPEG). Для схем, фотографий, графиков и ошибок на скриншоте, где нужен смысл, а не только текст. Текст с картинки — image_read_text.',
      risk: 'T1',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', minLength: 1, maxLength: 1024 } },
        required: ['path'],
      },
      async run(args, ctx = {}) {
        const rel = String((args && args.path) || '');
        const root = (ctx && ctx.workspace) || workspace;
        if (!rel) return { ok: false, summary: 'не указан путь к картинке', data: {} };
        const ext = path.extname(rel).toLowerCase();
        if (!LOOK_EXT.has(ext)) return { ok: false, summary: 'это не картинка (нужен PNG, JPG, WebP, GIF, BMP или TIFF)', data: {} };
        if (!insideWorkspace({ path: rel }, root)) return { ok: false, summary: 'картинка вне рабочей папки', data: {} };
        const abs = path.resolve(root, rel);
        // lstat: смотрим саму запись, а не её цель. Ссылка может увести за пределы рабочей папки,
        // поэтому ссылку не открываем, даже если она указывает внутрь.
        let st;
        try { st = fs.lstatSync(abs); }
        catch { return { ok: false, summary: `картинка не найдена: ${rel}`, data: {} }; }
        if (st.isSymbolicLink()) return { ok: false, summary: 'это ссылка, а не обычный файл: картинку через ссылку не смотрю', data: {} };
        if (!st.isFile()) return { ok: false, summary: 'это не обычный файл: папка или другое', data: {} };
        // Junction-папка в середине пути не видна ни проверке пути, ни lstat: сверяем настоящий путь.
        if (!realInside(abs, root)) return { ok: false, summary: 'картинка вне рабочей папки: путь уводит за неё через ссылку', data: {} };
        if (st.size > MAX_IMAGE_BYTES) {
          return { ok: false, summary: `картинка больше 8 МБ (${humanBytes(st.size)}): такую модель не примет`, data: {} };
        }
        // Прямые форматы: читаем байты и отдаём как есть.
        if (LOOK_MIME.has(ext)) {
          let bytes;
          try { bytes = fs.readFileSync(abs); }
          catch { return { ok: false, summary: `не удалось прочитать картинку: ${rel}`, data: {} }; }
          return lookedAt(rel, LOOK_MIME.get(ext), bytes);
        }
        // BMP и TIFF: временный файл JPEG создаётся рядом с системными временными и удаляется сразу после чтения.
        // Дискового кэша у инструмента нет: каждый вызов переводит картинку заново.
        const out = path.join(os.tmpdir(), `jarvis-look-${crypto.randomUUID()}.jpg`);
        try {
          const res = await runner(CONVERT_SCRIPT, { JARVIS_LOOK_SRC: abs, JARVIS_LOOK_OUT: out }, { signal: ctx && ctx.signal, timeoutMs: 30000 });
          if (!res || !res.ok || !fs.existsSync(out)) {
            const why = (res && res.summary) || 'после перевода нет файла';
            return { ok: false, summary: `не удалось перевести ${ext === '.bmp' ? 'BMP' : 'TIFF'} в JPEG: ${why}`, data: {} };
          }
          const bytes = fs.readFileSync(out);
          if (bytes.length > MAX_IMAGE_BYTES) {
            return { ok: false, summary: `после перевода в JPEG картинка больше 8 МБ (${humanBytes(bytes.length)}): такую модель не примет`, data: {} };
          }
          return lookedAt(rel, 'image/jpeg', bytes, ext);
        } catch (err) {
          return { ok: false, summary: `не удалось перевести картинку в JPEG: ${err.message}`, data: {} };
        } finally {
          fs.rmSync(out, { force: true });
        }
      },
    },
  ];
}

module.exports = {
  imageTools,
  ocrPdfFile,
  OCR_SCRIPT,
  PDF_OCR_SCRIPT,
  CONVERT_SCRIPT,
  MAX_TEXT,
  MAX_IMAGE_BYTES,
  IMAGE_EXT,
  LOOK_EXT,
};
