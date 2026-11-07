'use strict';

// image_look: картинка из рабочей папки уходит модели полем image (data:image/...;base64).
// Проверки на временных папках: прямые форматы, границы рабочей папки, ссылки, размер,
// перевод BMP в JPEG подменным runner и удаление временного файла.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { imageTools, CONVERT_SCRIPT, MAX_IMAGE_BYTES } = require('../src/tools/ocr');

// Настоящие байты-заголовки: инструмент их не разбирает, но модель получает именно файл.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const WEBP = Buffer.from('RIFF\x1a\x00\x00\x00WEBPVP8 ', 'binary');

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Рабочая папка и инструмент по имени: порядок инструментов в наборе не должен ломать тест.
function setup({ runner = async () => ({ ok: false, summary: 'runner не нужен' }) } = {}) {
  const root = tempDir('jarvis-look-');
  const tool = imageTools({ runner, workspace: root }).find((t) => t.name === 'image_look');
  assert.ok(tool, 'image_look есть в наборе инструментов');
  return { root, tool };
}

const look = (tool, file, ctx = {}) => tool.run({ path: file }, ctx);

test('image_look: PNG и JPEG уходят модели как data:image', async () => {
  const { root, tool } = setup();
  fs.writeFileSync(path.join(root, 'shot.png'), PNG);
  const png = await look(tool, 'shot.png');
  assert.equal(png.ok, true);
  assert.equal(png.data.path, 'shot.png');
  assert.equal(png.data.mime, 'image/png');
  assert.equal(png.data.bytes, PNG.length);
  assert.match(png.image, /^data:image\/png;base64,/);
  assert.deepEqual(Buffer.from(png.image.split(',')[1], 'base64'), PNG);
  assert.match(png.summary, /PNG/);
  assert.match(png.summary, /shot\.png/);

  fs.writeFileSync(path.join(root, 'photo.jpeg'), JPEG);
  const jpg = await look(tool, 'photo.jpeg');
  assert.equal(jpg.ok, true);
  assert.equal(jpg.data.mime, 'image/jpeg');
  assert.match(jpg.image, /^data:image\/jpeg;base64,/);
  assert.deepEqual(Buffer.from(jpg.image.split(',')[1], 'base64'), JPEG);
});

test('image_look: WebP и GIF тоже идут напрямую, без перевода', async () => {
  const { root, tool } = setup();
  fs.writeFileSync(path.join(root, 'pic.webp'), WEBP);
  const webp = await look(tool, 'pic.webp');
  assert.equal(webp.ok, true);
  assert.equal(webp.data.mime, 'image/webp');
  assert.match(webp.image, /^data:image\/webp;base64,/);

  fs.writeFileSync(path.join(root, 'anim.gif'), Buffer.from('GIF89a\x01\x00\x01\x00', 'binary'));
  const gif = await look(tool, 'anim.gif');
  assert.equal(gif.ok, true);
  assert.equal(gif.data.mime, 'image/gif');
  assert.match(gif.image, /^data:image\/gif;base64,/);
});

test('image_look: картинка вне рабочей папки отклоняется', async () => {
  const { tool } = setup();
  const outside = tempDir('jarvis-look-out-');
  const secret = path.join(outside, 'secret.png');
  fs.writeFileSync(secret, PNG);

  const absolute = await look(tool, secret);
  assert.equal(absolute.ok, false);
  assert.match(absolute.summary, /вне рабочей папки/);
  assert.equal(absolute.image, undefined);

  const relative = await look(tool, '../secret.png');
  assert.equal(relative.ok, false);
  assert.match(relative.summary, /вне рабочей папки/);
  assert.equal(relative.image, undefined);
});

test('image_look: ссылка вместо обычного файла отклоняется, даже если ведёт внутрь папки', async (t) => {
  const { root, tool } = setup();
  fs.writeFileSync(path.join(root, 'real.png'), PNG);
  const link = path.join(root, 'link.png');
  try {
    fs.symlinkSync(path.join(root, 'real.png'), link, 'file');
  } catch (err) {
    return t.skip(`ОС не дала создать ссылку на файл: ${err.code || err.message}`);
  }
  const res = await look(tool, 'link.png');
  assert.equal(res.ok, false);
  assert.match(res.summary, /ссылка/);
  assert.equal(res.image, undefined);
});

test('image_look: не картинка, папка и несуществующий файл — понятный отказ', async () => {
  const { root, tool } = setup();
  fs.writeFileSync(path.join(root, 'notes.txt'), 'привет');
  const txt = await look(tool, 'notes.txt');
  assert.equal(txt.ok, false);
  assert.match(txt.summary, /не картинка/);

  const pdf = await look(tool, 'scan.pdf');
  assert.equal(pdf.ok, false);
  assert.match(pdf.summary, /не картинка/);

  fs.mkdirSync(path.join(root, 'folder.png'));
  const dir = await look(tool, 'folder.png');
  assert.equal(dir.ok, false);
  assert.match(dir.summary, /не обычный файл/);

  const missing = await look(tool, 'nope.png');
  assert.equal(missing.ok, false);
  assert.match(missing.summary, /не найдена/);
});

test('image_look: картинка больше 8 МБ не читается', async () => {
  const { root, tool } = setup();
  const big = path.join(root, 'big.png');
  fs.writeFileSync(big, PNG);
  // Разрежённый файл: размер за пределом, а на диск почти ничего не пишется.
  fs.truncateSync(big, MAX_IMAGE_BYTES + 1);
  const res = await look(tool, 'big.png');
  assert.equal(res.ok, false);
  assert.match(res.summary, /больше 8 МБ/);
  assert.equal(res.image, undefined);
});

