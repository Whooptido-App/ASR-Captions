#!/opt/homebrew/bin/node

/**
 * Whooptido Companion - Native Messaging Host for Whisper ASR
 * 
 * Uses chrome-native-messaging npm package for reliable stdio handling.
 * This is the recommended approach for Chrome native messaging with Node.js.
 * 
 * Chrome Extension <-> Native Messaging <-> This Script <-> whisper-cli
 */

const nativeMessage = require('chrome-native-messaging');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

// Whisper configuration
const WHISPER_CLI_ENV = 'WHOOPTIDO_WHISPER_CLI';
const WHOOPTIDO_DIR = path.join(os.homedir(), '.whooptido');
const MODELS_DIR = path.join(WHOOPTIDO_DIR, 'models');
const DEFAULT_MODEL = path.join(MODELS_DIR, 'ggml-large-v3-turbo-q5_0.bin');
const OLD_MODELS_DIR = path.join(os.homedir(), 'whisper-models');
const HOST_VERSION = '1.0.0-beta.14';
const SUPPORTED_RUNTIME_BACKENDS = new Set(['cuda', 'vulkan', 'metal']);
const MODEL_QUALITY_RANK = Object.freeze({
  'small': 100,
  'medium': 200,
  'large-v3': 300,
  'large-v3-turbo': 400
});
const MODEL_FILENAME_TO_ID = Object.freeze({
  'ggml-small.bin': 'small',
  'ggml-small-q5_1.bin': 'small',
  'ggml-medium.bin': 'medium',
  'ggml-medium-q5_0.bin': 'medium',
  'ggml-large-v3.bin': 'large-v3',
  'ggml-large-v3-turbo.bin': 'large-v3-turbo',
  'ggml-large-v3-turbo-q5_0.bin': 'large-v3-turbo'
});
const MODEL_ID_TO_FILENAMES = Object.freeze({
  'small': ['ggml-small.bin', 'ggml-small-q5_1.bin'],
  'medium': ['ggml-medium.bin', 'ggml-medium-q5_0.bin'],
  'large-v3': ['ggml-large-v3.bin'],
  'large-v3-turbo': ['ggml-large-v3-turbo-q5_0.bin', 'ggml-large-v3-turbo.bin']
});

// Log file for debugging
const LOG_FILE = path.join(os.tmpdir(), 'whooptido-companion.log');

function log(message) {
  const timestamp = new Date().toISOString();
  try {
    fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
  } catch (e) {
    // Can't log, ignore
  }
}

// Also log to stderr which goes to Chrome's debug log
function logError(message) {
  log(message);
  process.stderr.write(`[Whooptido] ${message}\n`);
}

function getExecutableDir() {
  if (process.pkg && process.execPath) {
    return path.dirname(process.execPath);
  }
  return __dirname;
}

function getWhisperCliCandidates() {
  const platform = os.platform();
  const executableName = platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const installDir = getExecutableDir();
  const candidates = [];

  if (process.env[WHISPER_CLI_ENV]) {
    candidates.push(process.env[WHISPER_CLI_ENV]);
  }

  if (platform === 'win32') {
    candidates.push(
      path.join(installDir, 'whisper-cuda', executableName),
      path.join(installDir, 'whisper-vulkan', executableName),
      path.join(installDir, 'whisper', executableName),
      path.join(installDir, executableName)
    );
  } else {
    candidates.push(
      path.join(installDir, 'whisper', executableName),
      path.join(installDir, executableName)
    );
  }

  if (platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli');
  } else if (platform === 'linux') {
    candidates.push('/usr/local/bin/whisper-cli', '/usr/bin/whisper-cli');
  }

  candidates.push(executableName);
  return [...new Set(candidates.filter(Boolean))];
}

function isPathLike(candidate) {
  return Boolean(candidate && (candidate.includes(path.sep) || candidate.includes('/') || candidate.includes('\\')));
}

function clampDiagnosticText(value, maxLength = 2000) {
  if (!value) return '';
  const text = String(value).trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function bufferToString(value) {
  if (!value) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function getWhisperExecutionOptions(whisperCliPath) {
  const runtimeDir = isPathLike(whisperCliPath) ? path.dirname(whisperCliPath) : null;
  const env = { ...process.env };

  if (runtimeDir) {
    const currentPath = env.PATH || env.Path || '';
    const nextPath = [runtimeDir, currentPath].filter(Boolean).join(path.delimiter);
    env.PATH = nextPath;
    env.Path = nextPath;
  }

  return {
    cwd: runtimeDir && fs.existsSync(runtimeDir) ? runtimeDir : process.cwd(),
    env,
    windowsHide: true
  };
}

function isWhisperHelpOutput(text) {
  return /usage:|options:|whisper\.cpp|whisper-cli/i.test(text || '')
    && /-m|--model|-h|--help/i.test(text || '');
}

function probeWhisperCli(whisperCliPath) {
  const attempts = [];

  for (const args of [['-h'], ['--help']]) {
    try {
      const stdout = execFileSync(whisperCliPath, args, {
        ...getWhisperExecutionOptions(whisperCliPath),
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 5000
      });
      const attempt = {
        args,
        ok: true,
        exitCode: 0,
        signal: null,
        stdout: clampDiagnosticText(stdout),
        stderr: '',
        message: null
      };
      attempts.push(attempt);
      return { ok: true, args, exitCode: 0, signal: null, stdout: attempt.stdout, stderr: '', attempts };
    } catch (error) {
      const stdout = bufferToString(error.stdout);
      const stderr = bufferToString(error.stderr);
      const combinedOutput = `${stdout}\n${stderr}`;
      const attempt = {
        args,
        ok: false,
        exitCode: Number.isInteger(error.status) ? error.status : null,
        signal: error.signal || null,
        stdout: clampDiagnosticText(stdout),
        stderr: clampDiagnosticText(stderr),
        message: clampDiagnosticText(error.message, 1000)
      };

      if (isWhisperHelpOutput(combinedOutput)) {
        attempt.ok = true;
        attempt.message = attempt.message || 'Whisper help output returned with a non-zero exit code';
        attempts.push(attempt);
        return {
          ok: true,
          args,
          exitCode: attempt.exitCode,
          signal: attempt.signal,
          stdout: attempt.stdout,
          stderr: attempt.stderr,
          attempts
        };
      }

      attempts.push(attempt);
    }
  }

  const lastAttempt = attempts[attempts.length - 1] || {};
  return {
    ok: false,
    args: lastAttempt.args || null,
    exitCode: lastAttempt.exitCode ?? null,
    signal: lastAttempt.signal || null,
    stdout: lastAttempt.stdout || '',
    stderr: lastAttempt.stderr || '',
    message: lastAttempt.message || 'Whisper probe failed',
    attempts
  };
}

function safeExecFile(command, args = [], timeout = 3000) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout,
      windowsHide: true
    });
  } catch (error) {
    return '';
  }
}

