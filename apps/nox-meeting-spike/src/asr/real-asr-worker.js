'use strict';

const readline = require('node:readline');
const { loadSherpaOnnx } = require('./sherpa-loader');
const { SherpaStreamingEngine } = require('./sherpa-streaming-engine');

/**
 * Isolated ASR worker process communicating via line-delimited JSON (NDJSON) on stdin/stdout.
 * Keeps synchronous C++/ONNX inference and potential native faults out of Electron Main Process.
 */
function writeMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function createWorkerSession() {
  let engine = null;
  let maxRssBytes = null;
  let lastCpuUsage = process.cpuUsage();

  function sampleResourceUsage() {
    const cpuDelta = process.cpuUsage(lastCpuUsage);
    lastCpuUsage = process.cpuUsage();
    const mem = process.memoryUsage();
    const cpuTimeMs = Number(((cpuDelta.user + cpuDelta.system) / 1000).toFixed(3));
    return {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      externalBytes: mem.external,
      cpuTimeMs,
    };
  }

  function assertMemoryWithinLimit() {
    if (!Number.isFinite(maxRssBytes) || maxRssBytes <= 0) {
      return;
    }
    const rss = process.memoryUsage().rss;
    if (rss > maxRssBytes) {
      const err = new Error(
        `Worker RSS memory cap exceeded (${rss} > ${maxRssBytes} bytes)`
      );
      err.code = 'ASR_MEMORY_LIMIT_EXCEEDED';
      throw err;
    }
  }

  async function handleCommand(msg) {
    const { id, cmd } = msg || {};
    if (!id || !cmd) {
      return;
    }

    try {
      if (cmd === 'init') {
        if (engine) {
          engine.dispose();
          engine = null;
        }
        maxRssBytes = Number.isFinite(msg.maxRssBytes) ? msg.maxRssBytes : null;
        const { binding, mode, dllDir } = loadSherpaOnnx(msg.loaderOptions || {});
        engine = new SherpaStreamingEngine({
          binding,
          resolvedModel: msg.resolvedModel,
          numThreads: msg.engineOptions && msg.engineOptions.numThreads,
          endpointing: msg.engineOptions && msg.engineOptions.endpointing,
          maxActivePaths: msg.engineOptions && msg.engineOptions.maxActivePaths,
          maxConcurrentChannels: msg.engineOptions && msg.engineOptions.maxConcurrentChannels,
          maxUtteranceDurationMs: msg.engineOptions && msg.engineOptions.maxUtteranceDurationMs,
          tailPaddingMs: msg.engineOptions && msg.engineOptions.tailPaddingMs,
        });
        assertMemoryWithinLimit();
        writeMessage({
          id,
          ok: true,
          loaderMode: mode,
          dllDir,
          resources: sampleResourceUsage(),
          stats: engine.getStats(),
        });
        return;
      }

      if (cmd === 'push') {
        if (!engine) {
          throw new Error('Worker ASR engine is not initialized');
        }
        assertMemoryWithinLimit();
        const rawChunk = msg.chunk || {};
        const pcm = rawChunk.pcmBase64
          ? Buffer.from(rawChunk.pcmBase64, 'base64')
          : Buffer.alloc(0);

        const events = engine.processChunk({
          seq: rawChunk.seq,
          channel: rawChunk.channel,
          sampleRate: rawChunk.sampleRate,
          channels: rawChunk.channels,
          startMs: rawChunk.startMs,
          endMs: rawChunk.endMs,
          durationMs: rawChunk.durationMs,
          speakerHint: rawChunk.speakerHint,
          pcm,
        });
        pcm.fill(0);
        assertMemoryWithinLimit();

        writeMessage({
          id,
          ok: true,
          events,
          resources: sampleResourceUsage(),
          stats: engine.getStats(),
        });
        return;
      }

      if (cmd === 'flush') {
        if (!engine) {
          writeMessage({ id, ok: true, events: [], resources: sampleResourceUsage() });
          return;
        }
        const events = engine.flushAll();
        writeMessage({
          id,
          ok: true,
          events,
          resources: sampleResourceUsage(),
          stats: engine.getStats(),
        });
        return;
      }

      if (cmd === 'stats') {
        writeMessage({
          id,
          ok: true,
          resources: sampleResourceUsage(),
          stats: engine ? engine.getStats() : null,
        });
        return;
      }

      if (cmd === 'shutdown') {
        if (engine) {
          engine.dispose();
          engine = null;
        }
        writeMessage({ id, ok: true });
        process.nextTick(() => process.exit(0));
        return;
      }

      throw new Error(`Unknown worker command: ${cmd}`);
    } catch (err) {
      writeMessage({
        id,
        ok: false,
        error: {
          message: err.message,
          code: err.code || 'ASR_WORKER_ERROR',
          name: err.name || 'Error',
        },
        resources: sampleResourceUsage(),
      });
    }
  }

  function dispose() {
    if (engine) {
      engine.dispose();
      engine = null;
    }
  }

  return { handleCommand, dispose };
}

if (require.main === module) {
  const session = createWorkerSession();
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      writeMessage({
        type: 'protocol_error',
        error: { message: `Invalid JSON command: ${err.message}`, code: 'BAD_JSON' },
      });
      return;
    }
    session.handleCommand(parsed);
  });

  rl.on('close', () => {
    session.dispose();
    process.exit(0);
  });

  process.on('uncaughtException', (err) => {
    writeMessage({
      type: 'fatal',
      error: { message: err.message, code: err.code || 'UNCAUGHT_EXCEPTION' },
    });
    session.dispose();
    process.exit(1);
  });

  writeMessage({ type: 'ready', pid: process.pid, runtime: process.version });
}

module.exports = {
  createWorkerSession,
};
