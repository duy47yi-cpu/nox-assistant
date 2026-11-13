'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_NODE_PACKAGE = 'sherpa-onnx-node';

class SherpaRuntimeNotInstalledError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SherpaRuntimeNotInstalledError';
    this.code = 'SHERPA_RUNTIME_NOT_INSTALLED';
    this.details = details;
  }
}

class SherpaAsarError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SherpaAsarError';
    this.code = 'SHERPA_ASAR_NOT_UNPACKED';
    this.details = details;
  }
}

function getPlatformBinaryPackage(platform = process.platform, arch = process.arch) {
  const pkgPlatform = platform === 'win32' ? 'win' : platform;
  return `sherpa-onnx-${pkgPlatform}-${arch}`;
}

function isInsidePlainAsar(targetPath) {
  if (!targetPath) {
    return false;
  }
  const normalized = targetPath.replace(/\\/g, '/');
  return normalized.includes('.asar/') && !normalized.includes('.asar.unpacked/');
}

function toUnpackedAsarPath(targetPath) {
  if (!targetPath) {
    return targetPath;
  }
  return targetPath.replace(/\.asar([\\/])/i, '.asar.unpacked$1');
}

function buildSearchPaths(extraSearchPaths = []) {
  const paths = [];
  for (const entry of extraSearchPaths) {
    if (entry && !paths.includes(entry)) {
      paths.push(entry);
    }
  }
  if (!paths.includes(process.cwd())) {
    paths.push(process.cwd());
  }
  const repoDesktopNodeModules = path.resolve(__dirname, '../../../jarvis-desktop/node_modules');
  const spikeNodeModules = path.resolve(__dirname, '../../node_modules');
  for (const candidate of [spikeNodeModules, repoDesktopNodeModules]) {
    if (!paths.includes(candidate)) {
      paths.push(candidate);
    }
  }
  return paths;
}

function tryResolvePackageJson(packageName, searchPaths) {
  try {
    const pkgJsonPath = require.resolve(`${packageName}/package.json`, { paths: searchPaths });
    const raw = fs.readFileSync(pkgJsonPath, 'utf8');
    const pkg = JSON.parse(raw);
    return {
      installed: true,
      packageName,
      packageJsonPath: pkgJsonPath,
      dir: path.dirname(pkgJsonPath),
      version: pkg.version || null,
      license: pkg.license || null,
    };
  } catch (_err) {
    try {
      const entryPath = require.resolve(packageName, { paths: searchPaths });
      const dir = path.dirname(entryPath);
      return {
        installed: true,
        packageName,
        packageJsonPath: null,
        dir,
        version: null,
        license: null,
      };
    } catch (resolveErr) {
      return {
        installed: false,
        packageName,
        packageJsonPath: null,
        dir: null,
        version: null,
        license: null,
        error: resolveErr.message,
      };
    }
  }
}

/**
 * Prepends the native DLL folder (sherpa-onnx-win-x64) to PATH without duplication
 * so Windows LoadLibrary finds onnxruntime.dll and sherpa-onnx-c-api.dll before Electron/system DLLs.
 *
 * @param {string} dirPath
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {string}
 */
function prependDllSearchPath(dirPath, env = process.env) {
  if (!dirPath) {
    return env.PATH || '';
  }
  const delimiter = path.delimiter;
  const current = env.PATH || env.Path || '';
  const segments = current ? current.split(delimiter).filter(Boolean) : [];
  const lowerTarget = dirPath.toLowerCase();
  const alreadyPresent = segments.some((seg) => seg.toLowerCase() === lowerTarget);
  if (!alreadyPresent) {
    const updated = [dirPath, ...segments].join(delimiter);
    env.PATH = updated;
    if (Object.prototype.hasOwnProperty.call(env, 'Path')) {
      env.Path = updated;
    }
    return updated;
  }
  return current;
}

/**
 * Inspects host compatibility, N-API / Electron ABI alignment, ASAR unpacking requirements,
 * and current package installation status without mutating node_modules or making network calls.
 *
 * @param {object} [options]
 * @returns {object}
 */