function uniqueStrings(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function splitCommandLines(output) {
  return uniqueStrings(String(output || '').split(/\r?\n/g));
}

function detectNvidiaDevices() {
  const output = safeExecFile('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], 3000);
  const nvidiaSmiDevices = splitCommandLines(output);
  if (nvidiaSmiDevices.length > 0) return nvidiaSmiDevices;
  if (os.platform() === 'win32') {
    return getWindowsVideoControllerNames().filter(line => /nvidia/i.test(line));
  }
  return [];
}

function getWindowsVideoControllerNames() {
  const command = '(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) -join [Environment]::NewLine';
  const powershellOutput = safeExecFile('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command
  ], 5000);
  if (powershellOutput.trim()) return splitCommandLines(powershellOutput);

  const wmicOutput = safeExecFile('wmic.exe', ['path', 'win32_VideoController', 'get', 'name'], 5000);
  return splitCommandLines(wmicOutput).filter(line => !/^name$/i.test(line));
}

function detectAmdDevices() {
  const platform = os.platform();
  let deviceLines = [];

  if (platform === 'win32') {
    deviceLines = getWindowsVideoControllerNames();
  } else if (platform === 'linux') {
    deviceLines = splitCommandLines(safeExecFile('lspci', [], 3000));
  }

  return deviceLines.filter(line => /(amd|radeon|advanced micro devices)/i.test(line));
}

function detectAcceleratedHardware() {
  const platform = os.platform();
  const arch = os.arch();
  const hardwareBackends = [];
  const devices = [];

  if (platform === 'darwin') {
    if (arch === 'arm64') {
      hardwareBackends.push('metal');
      devices.push({ vendor: 'apple', backend: 'metal', name: 'Apple Silicon' });
    }
  } else if (platform === 'win32' || platform === 'linux') {
    for (const name of detectNvidiaDevices()) {
      hardwareBackends.push('cuda');
      devices.push({ vendor: 'nvidia', backend: 'cuda', name });
    }

    for (const name of detectAmdDevices()) {
      hardwareBackends.push('vulkan');
      devices.push({ vendor: 'amd', backend: 'vulkan', name });
    }
  }

  const supportedBackends = uniqueStrings(hardwareBackends);
  return {
    platform,
    arch,
    supportedBackends,
    devices,
    supported: supportedBackends.length > 0,
    unsupportedReason: supportedBackends.length > 0
      ? null
      : 'Word-for-Word captions require NVIDIA CUDA, AMD Vulkan, or Apple Silicon Metal. CPU-only ASR is not supported.'
  };
}

function getRuntimeFileNames(whisperCliPath) {
  if (!isPathLike(whisperCliPath)) return [];
  const runtimeDir = path.dirname(whisperCliPath);
  try {
    return fs.readdirSync(runtimeDir).map(fileName => fileName.toLowerCase());
  } catch (error) {
    return [];
  }
}

function inferWhisperRuntimeBackend(whisperCliPath, whisperProbe) {
  const platform = os.platform();
  const runtimePath = String(whisperCliPath || '').toLowerCase();
  const fileNames = getRuntimeFileNames(whisperCliPath);
  const probeOutput = `${whisperProbe?.stdout || ''}\n${whisperProbe?.stderr || ''}`.toLowerCase();

  if (platform === 'darwin') {
    return os.arch() === 'arm64' ? 'metal' : 'cpu';
  }

  if (fileNames.some(fileName => fileName.includes('ggml-cuda') || fileName.includes('cublas'))
    || runtimePath.includes('cuda')
    || runtimePath.includes('cublas')
    || /cuda|cublas/.test(probeOutput)) {
    return 'cuda';
  }

  if (fileNames.some(fileName => fileName.includes('ggml-vulkan') || fileName === 'vulkan-1.dll')
    || runtimePath.includes('vulkan')
    || /vulkan/.test(probeOutput)) {
    return 'vulkan';
  }

  if (fileNames.some(fileName => fileName.includes('ggml-metal'))
    || runtimePath.includes('metal')
    || /metal/.test(probeOutput)) {
    return 'metal';
  }

  if (fileNames.some(fileName => fileName.includes('ggml-cpu')) || /cpu/.test(probeOutput)) {
    return 'cpu';
  }

  return 'unknown';
}

function getUnsupportedRuntimeReason(runtimeBackend, hardwareInfo) {
  if (!SUPPORTED_RUNTIME_BACKENDS.has(runtimeBackend)) {
    if (runtimeBackend === 'cpu') {
      return 'Installed whisper runtime is CPU-only. Word-for-Word captions require NVIDIA CUDA, AMD Vulkan, or Apple Silicon Metal.';
    }
    return 'Installed whisper runtime does not advertise a supported accelerated backend. Word-for-Word captions require NVIDIA CUDA, AMD Vulkan, or Apple Silicon Metal.';
  }

  if (!hardwareInfo.supportedBackends.includes(runtimeBackend)) {
    return `Installed whisper runtime requires ${runtimeBackend}, but matching supported hardware was not detected.`;
  }

  return null;
}

function inferCandidateRuntimeBackend(candidate) {
  const normalized = String(candidate || '').toLowerCase();
  if (normalized.includes('whisper-cuda') || normalized.includes('cuda') || normalized.includes('cublas')) return 'cuda';
  if (normalized.includes('whisper-vulkan') || normalized.includes('vulkan')) return 'vulkan';
  if (normalized.includes('whisper-metal') || normalized.includes('metal')) return 'metal';
  return null;
}

function buildWhisperRuntimeStatus(whisperInfo, hardwareInfo = detectAcceleratedHardware()) {
  const whisperProbe = whisperInfo?.probe || null;
  const whisperInstalled = Boolean(whisperProbe?.ok && whisperInfo?.path);
  const runtimeBackend = whisperInstalled
    ? inferWhisperRuntimeBackend(whisperInfo.path, whisperProbe)
    : 'unknown';
  const unsupportedReason = whisperInstalled
    ? getUnsupportedRuntimeReason(runtimeBackend, hardwareInfo)
    : 'Whisper runtime is not installed or failed its startup check.';
  const asrSupported = whisperInstalled && !unsupportedReason;

  return {
    hardwareBackends: hardwareInfo.supportedBackends,
    hardwareDevices: hardwareInfo.devices,
    hardwareSupported: hardwareInfo.supported,
    runtimeBackend,
    runtimeFlavor: runtimeBackend,
    runtimeSupported: asrSupported,
    asrSupported,
    selectedBackend: asrSupported ? runtimeBackend : null,
    gpuBackend: runtimeBackend || 'unknown',
    unsupportedReason: unsupportedReason || null
  };
}

function resolveWhisperCli() {
  const candidates = getWhisperCliCandidates();
  const hardwareInfo = detectAcceleratedHardware();
  const resolved = [];
  const failedAccelerated = [];
  let fallback = null;

  for (const candidate of candidates) {
    if (isPathLike(candidate) && !fs.existsSync(candidate)) {
      continue;
    }

    const probe = probeWhisperCli(candidate);
    if (probe.ok) {
      const whisperInfo = { path: candidate, candidates, probe };
      whisperInfo.runtimeStatus = buildWhisperRuntimeStatus(whisperInfo, hardwareInfo);
      resolved.push(whisperInfo);
      continue;
    }

    const candidateBackend = inferCandidateRuntimeBackend(candidate);
    if (candidateBackend && hardwareInfo.supportedBackends.includes(candidateBackend)) {
      failedAccelerated.push({ path: candidate, candidates, probe });
    }

    if (!fallback && isPathLike(candidate) && fs.existsSync(candidate)) {
      fallback = { path: candidate, candidates, probe };
    }
  }

  for (const backend of hardwareInfo.supportedBackends) {
    const match = resolved.find(info => info.runtimeStatus?.asrSupported && info.runtimeStatus.runtimeBackend === backend);
    if (match) return match;
  }

  const supportedRuntime = resolved.find(info => info.runtimeStatus?.asrSupported);
  if (supportedRuntime) return supportedRuntime;

  if (failedAccelerated.length > 0) return failedAccelerated[0];

  if (resolved.length > 0) return resolved[0];
  return fallback || { path: null, candidates, probe: null, runtimeStatus: buildWhisperRuntimeStatus(null, hardwareInfo) };
}

function getWindowsLocalAppDataModelsDir() {
  if (os.platform() !== 'win32') return null;
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Whooptido', 'models');
}

function normalizePathKey(filePath) {
  const resolved = path.resolve(filePath);
  return os.platform() === 'win32' ? resolved.toLowerCase() : resolved;
}

function uniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const candidate of paths.filter(Boolean)) {
    const key = normalizePathKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function getModelSearchDirs() {
  return uniquePaths([
    MODELS_DIR,
    OLD_MODELS_DIR,
    getWindowsLocalAppDataModelsDir(),
    path.join(getExecutableDir(), 'models')
  ]);
}

function getModelDirPriority(dir) {
  const key = normalizePathKey(dir);
  if (key === normalizePathKey(MODELS_DIR)) return 400;
  const windowsModelsDir = getWindowsLocalAppDataModelsDir();
  if (windowsModelsDir && key === normalizePathKey(windowsModelsDir)) return 300;
  if (key === normalizePathKey(OLD_MODELS_DIR)) return 200;
  if (key === normalizePathKey(path.join(getExecutableDir(), 'models'))) return 100;
  return 0;
}

function getModelSource(dir) {
  const key = normalizePathKey(dir);
  if (key === normalizePathKey(MODELS_DIR)) return 'canonical';
  const windowsModelsDir = getWindowsLocalAppDataModelsDir();
  if (windowsModelsDir && key === normalizePathKey(windowsModelsDir)) return 'windows-localappdata';
  if (key === normalizePathKey(OLD_MODELS_DIR)) return 'legacy';
  if (key === normalizePathKey(path.join(getExecutableDir(), 'models'))) return 'install-dir';
  return 'other';
}

function getModelIdFromFilename(filename) {
  return MODEL_FILENAME_TO_ID[filename] || filename.replace(/^ggml-/, '').replace(/\.bin$/, '');
}

function buildModelDescriptor(dir, filename) {
  const modelPath = path.join(dir, filename);
  const stats = fs.statSync(modelPath);
  if (!stats.isFile()) return null;

  const id = getModelIdFromFilename(filename);
  return {
    id,
    name: id,
    fileName: filename,
    path: modelPath,
    size: stats.size,
    qualityRank: getModelRank(id),
    source: getModelSource(dir),
    modelsDir: dir,
    dirPriority: getModelDirPriority(dir)
  };
}

function sortModels(models) {
  return models.sort((a, b) =>
    (b.qualityRank || 0) - (a.qualityRank || 0)
    || (b.dirPriority || 0) - (a.dirPriority || 0)
    || (b.size || 0) - (a.size || 0)
  );
}

function stripInternalModelFields(model) {
  const { dirPriority, ...publicModel } = model;
  return publicModel;
}

function findInstalledModelById(modelId) {
  if (!modelId) return null;
  const normalizedModelId = String(modelId).trim();
  return listInstalledModels().find((model) => model.id === normalizedModelId) || null;
}

function getModelCandidateNames(modelId) {
  return new Set([
    ...(MODEL_ID_TO_FILENAMES[modelId] || []),
    `ggml-${modelId}.bin`
  ]);
}

function resolveModelPath(model, modelId) {
  if (model) return model;

  const installedModel = findInstalledModelById(modelId);
  if (installedModel?.path) return installedModel.path;

  return DEFAULT_MODEL;
}

function getModelRank(modelId) {
  return MODEL_QUALITY_RANK[modelId] || 0;
}

function getPlatformId() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'darwin') {
    return arch === 'arm64' ? 'macos-arm' : 'macos-intel';
  }
  if (platform === 'win32') {
    return 'windows-x64';
  }
  if (platform === 'linux') {
    return 'linux-x64';
  }
  return `${platform}-${arch}`;
}

