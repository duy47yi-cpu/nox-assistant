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

module.exports = { screenTools, CAPTURE_SCRIPT, MAX_WIDTH };