function inspectRuntimeCompatibility(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const nodePackageName = options.nodePackageName || DEFAULT_NODE_PACKAGE;
  const binaryPackageName = options.binaryPackageName || getPlatformBinaryPackage(platform, arch);
  const searchPaths = buildSearchPaths(options.extraSearchPaths);

  const electronVersion = (process.versions && process.versions.electron) || null;
  const electronMajor = electronVersion ? Number.parseInt(electronVersion.split('.')[0], 10) : null;
  const isElectron = Boolean(electronVersion);

  const nodePackage = tryResolvePackageJson(nodePackageName, searchPaths);
  const binaryPackage = tryResolvePackageJson(binaryPackageName, searchPaths);

  const asarIssues = [];
  if (nodePackage.installed && isInsidePlainAsar(nodePackage.dir)) {
    asarIssues.push(`${nodePackageName} resolved inside ASAR without asarUnpack: ${nodePackage.dir}`);
  }
  if (binaryPackage.installed && isInsidePlainAsar(binaryPackage.dir)) {
    asarIssues.push(`${binaryPackageName} resolved inside ASAR without asarUnpack: ${binaryPackage.dir}`);
  }

  let detectedNativeFiles = [];
  if (binaryPackage.installed && binaryPackage.dir) {
    try {
      detectedNativeFiles = fs.readdirSync(binaryPackage.dir).filter((f) => /\.(node|dll|so|dylib)$/i.test(f));
    } catch (_err) {
      detectedNativeFiles = [];
    }
  }

  const requiredDlls = platform === 'win32'
    ? ['sherpa-onnx.node', 'onnxruntime.dll', 'sherpa-onnx-c-api.dll']
    : [];
  const missingNativeFiles = requiredDlls.filter((file) => !detectedNativeFiles.includes(file));

  return {
    platform,
    arch,
    supportedPlatform: platform === 'win32' && arch === 'x64',
    nodeVersion: process.version,
    nodeModuleAbi: process.versions.modules,
    napiVersion: process.versions.napi || null,
    isElectron,
    electronVersion,
    runningAsElectronNode: process.env.ELECTRON_RUN_AS_NODE === '1',
    externalBuffersDisallowed: Boolean(isElectron && Number.isFinite(electronMajor) && electronMajor >= 21),
    workerIsolationRecommended: true,
    nodeAddonStrategy: 'node-addon-api (N-API prebuilt .node + DLLs; do NOT run electron-rebuild)',
    nodePackage,
    binaryPackage,
    detectedNativeFiles,
    missingNativeFiles,
    asarIssues,
    readyToLoad:
      nodePackage.installed &&
      binaryPackage.installed &&
      asarIssues.length === 0 &&
      missingNativeFiles.length === 0,
  };
}

/**
 * Loads sherpa-onnx-node safely (or accepts an injected test binding) and validates Electron constraints.
 *
 * @param {object} [options]
 * @returns {{ binding: object, mode: 'injected'|'native', dllDir: string|null, compatibility: object }}
 */
function loadSherpaOnnx(options = {}) {
  const compatibility = inspectRuntimeCompatibility(options);

  if (options.binding) {
    if (typeof options.binding.OnlineRecognizer !== 'function') {
      throw new TypeError('Injected sherpa-onnx binding must provide OnlineRecognizer constructor');
    }
    return {
      binding: options.binding,
      mode: 'injected',
      dllDir: null,
      compatibility,
    };
  }

  if (options.allowNativeLoad === false) {
    throw new SherpaRuntimeNotInstalledError(
      'Native sherpa-onnx loading is disabled in offline/contract mode',
      compatibility
    );
  }

  if (!compatibility.nodePackage.installed || !compatibility.binaryPackage.installed) {
    const missing = [];
    if (!compatibility.nodePackage.installed) {
      missing.push(compatibility.nodePackage.packageName);
    }
    if (!compatibility.binaryPackage.installed) {
      missing.push(compatibility.binaryPackage.packageName);
    }
    throw new SherpaRuntimeNotInstalledError(
      `sherpa-onnx native packages are not installed (${missing.join(', ')}). Owner approval is required before npm install.`,
      { missingPackages: missing, compatibility }
    );
  }

  if (compatibility.asarIssues.length > 0) {
    const unpackedCandidate = toUnpackedAsarPath(compatibility.binaryPackage.dir);
    if (!fs.existsSync(unpackedCandidate)) {
      throw new SherpaAsarError(
        `sherpa-onnx native binaries cannot load from ASAR archive; add asarUnpack in electron-builder. ${compatibility.asarIssues.join('; ')}`,
        compatibility
      );
    }
    compatibility.binaryPackage.dir = unpackedCandidate;
  }

  if (compatibility.platform === 'win32' && compatibility.binaryPackage.dir) {
    prependDllSearchPath(compatibility.binaryPackage.dir, process.env);
  }

  const requireTarget = options.requireFn || require;
  let binding;
  try {
    binding = requireTarget(compatibility.nodePackage.packageJsonPath
      ? path.dirname(compatibility.nodePackage.packageJsonPath)
      : compatibility.nodePackage.packageName);
  } catch (err) {
    throw new SherpaRuntimeNotInstalledError(
      `Failed to load native sherpa-onnx addon: ${err.message}`,
      { cause: err.message, compatibility }
    );
  }

  if (!binding || typeof binding.OnlineRecognizer !== 'function') {
    throw new SherpaRuntimeNotInstalledError(
      'Loaded sherpa-onnx-node module does not expose OnlineRecognizer',
      { compatibility }
    );
  }

  return {
    binding,
    mode: 'native',
    dllDir: compatibility.binaryPackage.dir,
    compatibility,
  };
}

/**
 * Resolves the child-process executable and environment for worker isolation.
 * Under Electron, spawns process.execPath with ELECTRON_RUN_AS_NODE=1 so no extra BrowserWindow/dock launches.
 *
 * @param {object} [options]
 * @returns {{ execPath: string, env: Record<string, string> }}
 */
function resolveWorkerRuntimeExecutable(options = {}) {
  const execPath = options.execPath || process.execPath;
  const env = {};
  if (process.versions && process.versions.electron && !options.execPath) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  return { execPath, env };
}

module.exports = {
  DEFAULT_NODE_PACKAGE,
  SherpaRuntimeNotInstalledError,
  SherpaAsarError,
  getPlatformBinaryPackage,
  isInsidePlainAsar,
  toUnpackedAsarPath,
  prependDllSearchPath,
  inspectRuntimeCompatibility,
  loadSherpaOnnx,
  resolveWorkerRuntimeExecutable,
};