function getDownloadFilename(modelId, url) {
  const candidateNames = MODEL_ID_TO_FILENAMES[modelId] || [];

  try {
    const downloadUrl = new URL(url);
    const filename = path.basename(downloadUrl.pathname || '');
    const resolvedModelId = MODEL_FILENAME_TO_ID[filename]
      || filename.replace(/^ggml-/, '').replace(/\.bin$/, '');

    if (filename.endsWith('.bin') && (resolvedModelId === modelId || candidateNames.includes(filename))) {
      return filename;
    }
  } catch (error) {
    log('Could not derive model filename from URL: ' + error.message);
  }

  return candidateNames[0] || `ggml-${modelId}.bin`;
}

function listInstalledModels() {
  try {
    const discovered = [];

    for (const dir of getModelSearchDirs()) {
      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir).filter((filename) => filename.endsWith('.bin'));
      for (const filename of files) {
        try {
          const model = buildModelDescriptor(dir, filename);
          if (model) discovered.push(model);
        } catch (error) {
          log('Error reading model file ' + path.join(dir, filename) + ': ' + error.message);
        }
      }
    }

    const deduped = new Map();
    for (const model of sortModels(discovered)) {
      if (!deduped.has(model.id)) {
        deduped.set(model.id, stripInternalModelFields(model));
      }
    }

    return Array.from(deduped.values());
  } catch (error) {
    log('Error listing installed models: ' + error.message);
    return [];
  }
}

// DTW preset mapping for token-level timestamps
// Maps modelId to whisper-cli DTW preset name
const DTW_PRESETS = {
  'small': 'small',
  'small.en': 'small.en',
  'medium': 'medium',
  'medium.en': 'medium.en',
  'large-v3': 'large.v3',
  'large-v3-turbo': 'large.v3.turbo'
};

function getDtwPreset(modelPath, modelId) {
  // Try to determine DTW preset from modelId first
  if (modelId && DTW_PRESETS[modelId]) {
    return DTW_PRESETS[modelId];
  }
  // Fall back to checking model path
  if (modelPath) {
    if (modelPath.includes('large-v3-turbo')) return 'large.v3.turbo';
    if (modelPath.includes('large-v3')) return 'large.v3';
    if (modelPath.includes('medium.en')) return 'medium.en';
    if (modelPath.includes('medium')) return 'medium';
    if (modelPath.includes('small.en')) return 'small.en';
    if (modelPath.includes('small')) return 'small';
  }
  // Default to large.v3.turbo since that's our default model
  return 'large.v3.turbo';
}

function parseWavHeader(buffer) {
  if (!buffer || buffer.length < 44) return null;
  try {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const byteRate = view.getUint32(28, true);
    const sampleRate = view.getUint32(24, true);
    const bitsPerSample = view.getUint16(34, true);
    const channels = view.getUint16(22, true);
    return {
      headerSize: 44,
      header: buffer.slice(0, 44),
      byteRate,
      sampleRate,
      bitsPerSample,
      channels
    };
  } catch (e) {
    return null;
  }
}

