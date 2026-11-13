'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const {
  PrivacyController,
  IsolatedSessionStore,
  SyntheticAudioStreamAdapter,
  SyntheticASRProvider,
  SessionManager,
} = require('../src');

async function runBenchmarkPass({ label, totalChunks, simulatedAsrDelayMs }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-c7-bench-'));
  try {
    const privacy = new PrivacyController();
    privacy.grantConsent({ captureConsent: true, storageConsent: false });
    const store = new IsolatedSessionStore({ baseDir: tmpDir });

    const adapter = new SyntheticAudioStreamAdapter({
      totalChunks,
      chunkDurationMs: 40,
      paceMs: 0,
    });
    const provider = new SyntheticASRProvider({
      simulatedDelayMs: simulatedAsrDelayMs,
      chunksPerFinal: 20,
    });
    const session = new SessionManager({
      sessionId: `bench-${totalChunks}`,
      privacy,
      store,
      adapter,
      provider,
      queueOptions: { maxChunks: 4096, maxBytes: 16 * 1024 * 1024 },
      stopGraceMs: 2000,
    });

    const wallT0 = performance.now();
    await session.start();
    await new Promise((resolve) => {
      if (session._streamEnded) return resolve();
      session.once('stream_ended', resolve);
    });
    const snap = await session.finish();
    const wallTotalMs = Number((performance.now() - wallT0).toFixed(3));

    const l = snap.metrics.latency;
    return {
      label,
      totalChunks,
      finalsProduced: snap.transcript.finals.length,
      wallTotalMs,
      pipelineIngestMs: l.pipelineIngestMs,
      pipelineAssemblyMs: l.pipelineAssemblyMs,
      pipelineOverheadMs: l.pipelineOverheadMs,
      simulatedAsrDelayMs: l.simulatedAsrDelayMs,
      summaryGenerationMs: l.summaryGenerationMs,
      peakQueueChunks: snap.metrics.backpressure.peakChunks,
      peakQueueBytes: snap.metrics.backpressure.peakBytes,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log('=== NOX C7 LATENCY BENCHMARK (1000 CHUNKS) ===');
  console.log('ВАЖНО: замеряется собственный конвейер C7 на синтетике.');
  console.log('Скорость реального ASR-движка (faster-whisper / whisper.cpp / sherpa-onnx) сюда НЕ входит.\n');

  const zeroDelay = await runBenchmarkPass({
    label: 'Pure pipeline overhead (simulatedAsrDelayMs = 0)',
    totalChunks: 1000,
    simulatedAsrDelayMs: 0,
  });

  const mockDelay = await runBenchmarkPass({
    label: 'Pipeline + simulated ASR async delay (10ms)',
    totalChunks: 1000,
    simulatedAsrDelayMs: 10,
  });

  for (const r of [zeroDelay, mockDelay]) {
    console.log(`--- ${r.label} ---`);
    console.log(`  Chunks processed : ${r.totalChunks} -> ${r.finalsProduced} finals`);
    console.log(`  Wall clock total : ${r.wallTotalMs} ms`);
    console.log(`  Ingest overhead  : p50=${r.pipelineIngestMs.p50Ms}ms, p95=${r.pipelineIngestMs.p95Ms}ms, max=${r.pipelineIngestMs.maxMs}ms`);
    console.log(`  Assembly + TL    : p50=${r.pipelineAssemblyMs.p50Ms}ms, p95=${r.pipelineAssemblyMs.p95Ms}ms, max=${r.pipelineAssemblyMs.maxMs}ms`);
    console.log(`  Summary gen      : ${r.summaryGenerationMs} ms`);
    console.log(`  Simulated ASR    : avg=${r.simulatedAsrDelayMs.avgMs}ms (isSynthetic=${r.simulatedAsrDelayMs.isSynthetic})`);
    console.log(`  Peak queue RAM   : ${r.peakQueueChunks} chunks / ${r.peakQueueBytes} bytes\n`);
  }
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