test('image_look: BMP переводится в JPEG подменным runner, временный файл удаляется', async () => {
  const root = tempDir('jarvis-look-bmp-');
  let srcPath = null;
  let outPath = null;
  const runner = async (script, env) => {
    assert.equal(script, CONVERT_SCRIPT);
    srcPath = env.JARVIS_LOOK_SRC;
    outPath = env.JARVIS_LOOK_OUT;
    // Подменный runner «переводит» картинку: кладёт по адресу результата валидный JPEG.
    fs.writeFileSync(outPath, JPEG);
    return { ok: true, summary: 'готово', data: { stdout: '' } };
  };
  const tool = imageTools({ runner, workspace: root }).find((t) => t.name === 'image_look');
  const bmp = path.join(root, 'схема.bmp');
  fs.writeFileSync(bmp, Buffer.from([0x42, 0x4d, 0x00, 0x00]));

  const res = await tool.run({ path: 'схема.bmp' }, { workspace: root });
  assert.equal(res.ok, true);
  assert.equal(srcPath, bmp);
  assert.ok(outPath && outPath.toLowerCase().endsWith('.jpg'), 'результат перевода — временный .jpg');
  assert.equal(res.data.path, 'схема.bmp');
  assert.equal(res.data.mime, 'image/jpeg');
  assert.deepEqual(Buffer.from(res.image.split(',')[1], 'base64'), JPEG);
  assert.match(res.summary, /BMP/);
  assert.equal(fs.existsSync(outPath), false, 'временный JPEG удалён');
  assert.equal(fs.existsSync(bmp), true, 'исходный BMP не тронут');
});

test('image_look: ошибка runner при переводе — отказ без картинки и без временного файла', async () => {
  const root = tempDir('jarvis-look-fail-');
  let outPath = null;
  const runner = async (script, env) => {
    outPath = env.JARVIS_LOOK_OUT;
    return { ok: false, summary: 'код выхода 1', data: { stderr: 'нет доступа' } };
  };
  const tool = imageTools({ runner, workspace: root }).find((t) => t.name === 'image_look');
  fs.writeFileSync(path.join(root, 'фото.bmp'), Buffer.from([0x42, 0x4d, 0x00, 0x00]));

  const res = await tool.run({ path: 'фото.bmp' }, { workspace: root });
  assert.equal(res.ok, false);
  assert.equal(res.image, undefined);
  assert.match(res.summary, /JPEG/);
  assert.match(res.summary, /код выхода 1/);
  assert.ok(outPath);
  assert.equal(fs.existsSync(outPath), false);
});

test('image_look: рабочая папка берётся из ctx, запасная — из конструктора', async () => {
  const fallback = tempDir('jarvis-look-fallback-');
  const scoped = tempDir('jarvis-look-scoped-');
  const tool = imageTools({ runner: async () => ({ ok: false, summary: 'runner не нужен' }), workspace: fallback }).find((t) => t.name === 'image_look');
  fs.writeFileSync(path.join(scoped, 'pic.png'), PNG);

  const fromCtx = await look(tool, 'pic.png', { workspace: scoped });
  assert.equal(fromCtx.ok, true);
  assert.equal(fromCtx.data.path, 'pic.png');

  const fromConstructor = await look(tool, 'pic.png', {});
  assert.equal(fromConstructor.ok, false);
  assert.match(fromConstructor.summary, /не найдена/);
});

test('image_look: junction-папка наружу не открывает чужие картинки', async (t) => {
  const outside = tempDir('jarvis-look-junction-out-');
  fs.writeFileSync(path.join(outside, 'secret.png'), PNG);
  const root = tempDir('jarvis-look-junction-in-');
  let runnerCalls = 0;
  const tools = imageTools({ runner: async () => { runnerCalls += 1; return { ok: false, summary: 'runner не нужен' }; }, workspace: root });
  const link = path.join(root, 'камера');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch (err) {
    return t.skip(`ОС не дала создать junction: ${err.code || err.message}`);
  }
  const lookTool = tools.find((tool) => tool.name === 'image_look');
  const res = await lookTool.run({ path: 'камера/secret.png' });
  assert.equal(res.ok, false, 'картинка за junction не должна открываться');
  assert.match(res.summary, /вне рабочей папки/);
  assert.equal(res.image, undefined);

  // OCR тоже не должен даже запускаться: проверка пути раньше PowerShell.
  const ocrTool = tools.find((tool) => tool.name === 'image_read_text');
  const ocr = await ocrTool.run({ path: 'камера/secret.png' });
  assert.equal(ocr.ok, false);
  assert.equal(runnerCalls, 0);
});

test('image_look: риск T1, verify не нужен, рядом остался image_read_text', () => {
  const tools = imageTools({ workspace: tempDir('jarvis-look-meta-') });
  const lookTool = tools.find((t) => t.name === 'image_look');
  const ocrTool = tools.find((t) => t.name === 'image_read_text');
  assert.ok(lookTool);
  assert.ok(ocrTool, 'OCR остался отдельным инструментом');
  assert.equal(lookTool.risk, 'T1');
  assert.equal(lookTool.verify, undefined);
  assert.deepEqual(lookTool.parameters.required, ['path']);
  assert.match(lookTool.description, /модель видит/);
});