function buildWavHeader(templateHeader, dataLength) {
  const header = Buffer.from(templateHeader);
  const fileSize = dataLength + 36;
  header.writeUInt32LE(fileSize, 4);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

function shiftSegments(segments, offsetSeconds) {
  if (!Array.isArray(segments) || !offsetSeconds) return segments || [];
  return segments.map((segment) => {
    const shifted = { ...segment };
    if (typeof shifted.start === 'number') shifted.start += offsetSeconds;
    if (typeof shifted.end === 'number') shifted.end += offsetSeconds;
    if (Array.isArray(shifted.words)) {
      shifted.words = shifted.words.map((word) => {
        const next = { ...word };
        if (typeof next.start === 'number') next.start += offsetSeconds;
        if (typeof next.end === 'number') next.end += offsetSeconds;
        return next;
      });
    }
    return shifted;
  });
}

function transcribeFileWithWhisper({
  audioFilePath,
  language,
  modelId,
  modelPath,
  mode = 'accurate',
  cleanupPaths = [],
  operationKey = null,
  isCancelled = () => false
}) {
  return new Promise((resolve, reject) => {
    if (isCancelled()) {
      reject(new Error('Transcription cancelled before start'));
      return;
    }

    const lang = language || 'auto';
    const resolvedModelPath = resolveModelPath(modelPath, modelId);
    const whisperInfo = resolveWhisperCli();
    if (!whisperInfo.path || !whisperInfo.probe?.ok) {
      reject(new Error(`Whisper runtime not found. Checked: ${whisperInfo.candidates.join(', ')}`));
      return;
    }

    const runtimeStatus = whisperInfo.runtimeStatus || buildWhisperRuntimeStatus(whisperInfo);
    if (!runtimeStatus.asrSupported) {
      reject(new Error(runtimeStatus.unsupportedReason || 'Whisper runtime is not configured for a supported accelerated backend.'));
      return;
    }

    const outputBase = path.join(os.tmpdir(), `whooptido-transcription-${Date.now()}`);
    const cpuCount = os.cpus()?.length || 4;
    const configuredMaxThreads = Math.max(
      1,
      Number.parseInt(process.env.WHOOPTIDO_MAX_THREADS || '', 10) || 4
    );
    // Keep one core available by default to reduce machine lockups.
    const threadCount = Math.max(1, Math.min(configuredMaxThreads, Math.max(1, cpuCount - 1)));
    const dtwPreset = getDtwPreset(resolvedModelPath, modelId);
    const isFastMode = mode === 'fast';
    const args = [
      '-m', resolvedModelPath,
      '-l', lang,
      '-ojf',
      '-t', String(threadCount),
      '--no-prints'
    ];

    if (!isFastMode) {
      args.push(
        '--dtw', dtwPreset,      // Enable DTW for accurate token-level timestamps
        '--no-flash-attn'        // DTW requires flash attention disabled
      );
    }

    args.push('-of', outputBase, audioFilePath);

    log(`Whisper args (${isFastMode ? 'fast' : 'accurate'}): ${args.join(' ')}`);

    const startTime = Date.now();
    const whisper = spawn(whisperInfo.path, args, getWhisperExecutionOptions(whisperInfo.path));
    registerWhisperProcess(operationKey, whisper);
    let stderr = '';

    whisper.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    whisper.on('close', (code) => {
      clearWhisperProcess(operationKey);
      const duration = Date.now() - startTime;

      cleanupPaths.forEach((filePath) => {
        if (filePath && fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
        }
      });

      if (code !== 0) {
        if (isCancelled()) {
          reject(new Error('Transcription cancelled'));
          return;
        }
        reject(new Error(`Whisper failed with code ${code}: ${stderr}`));
        return;
      }

      const jsonPath = `${outputBase}.json`;
      try {
        log(`Reading transcription output: ${jsonPath}`);
        const result = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const rawSegments = result.transcription || result.segments || [];
        const segments = normalizeWhisperSegments(rawSegments);
        const text = result.text || rawSegments.map(s => s.text).join(' ');

        try { fs.unlinkSync(jsonPath); } catch (e) { /* ignore */ }

        resolve({ segments, text, duration });
      } catch (e) {
        reject(new Error(`Failed to read transcription: ${e.message}`));
      }
    });

    whisper.on('error', (err) => {
      clearWhisperProcess(operationKey);
      cleanupPaths.forEach((filePath) => {
        if (filePath && fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
        }
      });
      reject(new Error(`Failed to start whisper: ${err.message}`));
    });
  });
}

function normalizeWhisperSegments(rawSegments) {
  if (!Array.isArray(rawSegments)) return [];
  return rawSegments.map((segment) => {
    const offsets = segment.offsets || {};
    const start = typeof offsets.from === 'number' ? offsets.from / 1000 : undefined;
    const end = typeof offsets.to === 'number' ? offsets.to / 1000 : undefined;
    const words = mergeWhisperTokens(segment.tokens || []);
    return {
      start,
      end,
      text: segment.text || '',
      words
    };
  });
}

function mergeWhisperTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];

  const words = [];
  let current = null;

  for (const token of tokens) {
    const rawText = String(token.text || '');
    if (!rawText) continue;

    // Skip special tokens like [_BEG_]
    if (/^\[_.*_\]$/.test(rawText)) continue;

    const offsets = token.offsets || {};
    const tokenStart = typeof offsets.from === 'number' ? offsets.from / 1000 : undefined;
    const tokenEnd = typeof offsets.to === 'number' ? offsets.to / 1000 : undefined;

    const hasLeadingSpace = /^\s/.test(rawText);
    let trimmed = rawText.trim();
    if (!trimmed) continue;

    // Remove metadata markers like [_TT_700]
    trimmed = trimmed.replace(/\[_TT_\d+\]/g, '');
    // Strip leading/trailing music/noise markers
    trimmed = trimmed.replace(/^[♪*#]+|[♪*#]+$/g, '');
    if (!trimmed) continue;

    const isPunctuation = /^\p{P}+$/u.test(trimmed);

    if (!current) {
      current = {
        word: trimmed,
        start: tokenStart,
        end: tokenEnd,
        confidence: typeof token.p === 'number' ? token.p : 1.0,
        _logProbSum: typeof token.p === 'number' ? Math.log(Math.max(token.p, 1e-10)) : 0,
        _pieceCount: 1
      };
      continue;
    }

    if (hasLeadingSpace && !isPunctuation) {
      // Finalize geometric mean probability before pushing
      if (current._pieceCount > 1) {
        current.confidence = Math.exp(current._logProbSum / current._pieceCount);
      }
      delete current._logProbSum;
      delete current._pieceCount;
      words.push(current);
      current = {
        word: trimmed,
        start: tokenStart,
        end: tokenEnd,
        confidence: typeof token.p === 'number' ? token.p : 1.0,
        _logProbSum: typeof token.p === 'number' ? Math.log(Math.max(token.p, 1e-10)) : 0,
        _pieceCount: 1
      };
      continue;
    }

    // Append to current word (BPE continuation token)
    current.word += trimmed;
    if (typeof tokenEnd === 'number') current.end = tokenEnd;
    if (typeof token.p === 'number') {
      current._logProbSum += Math.log(Math.max(token.p, 1e-10));
      current._pieceCount++;
    }
  }

  if (current) {
    // Finalize geometric mean probability for last word
    if (current._pieceCount > 1) {
      current.confidence = Math.exp(current._logProbSum / current._pieceCount);
    }
    delete current._logProbSum;
    delete current._pieceCount;
    words.push(current);
  }
  return words;
}

log('=== Whooptido Companion started (chrome-native-messaging) ===');
log(`Node version: ${process.version}`);
log(`Platform: ${process.platform} ${process.arch}`);

const chunkSessions = new Map();
const directSessions = new Map();
const activeWhisperProcesses = new Map();

function removeChunkSession(sessionId) {
  const session = chunkSessions.get(sessionId);
  if (!session) return false;
  session.cancelRequested = true;
  session.status = 'cancelled';
  session.updatedAt = Date.now();
  if (session.activeOperationKey) {
    cancelWhisperOperation(session.activeOperationKey);
  }
  if (session.tempFile && fs.existsSync(session.tempFile)) {
    try { fs.unlinkSync(session.tempFile); } catch (e) { /* ignore */ }
  }
  chunkSessions.delete(sessionId);
  return true;
}

function removeDirectSession(sessionId) {
  const session = directSessions.get(sessionId);
  if (!session) return false;
  session.cancelRequested = true;
  session.status = 'cancelled';
  session.updatedAt = Date.now();
  cancelWhisperOperation(session.operationKey);
  directSessions.delete(sessionId);
  return true;
}

function preemptOtherSessions(currentSessionId) {
  const cancelled = [];

  for (const sessionId of Array.from(chunkSessions.keys())) {
    if (sessionId === currentSessionId) continue;
    if (removeChunkSession(sessionId)) {
      cancelled.push(sessionId);
    }
  }

  for (const sessionId of Array.from(directSessions.keys())) {
    if (sessionId === currentSessionId) continue;
    if (removeDirectSession(sessionId)) {
      cancelled.push(sessionId);
    }
  }

  if (cancelled.length > 0) {
    log(`Preempted ${cancelled.length} stale ASR session(s): ${cancelled.join(', ')}`);
  }
}

function registerWhisperProcess(operationKey, proc) {
  if (!operationKey || !proc) return;
  activeWhisperProcesses.set(operationKey, proc);
}

function clearWhisperProcess(operationKey) {
  if (!operationKey) return;
  activeWhisperProcesses.delete(operationKey);
}

function cancelWhisperOperation(operationKey) {
  if (!operationKey) return false;
  const proc = activeWhisperProcesses.get(operationKey);
  if (!proc) return false;
  try {
    proc.kill('SIGTERM');
    setTimeout(() => {
      try {
        if (!proc.killed) proc.kill('SIGKILL');
      } catch (error) {
        // ignore
      }
    }, 3000);
    return true;
  } catch (error) {
    logError(`Failed to cancel whisper operation ${operationKey}: ${error.message}`);
    return false;
  }
}

function pauseWhisperOperation(operationKey) {
  if (!operationKey) return false;
  const proc = activeWhisperProcesses.get(operationKey);
  if (!proc) return false;
  try {
    proc.kill('SIGSTOP');
    return true;
  } catch (error) {
    logError(`Failed to pause whisper operation ${operationKey}: ${error.message}`);
    return false;
  }
}

function resumeWhisperOperation(operationKey) {
  if (!operationKey) return false;
  const proc = activeWhisperProcesses.get(operationKey);
  if (!proc) return false;
  try {
    proc.kill('SIGCONT');
    return true;
  } catch (error) {
    logError(`Failed to resume whisper operation ${operationKey}: ${error.message}`);
    return false;
  }
}

// Migrate models from old ~/whisper-models/ to ~/.whooptido/models/ (one-time)
function migrateOldModelsDir() {
  try {
    if (!fs.existsSync(OLD_MODELS_DIR)) return;
    if (!fs.existsSync(MODELS_DIR)) {
      fs.mkdirSync(MODELS_DIR, { recursive: true });
    }
    const files = fs.readdirSync(OLD_MODELS_DIR).filter(f => f.endsWith('.bin'));
    for (const f of files) {
      const src = path.join(OLD_MODELS_DIR, f);
      const dst = path.join(MODELS_DIR, f);
      if (!fs.existsSync(dst)) {
        fs.renameSync(src, dst);
        log('Migrated model: ' + f + ' → ' + MODELS_DIR);
      }
    }
    // Remove old dir if empty (ignore .DS_Store)
    const remaining = fs.readdirSync(OLD_MODELS_DIR).filter(f => f !== '.DS_Store');
    if (remaining.length === 0) {
      fs.rmSync(OLD_MODELS_DIR, { recursive: true, force: true });
      log('Removed empty legacy models dir: ' + OLD_MODELS_DIR);
    }
  } catch (e) {
    log('Model migration error (non-fatal): ' + e.message);
  }
}
migrateOldModelsDir();

// Use the chrome-native-messaging Transform stream pattern
const inputStream = new nativeMessage.Input();
const transformStream = new nativeMessage.Transform(function(msg, push, done) {
  log(`Received: ${JSON.stringify(msg).substring(0, 500)}`);
  
  try {
    handleMessage(msg, push, done);
  } catch (err) {
    logError(`Error handling message: ${err.message}\n${err.stack}`);
    push({ error: err.message, type: 'error' });
    done();
  }
});
const outputStream = new nativeMessage.Output();

// Monitor stream state
process.stdin.on('close', () => log('stdin closed'));
process.stdin.on('end', () => log('stdin ended'));
process.stdout.on('close', () => log('stdout closed'));
process.stdout.on('error', (err) => log(`stdout error: ${err.message}`));

process.stdin
  .pipe(inputStream)
  .pipe(transformStream)
  .pipe(outputStream)
  .pipe(process.stdout);

function cleanupAllOperations() {
  for (const sessionId of Array.from(chunkSessions.keys())) {
    const session = chunkSessions.get(sessionId);
    if (session?.activeOperationKey) {
      cancelWhisperOperation(session.activeOperationKey);
    }
    if (session?.tempFile && fs.existsSync(session.tempFile)) {
      try { fs.unlinkSync(session.tempFile); } catch (e) { /* ignore */ }
    }
    chunkSessions.delete(sessionId);
  }

  for (const sessionId of Array.from(directSessions.keys())) {
    const session = directSessions.get(sessionId);
    cancelWhisperOperation(session?.operationKey);
    directSessions.delete(sessionId);
  }

  for (const operationKey of Array.from(activeWhisperProcesses.keys())) {
    cancelWhisperOperation(operationKey);
    clearWhisperProcess(operationKey);
  }
}

// Handle SIGTERM/SIGINT gracefully
process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down');
  cleanupAllOperations();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT, shutting down');
  cleanupAllOperations();
  process.exit(0);
});

