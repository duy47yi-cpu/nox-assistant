'use strict';

// Снимок основного экрана для модели. Файл создаётся во временной папке и удаляется сразу после чтения.
// allowed() решает, можно ли снимать сейчас: в режиме «по просьбе» только когда владелец попросил.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runPowerShell } = require('./system');

const MAX_WIDTH = 1280;
const MAX_BYTES = 2 * 1024 * 1024;

// Постоянный текст скрипта: путь к файлу передаётся через переменную окружения JARVIS_SHOT.
const CAPTURE_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
  // Те же настоящие пиксели, что считает мышь: при масштабе Windows не 100 % точки снимка иначе не совпадут.
  'Add-Type -Namespace JarvisShot -Name Dpi -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();\'',
  '[void][JarvisShot.Dpi]::SetProcessDPIAware()',
  '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
  '$shot = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
  '$g = [System.Drawing.Graphics]::FromImage($shot)',
  '$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)',
  `$w = [Math]::Min(${MAX_WIDTH}, $b.Width)`,
  '$h = [int]($b.Height * $w / $b.Width)',
  '$small = New-Object System.Drawing.Bitmap $w, $h',
  '$g2 = [System.Drawing.Graphics]::FromImage($small)',
  '$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
  '$g2.DrawImage($shot, 0, 0, $w, $h)',
  '$small.Save($env:JARVIS_SHOT, [System.Drawing.Imaging.ImageFormat]::Jpeg)',
  '$g.Dispose(); $g2.Dispose(); $shot.Dispose(); $small.Dispose()',
].join('; ');

function screenTools({ allowed = () => false, capture = runPowerShell } = {}) {
  return [
    {
      name: 'screen_look',
      description: 'Снимок основного экрана: модель видит картинку. Вызывай, когда владелец просит посмотреть экран или без картинки не понять задачу.',
      risk: 'T1',
      parameters: { type: 'object', properties: {} },
      async run(args, ctx) {
        if (!allowed()) return { ok: false, summary: 'снимок экрана не запрошен: режим «по просьбе»', data: {} };
        const file = path.join(os.tmpdir(), `jarvis-shot-${crypto.randomUUID()}.jpg`);
        try {
          const res = await capture(CAPTURE_SCRIPT, { JARVIS_SHOT: file }, { signal: ctx && ctx.signal, timeoutMs: 15000 });
          if (!res.ok || !fs.existsSync(file)) {
            return { ok: false, summary: `не удалось снять экран: ${res.summary}`, data: {} };
          }
          const bytes = fs.readFileSync(file);
          if (bytes.length > MAX_BYTES) return { ok: false, summary: 'снимок слишком большой', data: {} };
          return {
            ok: true,
            summary: `снимок экрана ${MAX_WIDTH}px`,
            data: { bytes: bytes.length },
            image: `data:image/jpeg;base64,${bytes.toString('base64')}`,
          };
        } finally {
          fs.rmSync(file, { force: true });
        }
      },
    },
  ];
}

// Срок жизни обведённой области: дольше снимок в памяти не держим.
const REGION_TTL_MS = 10 * 60 * 1000;

// Область, которую владелец сам обвёл рамкой. take() отдаёт {shot, pixels, label, at}:
// shot — nativeImage всего экрана, снятый desktopCapturer в момент выбора (потом окно Джарвиса закрыло бы область),
// pixels — прямоугольник в пикселях снимка. Снимок только в памяти, на диск не пишется; после показа сбрасывается.
// Только для чата в окне: в фон, команды и Telegram не регистрируется (screen_ закрыт в telegram/policy.js).
function regionTools({ take = () => null, clear = () => {}, now = Date.now } = {}) {
  return [
    {
      name: 'screen_region_look',
      description: 'Картинка области экрана, которую владелец сам обвёл рамкой («объясни, что я обвёл»). Только смотреть и объяснять: ничего не нажимать и не оплачивать.',
      risk: 'T1',
      parameters: { type: 'object', properties: {} },
      async run() {
        const region = take();
        if (!region || !region.shot || !region.pixels) return { ok: false, summary: 'область не выбрана: владелец обводит её кнопкой у поля ввода', data: {} };
        if (now() - region.at > REGION_TTL_MS) { clear(); return { ok: false, summary: 'обведённая область устарела, обведите заново', data: {} }; }
        const want = region.pixels;
        let part;
        try { part = region.shot.crop(want); } catch (err) { return { ok: false, summary: `не удалось вырезать область: ${err.message}`, data: {} }; }
        const got = part && typeof part.getSize === 'function' ? part.getSize() : { width: 0, height: 0 };
        // Как у screen_look: ширину ужимаем до MAX_WIDTH, пропорции сохраняются.
        const small = got.width > MAX_WIDTH ? part.resize({ width: MAX_WIDTH, quality: 'best' }) : part;
        const bytes = small && typeof small.toJPEG === 'function' ? small.toJPEG(85) : Buffer.alloc(0);
        clear();
        if (!bytes.length) return { ok: false, summary: 'снимок области пустой', data: { width: got.width, height: got.height } };
        if (bytes.length > MAX_BYTES) return { ok: false, summary: 'снимок области слишком большой', data: {} };
        return {
          ok: true,
          summary: `снимок: ${region.label || `область ${got.width}×${got.height}`}`,
          data: { width: got.width, height: got.height, wantWidth: want.width, wantHeight: want.height, bytes: bytes.length },
          image: `data:image/jpeg;base64,${bytes.toString('base64')}`,
        };
      },
      // Снимок есть и вырезан ровно того размера, что обвели; иначе честный провал.
      verify(args, result) {
        const d = (result && result.data) || {};
        const image = typeof result.image === 'string' && result.image.startsWith('data:image/jpeg;base64,') && result.image.length > 23;
        if (!image) return { status: 'failed', evidence: 'картинки области нет' };
        if (d.width !== d.wantWidth || d.height !== d.wantHeight) {
          return { status: 'failed', evidence: `размер не совпал: ${d.width}×${d.height} вместо ${d.wantWidth}×${d.wantHeight}` };
        }
        return { status: 'confirmed', evidence: `область ${d.width}×${d.height}` };
      },
    },
  ];
}

module.exports = { screenTools, regionTools, CAPTURE_SCRIPT, MAX_WIDTH, REGION_TTL_MS };
