'use strict';
// Замер нажатия по частям (этап 1.2). Своё окно WinForms, настоящие Nox-инструменты, модели нет.
// Запуск: node docs/audits/autonomy-readiness/evidence/click-bench.js [число нажатий]
const path = require('path');
const { spawn } = require('child_process');

const APP = path.join(__dirname, '..', '..', '..', '..', 'apps', 'jarvis-desktop');
const req = (p) => require(path.join(APP, p));
const { uiTools } = req('src/tools/ui.js');
const { observeTools } = req('src/tools/observe.js');
const { createPsHost } = req('src/tools/ps-host.js');
const { checkEffect } = req('src/agent/effects.js');

const N = Number(process.argv[2]) || 7;
const TITLE = 'NoxClickBench';
const FORM = `
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = '${TITLE}'; $f.Width = 420; $f.Height = 220; $f.TopMost = $true
$l = New-Object System.Windows.Forms.Label; $l.Text = 'Count 0'; $l.Left = 20; $l.Top = 20; $l.Width = 300
$b = New-Object System.Windows.Forms.Button; $b.Text = 'BenchButton'; $b.Left = 20; $b.Top = 60; $b.Width = 150
$script:n = 0
$b.Add_Click({ $script:n++; $l.Text = "Count $($script:n)" })
$f.Controls.AddRange(@($l, $b))
[System.Windows.Forms.Application]::Run($f)
`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

(async () => {
  const form = spawn('powershell.exe', ['-NoProfile', '-Command', FORM], { windowsHide: false, stdio: 'ignore' });
  const host = createPsHost();
  const calls = [];
  const runner = async (script, env, opts) => {
    const t = Date.now();
    try { return await host.run(script, env, opts); } finally { calls.push(Date.now() - t); }
  };
  try {
    const ui = uiTools({ selfPid: process.pid, runner });
    const tools = Object.fromEntries([...ui, ...observeTools(ui)].map((t) => [t.name, t]));
    const ctx = { signal: new AbortController().signal, mode: 'full' };
    let scene = null;
    for (let i = 0; i < 40 && !scene; i += 1) {
      const obs = await tools.desktop_observe.run({ window: TITLE }, ctx);
      scene = obs.ok && obs.data.scene.elements.some((e) => e.name === 'BenchButton') ? obs.data.scene : null;
      if (!scene) await sleep(500);
    }
    if (!scene) throw new Error('окно стенда не появилось');
    const rows = [];
    for (let i = 0; i < N; i += 1) {
      const btn = scene.elements.find((e) => e.name === 'BenchButton');
      calls.length = 0;
      const t = Date.now();
      const result = await tools.desktop_click.run({ id: btn.id, expect: 'Count' }, ctx);
      const checked = await checkEffect(tools.desktop_click, { id: btn.id, expect: 'Count' }, result, ctx);
      rows.push({ ms: Date.now() - t, ps: [...calls], verified: checked.verified, evidence: checked.evidence });
      scene = (result.data && result.data.scene) || scene;
    }
    const warm = rows.slice(1);
    console.log(JSON.stringify({
      clicks: rows.length,
      medianMs: median(warm.map((r) => r.ms)),
      medianPsCallsMs: warm[0].ps.map((_, k) => median(warm.map((r) => r.ps[k] || 0))),
      verified: rows.map((r) => r.verified),
      rows,
    }, null, 2));
  } catch (err) {
    console.error(err.stack || err);
    process.exitCode = 1;
  } finally {
    try { host.close && host.close(); } catch {}
    try { form.kill(); } catch {}
    setTimeout(() => process.exit(process.exitCode || 0), 300).unref();
  }
})();