// Catch uncaught exceptions
process.on('uncaughtException', (err) => {
  logError(`Uncaught exception: ${err.message}\n${err.stack}`);
  process.exit(1);
});

/**
 * Handle incoming messages
 */
function handleMessage(msg, push, done) {
  const msgType = msg.type || 'unknown';
  
  switch (msgType) {
    case 'ping':
      push({ type: 'pong', version: HOST_VERSION });
      done();
      break;
      
    case 'status':
      handleStatus(push);
      done();
      break;
      
    case 'listModels':
      handleListModels(push);
      done();
      break;

    case 'delete_model':
      handleDeleteModel(msg, push);
      done();
      break;
      
    case 'download_model':
      handleDownloadModel(msg, push, done);
      // Note: done() called asynchronously after download
      break;
      
    case 'transcribe':
      handleTranscribe(msg, push, done);
      // Note: done() called asynchronously after transcription
      break;

    case 'transcribe_init':
      handleTranscribeInit(msg, push, done);
      break;

    case 'transcribe_chunk':
      handleTranscribeChunk(msg, push, done);
      break;

    case 'transcribe_complete':
      handleTranscribeComplete(msg, push, done);
      break;

    case 'transcribe_cancel':
      handleTranscribeCancel(msg, push, done);
      break;

    case 'transcribe_pause':
      handleTranscribePause(msg, push, done);
      break;

    case 'transcribe_resume':
      handleTranscribeResume(msg, push, done);
      break;

    case 'transcribe_status':
      handleTranscribeStatus(msg, push, done);
      break;

    case 'transcribe_cleanup':
      handleTranscribeCleanup(msg, push, done);
      break;

    case 'uninstall':
      handleUninstall(msg, push, done);
      break;
      
    default:
      push({ type: 'error', error: `Unknown message type: ${msgType}` });
      done();
  }
}

/**
 * Get the native messaging host manifest path for the current platform
 * @returns {string}
 */
/**
 * Get ALL native messaging host manifest paths for the current platform.
 * Returns both user-level and system-level paths so uninstall cleans everything.
 * @returns {string[]}
 */
function getAllNativeMessagingManifestPaths() {
  const home = os.homedir();
  const platform = os.platform();
  const paths = [];

  switch (platform) {
    case 'darwin':
      paths.push(path.join(home, 'Library', 'Application Support', 'Google', 'Chrome',
        'NativeMessagingHosts', 'com.whooptido.companion.json'));
      // System-wide path (may require elevated permissions)
      paths.push('/Library/Google/Chrome/NativeMessagingHosts/com.whooptido.companion.json');
      break;
    case 'linux':
      paths.push(path.join(home, '.config', 'google-chrome',
        'NativeMessagingHosts', 'com.whooptido.companion.json'));
      // System-wide path
      paths.push('/etc/opt/chrome/native-messaging-hosts/com.whooptido.companion.json');
      break;
    case 'win32':
      paths.push(path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
        'Google', 'Chrome', 'User Data', 'NativeMessagingHosts', 'com.whooptido.companion.json'));
      break;
  }

  return paths;
}

/**
 * Handle self-uninstall request from the extension.
 * Removes: native messaging manifest, whisper models, temp files, then companion directory.
 * Sends ack response BEFORE deleting self, then exits.
 */
/**
 * Handle self-uninstall request from the extension.
 * Since all Whooptido files live under ~/.whooptido/ (binary, models, logs),
 * uninstall is straightforward: remove NM manifests, clean temp files,
 * send ack, then rm -rf the entire Whooptido directory.
 */
function handleUninstall(msg, push, done) {
  const errors = [];
  const deleted = [];

  // 1. Remove ALL native messaging manifests (user-level AND system-level)
  const manifestPaths = getAllNativeMessagingManifestPaths();
  for (const manifestPath of manifestPaths) {
    try {
      if (fs.existsSync(manifestPath)) {
        fs.unlinkSync(manifestPath);
        deleted.push('manifest: ' + manifestPath);
        log('Uninstall: removed manifest at ' + manifestPath);
      }
    } catch (e) {
      // System-level path may require root — log but don't treat as fatal
      if (manifestPath.startsWith('/Library') || manifestPath.startsWith('/etc')) {
        log('Uninstall: skipped system manifest (permission denied): ' + manifestPath);
      } else {
        errors.push('manifest: ' + e.message);
        log('Uninstall: failed to remove manifest: ' + e.message);
      }
    }
  }

  // 2. Clean up temp files
  try {
    const tmpDir = os.tmpdir();
    const tmpFiles = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('whooptido-'));
    for (const f of tmpFiles) {
      try {
        const fullPath = path.join(tmpDir, f);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullPath);
        }
      } catch (e) {
        // Best-effort cleanup — ignore individual file errors
      }
    }
    if (tmpFiles.length > 0) {
      deleted.push('temp: ' + tmpFiles.length + ' files');
    }
    log('Uninstall: cleaned ' + tmpFiles.length + ' temp files');
  } catch (e) {
    // ignore
  }

  // 3. On Windows, remove registry entry for native messaging
  if (os.platform() === 'win32') {
    try {
      const { execSync } = require('child_process');
      execSync('reg delete "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.whooptido.companion" /f', { stdio: 'pipe' });
      deleted.push('registry: com.whooptido.companion');
      log('Uninstall: removed registry entry');
    } catch (e) {
      log('Uninstall: registry removal skipped (may not exist): ' + e.message);
    }
  }

  // 4. Clean up legacy ~/whisper-models/ directory (from pre-1.1.0 installs)
  try {
    if (fs.existsSync(OLD_MODELS_DIR)) {
      fs.rmSync(OLD_MODELS_DIR, { recursive: true, force: true });
      deleted.push('legacy models dir: ' + OLD_MODELS_DIR);
      log('Uninstall: removed legacy models dir at ' + OLD_MODELS_DIR);
    }
  } catch (e) {
    log('Uninstall: failed to remove legacy models dir: ' + e.message);
  }

  // 5. Send success ack BEFORE self-deletion
  push({
    type: 'uninstall_ack',
    success: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
    deleted: deleted
  });
  done();

  // 6. Delete entire ~/.whooptido/ directory (binary, models, everything)
  const platform = os.platform();

  if (platform === 'win32') {
    // Windows: can't delete running exe — spawn detached cleanup script
    try {
      const batContent = '@echo off\r\ntimeout /t 2 /nobreak >nul\r\nrmdir /s /q "' + WHOOPTIDO_DIR + '"\r\n';
      const batPath = path.join(os.tmpdir(), 'whooptido-cleanup.bat');
      fs.writeFileSync(batPath, batContent);
      const { spawn } = require('child_process');
      spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore' }).unref();
      log('Uninstall: spawned Windows cleanup script');
    } catch (e) {
      log('Uninstall: Windows cleanup script failed: ' + e.message);
    }
  } else {
    // macOS/Linux: safe to delete self while running (inode-based filesystem)
    try {
      if (fs.existsSync(WHOOPTIDO_DIR)) {
        fs.rmSync(WHOOPTIDO_DIR, { recursive: true, force: true });
        log('Uninstall: removed ' + WHOOPTIDO_DIR);
      }
    } catch (e) {
      log('Uninstall: failed to remove companion dir: ' + e.message);
    }
  }

  // 7. Exit after a short delay to ensure ack is flushed
  log('Uninstall: complete — exiting');
  setTimeout(() => process.exit(0), 200);
}

