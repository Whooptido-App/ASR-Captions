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
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Whisper configuration
const WHISPER_CLI = '/opt/homebrew/bin/whisper-cli';
const MODELS_DIR = path.join(os.homedir(), 'whisper-models');
const DEFAULT_MODEL = path.join(MODELS_DIR, 'ggml-large-v3-turbo.bin');

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

function resolveModelPath(model, modelId) {
  if (model) return model;
  if (modelId) {
    const possiblePath = path.join(MODELS_DIR, `ggml-${modelId}.bin`);
    if (fs.existsSync(possiblePath)) return possiblePath;
  }
  return DEFAULT_MODEL;
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
    const outputBase = `/tmp/whooptido-transcription-${Date.now()}`;
    const cpuCount = os.cpus()?.length || 4;
    const configuredMaxThreads = Math.max(
      1,
      Number.parseInt(process.env.WHOOPTIDO_MAX_THREADS || '', 10) || 4
    );
    // Keep one core available by default to reduce machine lockups.
    const threadCount = Math.max(1, Math.min(configuredMaxThreads, Math.max(1, cpuCount - 1)));
    const dtwPreset = getDtwPreset(resolvedModelPath, modelId);
    const args = [
      '-m', resolvedModelPath,
      '-l', lang,
      '-ojf',
      '-t', String(threadCount),
      '--no-prints',
      '--dtw', dtwPreset,      // Enable DTW for accurate token-level timestamps
      '--no-flash-attn',       // DTW requires flash attention disabled
      '-of', outputBase,
      audioFilePath
    ];

    log(`Whisper args: ${args.join(' ')}`);

    const startTime = Date.now();
    const whisper = spawn(WHISPER_CLI, args);
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
      push({ type: 'pong', version: '1.0.0' });
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
      
    default:
      push({ type: 'error', error: `Unknown message type: ${msgType}` });
      done();
  }
}

/**
 * Check if whisper-cli and models are available
 */
function handleStatus(push) {
  try {
    execSync(`${WHISPER_CLI} --help`, { stdio: 'pipe' });
    const modelExists = fs.existsSync(DEFAULT_MODEL);
    
    // Detect GPU backend
    const gpuBackend = detectGpuBackend();
    
    push({
      type: 'status',
      whisperInstalled: true,
      modelInstalled: modelExists,
      modelPath: DEFAULT_MODEL,
      modelsDir: MODELS_DIR,
      version: '1.0.0',
      gpuBackend: gpuBackend
    });
    log('Status check: whisper installed, model=' + modelExists + ', gpu=' + gpuBackend);
  } catch (e) {
    push({
      type: 'status',
      whisperInstalled: false,
      error: e.message,
      version: '1.0.0',
      gpuBackend: 'unknown'
    });
    log('Status check: whisper not found - ' + e.message);
  }
}

/**
 * Detect the GPU backend for whisper.cpp
 * Returns: 'metal' | 'cuda' | 'vulkan' | 'cpu' | 'unknown'
 */
function detectGpuBackend() {
  try {
    // Check the platform first
    const platform = os.platform();
    
    // On macOS, whisper.cpp uses Metal by default if available
    if (platform === 'darwin') {
      // Check if Metal is available by running whisper-cli with GPU flag
      try {
        const output = execSync(`${WHISPER_CLI} --help 2>&1`, { encoding: 'utf-8' });
        // If whisper.cpp was built with Metal support, it will show in help
        if (output.includes('gpu') || output.includes('metal') || output.includes('-ng')) {
          // Check if we're on Apple Silicon
          const arch = os.arch();
          if (arch === 'arm64') {
            return 'metal';
          }
          // Intel Mac - check if Metal is supported
          return 'metal';
        }
      } catch (e) {
        // Fall through to CPU
      }
      return 'cpu';
    }
    
    // On Linux/Windows, check for CUDA or Vulkan
    if (platform === 'linux' || platform === 'win32') {
      try {
        // Check for CUDA
        const nvidiaSmi = execSync('nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null', { encoding: 'utf-8' });
        if (nvidiaSmi.trim()) {
          return 'cuda';
        }
      } catch (e) {
        // No NVIDIA GPU
      }
      
      try {
        // Check for Vulkan
        const vulkanInfo = execSync('vulkaninfo --summary 2>/dev/null | head -5', { encoding: 'utf-8' });
        if (vulkanInfo.includes('GPU')) {
          return 'vulkan';
        }
      } catch (e) {
        // No Vulkan
      }
      
      return 'cpu';
    }
    
    return 'unknown';
  } catch (e) {
    log('GPU backend detection error: ' + e.message);
    return 'unknown';
  }
}

/**
 * List available Whisper models
 */
function handleListModels(push) {
  try {
    if (!fs.existsSync(MODELS_DIR)) {
      push({ type: 'models', models: [] });
      return;
    }
    
    const files = fs.readdirSync(MODELS_DIR).filter(f => f.endsWith('.bin'));
    const models = files.map(f => {
      const fullPath = path.join(MODELS_DIR, f);
      return {
        name: f.replace('ggml-', '').replace('.bin', ''),
        path: fullPath,
        size: fs.statSync(fullPath).size
      };
    });
    
    push({ type: 'models', models });
    log(`Listed ${models.length} models`);
  } catch (e) {
    push({ type: 'models', models: [], error: e.message });
    log('Error listing models: ' + e.message);
  }
}

/**
 * Download a model from URL
 */
function handleDownloadModel(msg, push, done) {
  const { modelId, url, size } = msg;
  
  const modelFiles = {
    'small': 'ggml-small.bin',
    'medium': 'ggml-medium.bin',
    'large-v3-turbo': 'ggml-large-v3-turbo.bin'
  };
  
  const filename = modelFiles[modelId] || `ggml-${modelId}.bin`;
  const modelPath = path.join(MODELS_DIR, filename);
  
  log(`Download requested: ${modelId} from ${url}`);
  
  // Ensure models directory exists
  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    log(`Created models directory: ${MODELS_DIR}`);
  }
  
  // Check if already exists
  if (fs.existsSync(modelPath)) {
    const stats = fs.statSync(modelPath);
    if (!size || Math.abs(stats.size - size) < 1000) {
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
  
  // Download with curl
  const curlCmd = `curl -L -f -o "${modelPath}" "${url}"`;
  log(`Running: ${curlCmd}`);
  
  try {
    execSync(curlCmd, { stdio: 'pipe', timeout: 600000 });
    
    if (fs.existsSync(modelPath)) {
      const stats = fs.statSync(modelPath);
      push({ 
        type: 'download_complete',
        success: true, 
        modelId, 
        path: modelPath,
        size: stats.size
      });
      log(`Download complete: ${modelPath}`);
    } else {
      throw new Error('Download completed but file not found');
    }
  } catch (e) {
    // Clean up partial download
    try {
      if (fs.existsSync(modelPath)) fs.unlinkSync(modelPath);
    } catch (cleanupErr) { /* ignore */ }
    
    push({ 
      type: 'download_error',
      success: false,
      modelId,
      error: e.message
    });
    log(`Download error: ${e.message}`);
  }
  
  done();
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
  const { id, totalBytes, totalChunks, chunkBytes, language, modelId } = msg;
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
      startedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'running',
      cancelRequested: false,
      pauseRequested: false,
      activeOperationKey: null
    });
    log(`Chunked init: id=${id} totalBytes=${totalBytes} totalChunks=${totalChunks} chunkBytes=${chunkBytes}`);
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