/**
 * Check if whisper-cli and models are available
 */
function handleStatus(push) {
  let whisperInstalled = false;
  let whisperError = null;
  const whisperInfo = resolveWhisperCli();
  const whisperProbe = whisperInfo.probe || null;

  if (whisperProbe?.ok) {
    whisperInstalled = true;
  } else if (whisperInfo.path) {
    const probeDetail = whisperProbe
      ? [
          whisperProbe.message,
          whisperProbe.exitCode !== null ? `exit=${whisperProbe.exitCode}` : null,
          whisperProbe.signal ? `signal=${whisperProbe.signal}` : null,
          whisperProbe.stderr || whisperProbe.stdout || null
        ].filter(Boolean).join(' | ')
      : 'no probe detail';
    whisperError = `Whisper runtime failed health check at ${whisperInfo.path}: ${probeDetail}`;
  } else {
    whisperError = `Whisper runtime not found. Checked: ${whisperInfo.candidates.join(', ')}`;
  }

  const models = listInstalledModels();
  const activeModel = models[0] || null;
  const runtimeStatus = whisperInfo.runtimeStatus || buildWhisperRuntimeStatus(whisperInfo);
  const gpuBackend = runtimeStatus.gpuBackend || 'unknown';
  const health = whisperInstalled && runtimeStatus.asrSupported ? 'ok' : 'degraded';
  const installState = health === 'ok' ? 'installed' : 'installed-degraded';
  const errors = [whisperError, runtimeStatus.unsupportedReason].filter(Boolean);

  push({
    type: 'status',
    installed: true,
    reachable: true,
    protocolVersion: 2,
    hostVersion: HOST_VERSION,
    version: HOST_VERSION,
    platform: getPlatformId(),
    installState,
    health,
    whisperInstalled,
    modelInstalled: models.length > 0,
    modelPath: activeModel?.path || DEFAULT_MODEL,
    modelsDir: MODELS_DIR,
    modelSearchDirs: getModelSearchDirs(),
    models,
    activeModelId: activeModel?.id || null,
    whisperPath: whisperInfo.path || null,
    whisperProbe,
    gpuBackend,
    hardwareBackends: runtimeStatus.hardwareBackends,
    hardwareDevices: runtimeStatus.hardwareDevices,
    hardwareSupported: runtimeStatus.hardwareSupported,
    runtimeBackend: runtimeStatus.runtimeBackend,
    runtimeFlavor: runtimeStatus.runtimeFlavor,
    runtimeSupported: runtimeStatus.runtimeSupported,
    asrSupported: runtimeStatus.asrSupported,
    selectedBackend: runtimeStatus.selectedBackend,
    unsupportedReason: runtimeStatus.unsupportedReason,
    acceleratedBackendsRequired: true,
    errors
  });

  if (whisperInstalled && runtimeStatus.asrSupported) {
    log('Status check: host reachable, accelerated whisper installed, models=' + models.length + ', backend=' + gpuBackend);
  } else {
    log('Status check: host reachable, ASR degraded - ' + errors.join(' | '));
  }
}

/**
 * List available Whisper models
 */
function handleListModels(push) {
  try {
    const models = listInstalledModels();
    push({ type: 'models', models, modelSearchDirs: getModelSearchDirs() });
    log(`Listed ${models.length} models`);
  } catch (e) {
    push({ type: 'models', models: [], modelSearchDirs: getModelSearchDirs(), error: e.message });
    log('Error listing models: ' + e.message);
  }
}

function handleDeleteModel(msg, push) {
  const modelId = String(msg.modelId || '').trim();

  if (!modelId) {
    push({ type: 'delete_model_ack', success: false, error: 'Missing modelId' });
    return;
  }

  try {
    const candidateNames = getModelCandidateNames(modelId);

    const deleted = [];
    for (const dir of getModelSearchDirs()) {
      if (!fs.existsSync(dir)) continue;

      const presentFiles = fs.readdirSync(dir);
      for (const fileName of presentFiles) {
        const derivedId = getModelIdFromFilename(fileName);
        if (!candidateNames.has(fileName) && derivedId !== modelId) {
          continue;
        }

        const filePath = path.join(dir, fileName);
        if (!fs.existsSync(filePath)) {
          continue;
        }

        fs.unlinkSync(filePath);
        deleted.push(filePath);
        log('Deleted model file: ' + filePath);
      }
    }

    push({
      type: 'delete_model_ack',
      success: true,
      deleted
    });
  } catch (error) {
    log('Delete model error: ' + error.message);
    push({
      type: 'delete_model_ack',
      success: false,
      error: error.message
    });
  }
}

function downloadFile(url, destinationPath, expectedSize, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many redirects while downloading model'));
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      reject(new Error(`Invalid model download URL: ${error.message}`));
      return;
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      reject(new Error(`Unsupported model download protocol: ${parsedUrl.protocol}`));
      return;
    }

    const client = parsedUrl.protocol === 'http:' ? http : https;
    const request = client.get(parsedUrl, (response) => {
      const statusCode = response.statusCode || 0;

      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, parsedUrl).toString();
        downloadFile(nextUrl, destinationPath, expectedSize, redirectCount + 1).then(resolve, reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Model download failed: HTTP ${statusCode}`));
        return;
      }

      const tempPath = `${destinationPath}.part`;
      const fileStream = fs.createWriteStream(tempPath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => {
          try {
            const stats = fs.statSync(tempPath);
            if (expectedSize && Math.abs(stats.size - expectedSize) > 1000) {
              fs.unlinkSync(tempPath);
              reject(new Error(`Model download size mismatch: expected ${expectedSize}, got ${stats.size}`));
              return;
            }

            if (fs.existsSync(destinationPath)) {
              fs.unlinkSync(destinationPath);
            }
            fs.renameSync(tempPath, destinationPath);
            resolve(stats.size);
          } catch (error) {
            reject(error);
          }
        });
      });

      fileStream.on('error', (error) => {
        try { fs.unlinkSync(tempPath); } catch (cleanupError) { /* ignore */ }
        reject(error);
      });
    });

    request.setTimeout(3600000, () => {
      request.destroy(new Error('Model download timeout'));
    });

    request.on('error', reject);
  });
}

/**
 * Download a model from URL
 */
function handleDownloadModel(msg, push, done) {
  const { modelId, url, size } = msg;
  const expectedSize = Number.isFinite(Number(size)) ? Number(size) : null;

  const filename = getDownloadFilename(modelId, url);
  const modelPath = path.join(MODELS_DIR, filename);
  
  log(`Download requested: ${modelId} from ${url}`);

  const existingModel = findInstalledModelById(modelId);
  if (existingModel && (!expectedSize || Math.abs(existingModel.size - expectedSize) < 1000)) {
    push({
      type: 'download_complete',
      success: true,
      modelId,
      path: existingModel.path,
      size: existingModel.size,
      message: 'Model already installed'
    });
    done();
    return;
  }
  
  // Ensure models directory exists
  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    log(`Created models directory: ${MODELS_DIR}`);
  }
  
  // Check if already exists
  if (fs.existsSync(modelPath)) {
    const stats = fs.statSync(modelPath);
    if (!expectedSize || Math.abs(stats.size - expectedSize) < 1000) {
      push({ 
        type: 'download_complete',
        success: true, 
        modelId, 
        path: modelPath,
        message: 'Model already downloaded'
      });
      done();
      return;
    }
  }
  
  (async () => {
    try {
      const downloadedSize = await downloadFile(url, modelPath, expectedSize);

      if (fs.existsSync(modelPath)) {
        const stats = fs.statSync(modelPath);
        const finalSize = stats.size || downloadedSize;
        push({
          type: 'download_complete',
          success: true,
          modelId,
          path: modelPath,
          size: finalSize
        });
        log(`Download complete: ${modelPath}`);
      } else {
        throw new Error('Download completed but file not found');
      }
    } catch (e) {
      // Clean up partial download
      try {
        if (fs.existsSync(modelPath)) fs.unlinkSync(modelPath);
        if (fs.existsSync(`${modelPath}.part`)) fs.unlinkSync(`${modelPath}.part`);
      } catch (cleanupErr) { /* ignore */ }

      push({ 
        type: 'download_error',
        success: false,
        modelId,
        error: e.message
      });
      log(`Download error: ${e.message}`);
    } finally {
      done();
    }
  })();
}

/**
 * Transcribe audio with Whisper
 */
function handleTranscribe(msg, push, done) {
  const { audioPath, audio, language, model, modelId, id, cleanupPath } = msg;
  const sessionId = id || `direct_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const operationKey = `direct:${sessionId}`;
  preemptOtherSessions(sessionId);
  
  let audioFilePath = audioPath;
  let tempFile = null;
  
  // If base64 audio data provided, write to temp file
  if (audio && !audioPath) {
    tempFile = path.join(os.tmpdir(), `whooptido-audio-${Date.now()}.wav`);
    try {
      const audioBuffer = Buffer.from(audio, 'base64');
      fs.writeFileSync(tempFile, audioBuffer);
      audioFilePath = tempFile;
      log(`Wrote ${audioBuffer.length} bytes to temp file: ${tempFile}`);
    } catch (e) {
      push({ id: sessionId, type: 'transcription_error', error: `Failed to write audio: ${e.message}` });
      done();
      return;
    }
  }
  
  if (!audioFilePath || !fs.existsSync(audioFilePath)) {
    push({ id: sessionId, type: 'transcription_error', error: `Audio file not found: ${audioFilePath}` });
    done();
    return;
  }
  
  const lang = language || 'auto';
  const resolvedModelPath = resolveModelPath(model, modelId);
  log(`Transcribing: ${audioFilePath} with model=${resolvedModelPath} language=${lang}`);
  directSessions.set(sessionId, {
    id: sessionId,
    operationKey,
    status: 'running',
    cancelRequested: false,
    pauseRequested: false,
    startedAt: Date.now(),
    updatedAt: Date.now()
  });

  (async () => {
    try {
      const result = await transcribeFileWithWhisper({
        audioFilePath,
        language: lang,
        modelId,
        modelPath: resolvedModelPath,
        cleanupPaths: [tempFile, cleanupPath],
        operationKey,
        isCancelled: () => !!directSessions.get(sessionId)?.cancelRequested
      });

      const session = directSessions.get(sessionId);
      if (session?.cancelRequested) {
        throw new Error('Transcription cancelled');
      }

      const segmentCount = result.segments.length;
      const response = {
        id: sessionId,
        type: 'transcription',
        duration: result.duration,
        segments: result.segments,
        text: result.text
      };
      log(`Pushing transcription response: id=${sessionId} segments=${segmentCount} textLen=${response.text?.length || 0}`);
      push(response);
      log(`Push completed for id=${sessionId}`);
    } catch (e) {
      log(`Error reading transcription: ${e.message}`);
      push({
        id: sessionId,
        type: 'transcription_error',
        error: e.message
      });
    } finally {
      directSessions.delete(sessionId);
      clearWhisperProcess(operationKey);
    }

    log(`Calling done() for id=${sessionId}`);
    done();
  })();
}

function handleTranscribeInit(msg, push, done) {
  const { id, totalBytes, totalChunks, chunkBytes, language, modelId, mode } = msg;
  if (!id) {
    push({ id, type: 'transcribe_init_ack', error: 'Missing id' });
    done();
    return;
  }
  preemptOtherSessions(id);
  removeChunkSession(id);
  removeDirectSession(id);

  const tempFile = path.join(os.tmpdir(), `whooptido-audio-chunked-${id}.wav`);

  try {
    fs.writeFileSync(tempFile, Buffer.alloc(0));
    chunkSessions.set(id, {
      id,
      tempFile,
      totalBytes,
      totalChunks,
      chunkBytes,
      receivedBytes: 0,
      bytesConsumed: 0,
      byteRate: null,
      wavHeader: null,
      headerParsed: false,
      segments: [],
      textParts: [],
      language,
      modelId,
      mode: mode === 'fast' ? 'fast' : 'accurate',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'running',
      cancelRequested: false,
      pauseRequested: false,
      activeOperationKey: null
    });
    log(`Chunked init: id=${id} totalBytes=${totalBytes} totalChunks=${totalChunks} chunkBytes=${chunkBytes} mode=${mode === 'fast' ? 'fast' : 'accurate'}`);
    push({ id, type: 'transcribe_init_ack', success: true });
  } catch (e) {
    logError(`Chunked init error: ${e.message}`);
    push({ id, type: 'transcribe_init_ack', error: e.message });
  }

  done();
}

function handleTranscribeChunk(msg, push, done) {
  const { id, data, byteLength, index, totalChunks } = msg;
  const session = chunkSessions.get(id);
  if (!session) {
    push({ id, type: 'transcribe_chunk_ack', error: 'Session not found' });
    done();
    return;
  }

  (async () => {
    try {
      if (session.cancelRequested) {
        push({ id, type: 'transcribe_chunk_ack', error: 'Session cancelled' });
        done();
        return;
      }
      if (session.pauseRequested) {
        push({ id, type: 'transcribe_chunk_ack', error: 'Session paused' });
        done();
        return;
      }

      session.updatedAt = Date.now();
      const buffer = Buffer.from(data, 'base64');
      fs.appendFileSync(session.tempFile, buffer);
      session.receivedBytes += buffer.length;

      if (!session.headerParsed) {
        const headerInfo = parseWavHeader(buffer);
        if (!headerInfo) {
          throw new Error('Failed to parse WAV header from first chunk');
        }
        session.wavHeader = headerInfo.header;
        session.byteRate = headerInfo.byteRate;
        session.headerParsed = true;
      }

      let pcmBuffer = buffer;
      if (index === 0 && session.wavHeader) {
        pcmBuffer = buffer.slice(session.wavHeader.length);
      }

      const offsetSeconds = session.byteRate ? (session.bytesConsumed / session.byteRate) : 0;
      const chunkPath = path.join(os.tmpdir(), `whooptido-audio-chunk-${id}-${index}.wav`);
      const header = buildWavHeader(session.wavHeader, pcmBuffer.length);
      fs.writeFileSync(chunkPath, Buffer.concat([header, pcmBuffer]));
      const operationKey = `chunk:${id}:${index}`;
      session.activeOperationKey = operationKey;

      const chunkResult = await transcribeFileWithWhisper({
        audioFilePath: chunkPath,
        language: session.language,
        modelId: session.modelId,
        mode: session.mode,
        cleanupPaths: [chunkPath],
        operationKey,
        isCancelled: () => !!chunkSessions.get(id)?.cancelRequested
      });
      session.activeOperationKey = null;

      const shiftedSegments = shiftSegments(chunkResult.segments, offsetSeconds);
      session.segments.push(...shiftedSegments);
      if (chunkResult.text) {
        session.textParts.push(chunkResult.text);
      }
      session.bytesConsumed += pcmBuffer.length;

      if (index === 0 || (index + 1) === totalChunks || (index + 1) % 10 === 0) {
        log(`Chunked progress: id=${id} chunk=${index + 1}/${totalChunks} received=${session.receivedBytes}`);
      }

      push({
        id,
        type: 'transcribe_chunk_ack',
        success: true,
        receivedBytes: session.receivedBytes,
        byteLength,
        processedSegments: shiftedSegments.length,
        segments: shiftedSegments,
        text: chunkResult.text
      });
    } catch (e) {
      session.activeOperationKey = null;
      logError(`Chunked processing error: ${e.message}`);
      push({ id, type: 'transcribe_chunk_ack', error: e.message });
    }

    done();
  })();
}

function handleTranscribeComplete(msg, push, done) {
  const { id } = msg;
  const session = chunkSessions.get(id);
  if (!session) {
    push({ id, type: 'transcription_error', error: 'Session not found' });
    done();
    return;
  }

  const durationMs = Date.now() - session.startedAt;
  log(`Chunked complete: id=${id} received=${session.receivedBytes}/${session.totalBytes} in ${durationMs}ms`);

  if (session.cancelRequested) {
    if (session.tempFile && fs.existsSync(session.tempFile)) {
      try { fs.unlinkSync(session.tempFile); } catch (e) { /* ignore */ }
    }
    chunkSessions.delete(id);
    push({ id, type: 'transcription_error', error: 'Session cancelled' });
    done();
    return;
  }

  const segments = session.segments.sort((a, b) => (a.start || 0) - (b.start || 0));
  const text = session.textParts.join(' ').replace(/\s+/g, ' ').trim();
  const durationSeconds = session.byteRate ? (session.bytesConsumed / session.byteRate) : undefined;

  if (session.tempFile && fs.existsSync(session.tempFile)) {
    try { fs.unlinkSync(session.tempFile); } catch (e) { /* ignore */ }
  }

  chunkSessions.delete(id);

  push({
    id,
    type: 'transcription',
    duration: durationSeconds ? Math.round(durationSeconds * 1000) : durationMs,
    segments,
    text
  });
  done();
}

function handleTranscribeCancel(msg, push, done) {
  const { id } = msg;
  const cancelled = [];

  const cancelChunkSession = (sessionId) => {
    const session = chunkSessions.get(sessionId);
    if (!session) return false;
    session.cancelRequested = true;
    session.status = 'cancelled';
    session.updatedAt = Date.now();
    if (session.activeOperationKey) {
      cancelWhisperOperation(session.activeOperationKey);
    }
    cancelled.push(sessionId);
    return true;
  };

  const cancelDirectSession = (sessionId) => {
    const session = directSessions.get(sessionId);
    if (!session) return false;
    session.cancelRequested = true;
    session.status = 'cancelled';
    session.updatedAt = Date.now();
    cancelWhisperOperation(session.operationKey);
    cancelled.push(sessionId);
    return true;
  };

  if (id) {
    cancelChunkSession(id);
    cancelDirectSession(id);
  } else {
    for (const sessionId of chunkSessions.keys()) {
      cancelChunkSession(sessionId);
    }
    for (const sessionId of directSessions.keys()) {
      cancelDirectSession(sessionId);
    }
  }

  push({
    id: id || null,
    type: 'transcribe_cancel_ack',
    success: true,
    cancelled
  });
  done();
}

function handleTranscribePause(msg, push, done) {
  const { id } = msg;
  const paused = [];

  const pauseChunkSession = (sessionId) => {
    const session = chunkSessions.get(sessionId);
    if (!session) return false;
    session.pauseRequested = true;
    session.status = 'paused';
    session.updatedAt = Date.now();
    if (session.activeOperationKey) {
      pauseWhisperOperation(session.activeOperationKey);
    }
    paused.push(sessionId);
    return true;
  };

  const pauseDirectSession = (sessionId) => {
    const session = directSessions.get(sessionId);
    if (!session) return false;
    session.pauseRequested = true;
    session.status = 'paused';
    session.updatedAt = Date.now();
    pauseWhisperOperation(session.operationKey);
    paused.push(sessionId);
    return true;
  };

  if (id) {
    pauseChunkSession(id);
    pauseDirectSession(id);
  } else {
    for (const sessionId of chunkSessions.keys()) {
      pauseChunkSession(sessionId);
    }
    for (const sessionId of directSessions.keys()) {
      pauseDirectSession(sessionId);
    }
  }

  push({
    id: id || null,
    type: 'transcribe_pause_ack',
    success: true,
    paused
  });
  done();
}

function handleTranscribeResume(msg, push, done) {
  const { id } = msg;
  const resumed = [];

  const resumeChunkSession = (sessionId) => {
    const session = chunkSessions.get(sessionId);
    if (!session) return false;
    session.pauseRequested = false;
    session.status = 'running';
    session.updatedAt = Date.now();
    if (session.activeOperationKey) {
      resumeWhisperOperation(session.activeOperationKey);
    }
    resumed.push(sessionId);
    return true;
  };

  const resumeDirectSession = (sessionId) => {
    const session = directSessions.get(sessionId);
    if (!session) return false;
    session.pauseRequested = false;
    session.status = 'running';
    session.updatedAt = Date.now();
    resumeWhisperOperation(session.operationKey);
    resumed.push(sessionId);
    return true;
  };

  if (id) {
    resumeChunkSession(id);
    resumeDirectSession(id);
  } else {
    for (const sessionId of chunkSessions.keys()) {
      resumeChunkSession(sessionId);
    }
    for (const sessionId of directSessions.keys()) {
      resumeDirectSession(sessionId);
    }
  }

  push({
    id: id || null,
    type: 'transcribe_resume_ack',
    success: true,
    resumed
  });
  done();
}

function handleTranscribeStatus(msg, push, done) {
  const { id } = msg;
  if (id) {
    const chunk = chunkSessions.get(id);
    if (chunk) {
      push({
        id,
        type: 'transcribe_status_ack',
        success: true,
        status: chunk.status,
        mode: 'chunk',
        startedAt: chunk.startedAt,
        updatedAt: chunk.updatedAt
      });
      done();
      return;
    }

    const direct = directSessions.get(id);
    if (direct) {
      push({
        id,
        type: 'transcribe_status_ack',
        success: true,
        status: direct.status,
        mode: 'direct',
        startedAt: direct.startedAt,
        updatedAt: direct.updatedAt
      });
      done();
      return;
    }

    push({
      id,
      type: 'transcribe_status_ack',
      success: true,
      status: 'not-found'
    });
    done();
    return;
  }

  push({
    id: null,
    type: 'transcribe_status_ack',
    success: true,
    direct: Array.from(directSessions.values()).map((session) => ({
      id: session.id,
      status: session.status,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt
    })),
    chunk: Array.from(chunkSessions.values()).map((session) => ({
      id: session.id,
      status: session.status,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt
    })),
    activeProcesses: activeWhisperProcesses.size
  });
  done();
}

function handleTranscribeCleanup(msg, push, done) {
  const { id } = msg;
  const cleaned = [];

  const cleanupChunkSession = (sessionId) => {
    const session = chunkSessions.get(sessionId);
    if (!session) return false;
    session.cancelRequested = true;
    if (session.activeOperationKey) {
      cancelWhisperOperation(session.activeOperationKey);
    }
    if (session.tempFile && fs.existsSync(session.tempFile)) {
      try { fs.unlinkSync(session.tempFile); } catch (e) { /* ignore */ }
    }
    chunkSessions.delete(sessionId);
    cleaned.push(sessionId);
    return true;
  };

  const cleanupDirectSession = (sessionId) => {
    const session = directSessions.get(sessionId);
    if (!session) return false;
    session.cancelRequested = true;
    cancelWhisperOperation(session.operationKey);
    directSessions.delete(sessionId);
    cleaned.push(sessionId);
    return true;
  };

  if (id) {
    cleanupChunkSession(id);
    cleanupDirectSession(id);
  } else {
    for (const sessionId of Array.from(chunkSessions.keys())) {
      cleanupChunkSession(sessionId);
    }
    for (const sessionId of Array.from(directSessions.keys())) {
      cleanupDirectSession(sessionId);
    }
  }

  push({
    id: id || null,
    type: 'transcribe_cleanup_ack',
    success: true,
    cleaned
  });
  done();
}
