import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const AMI_URL = 'https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2002a/audio/ES2002a.Mix-Headset.wav';
const CACHE_DIR = path.resolve(ROOT, '.cache/test-audio');
const SOURCE_WAV = path.join(CACHE_DIR, 'ami-es2002a-mix-headset.wav');
const CLIP_SECONDS = Number(process.env.E2E_AMI_CLIP_SECONDS ?? 120);
const CLIP_OFFSET_SECONDS = Number(process.env.E2E_AMI_CLIP_OFFSET_SECONDS ?? 540);
const CLIP_WAV = path.join(CACHE_DIR, `ui-e2e-ami-offset-${CLIP_OFFSET_SECONDS}s-duration-${CLIP_SECONDS}s.wav`);
const PUBLIC_FIXTURE_WAV = path.resolve(ROOT, 'public/__e2e-ami.wav');
const PORT = Number(process.env.E2E_PORT ?? 5193);
const DEBUG_PORT = Number(process.env.E2E_DEBUG_PORT ?? 9293);
const WAIT_FOR_TRANSCRIPT_MS = Number(process.env.E2E_WAIT_FOR_TRANSCRIPT_MS ?? 120000);

loadLocalEnv();
if (!process.env.VITE_DEEPGRAM_API_KEY) {
  throw new Error('Missing VITE_DEEPGRAM_API_KEY in .env.local. This E2E test intentionally uses real Deepgram.');
}

await mkdir(CACHE_DIR, { recursive: true });
await ensureDownloaded(AMI_URL, SOURCE_WAV);
await writeWavClip(SOURCE_WAV, CLIP_WAV, CLIP_SECONDS, CLIP_OFFSET_SECONDS);
await writeFile(PUBLIC_FIXTURE_WAV, await readFile(CLIP_WAV));

const devServer = spawn('npm', ['run', 'dev', '--', '--port', String(PORT)], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let chrome;

function cleanup() {
  devServer.kill('SIGTERM');
  chrome?.kill('SIGTERM');
  try { rmSync(PUBLIC_FIXTURE_WAV, { force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

try {
  await waitForHttp(`http://127.0.0.1:${PORT}/`);

  const chromeArgs = [
    ...(process.env.E2E_HEADLESS === '0' ? [] : ['--headless=new']),
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    `--user-data-dir=/tmp/captiontable-real-ui-e2e-${Date.now()}`,
    `http://127.0.0.1:${PORT}/?e2eAudio=/__e2e-ami.wav`,
  ];
  chrome = spawn(CHROME_PATH, chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  const cdp = await connectToPage(`http://127.0.0.1:${DEBUG_PORT}`, PORT);

  await cdp.call('Runtime.enable');
  await cdp.call('Log.enable');
  await cdp.call('Page.enable');
  await cdp.call('Page.navigate', { url: `http://127.0.0.1:${PORT}/?e2eAudio=/__e2e-ami.wav` });
  await cdp.waitForExpression(`document.querySelector('h1')?.textContent === 'Conversation Captioner'`);

  const startState = await cdp.evaluate(`(() => ({
    startDisabled: document.querySelector('.primary-action')?.disabled ?? null,
    body: document.body.textContent,
    hasPicker: document.body.textContent.includes('Current speaker') || document.body.textContent.includes('Pick who') || !!document.querySelector('.speaker-button'),
  }))()`);

  assert(!startState.startDisabled, `Start button was disabled. Body: ${startState.body}`);
  assert(!startState.hasPicker, `Legacy speaker picker/fallback is present. Body: ${startState.body}`);
  assert(startState.body.includes('Automatic with Deepgram Nova'), `Deepgram readiness not shown. Body: ${startState.body}`);

  const buttonRect = await cdp.evaluate(`(() => {
    const button = document.querySelector('.primary-action');
    if (!button) return null;
    window.__captionTableClicked = false;
    button.addEventListener('click', () => { window.__captionTableClicked = true; }, { once: true });
    button.scrollIntoView({ block: 'center' });
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, disabled: button.disabled, text: button.textContent, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, viewport: { width: innerWidth, height: innerHeight } };
  })()`);
  assert(buttonRect && !buttonRect.disabled, `Could not click Start: ${JSON.stringify(buttonRect)}`);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: buttonRect.x, y: buttonRect.y });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: buttonRect.x, y: buttonRect.y, button: 'left', clickCount: 1 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: buttonRect.x, y: buttonRect.y, button: 'left', clickCount: 1 });
  const rawClickReceived = await cdp.evaluate(`window.__captionTableClicked === true`);
  assert(rawClickReceived, `Chrome input did not reach Start button: ${JSON.stringify(buttonRect)}`);
  const reachedActive = await cdp.waitForExpression(`!!document.querySelector('.caption-screen')`, 30000);
  if (!reachedActive) {
    const debugState = await cdp.evaluate(`(() => ({ body: document.body.textContent, location: location.href }))()`);
    throw new Error(`Clicking Start did not reach the active caption screen. Debug: ${JSON.stringify({ ...debugState, browserEvents: cdp.events }, null, 2)}`);
  }

  const audioStarted = await cdp.waitForExpression(`(() => {
    const text = document.body.textContent;
    const match = text.match(new RegExp('Audio sent: (\\\\d+) chunks / (\\\\d+) KB'));
    return !!match && Number(match[1]) > 0;
  })()`, 30000);
  if (!audioStarted) {
    const debugState = await cdp.evaluate(`(() => ({
      body: document.body.textContent,
      diagnostics: [...document.querySelectorAll('.deepgram-diagnostics span')].map((node) => node.textContent),
      meter: document.querySelector('.meter')?.getAttribute('aria-label'),
      location: location.href,
    }))()`);
    throw new Error(`Browser never sent audio chunks to Deepgram. Debug: ${JSON.stringify({ ...debugState, browserEvents: cdp.events }, null, 2)}`);
  }

  const transcriptReady = await cdp.waitForExpression(`(() => {
    const cards = [...document.querySelectorAll('.transcript-list .turn-card')];
    const speakers = new Set(cards.map((card) => card.querySelector('strong')?.textContent?.trim()).filter(Boolean));
    const text = cards.map((card) => card.textContent || '').join(' ');
    return cards.length >= 2 && speakers.size >= 2 && text.length > 60;
  })()`, WAIT_FOR_TRANSCRIPT_MS);
  if (!transcriptReady) {
    const timeoutState = await cdp.evaluate(`(() => ({
      body: document.body.textContent,
      cards: [...document.querySelectorAll('.transcript-list .turn-card')].map((card) => ({ speaker: card.querySelector('strong')?.textContent?.trim(), text: card.querySelector('p')?.textContent?.trim(), finalized: card.getAttribute('data-finalized') })),
      status: [...document.querySelectorAll('.deepgram-diagnostics span')].map((node) => node.textContent),
    }))()`);
    throw new Error(`Timed out waiting for two-speaker Deepgram transcript cards in the UI. Debug: ${JSON.stringify(timeoutState, null, 2)}`);
  }

  const finalState = await cdp.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.transcript-list .turn-card')].map((card) => ({
      speaker: card.querySelector('strong')?.textContent?.trim(),
      text: card.querySelector('p')?.textContent?.trim(),
      finalized: card.getAttribute('data-finalized'),
    }));
    const speakers = [...new Set(cards.map((card) => card.speaker).filter(Boolean))];
    const body = document.body.textContent;
    const audioMatch = body.match(new RegExp('Audio sent: (\\\\d+) chunks / (\\\\d+) KB'));
    return {
      cardCount: cards.length,
      speakers,
      cards: cards.slice(0, 8),
      activeSpeaker: document.querySelector('.active-speaker')?.textContent?.trim(),
      hasTranscriptPanel: body.includes('Full speaker transcript'),
      hasPicker: body.includes('Current speaker') || body.includes('Pick who') || !!document.querySelector('.speaker-button'),
      audioChunks: audioMatch ? Number(audioMatch[1]) : 0,
      audioKb: audioMatch ? Number(audioMatch[2]) : 0,
      status: [...document.querySelectorAll('.deepgram-diagnostics span')].map((node) => node.textContent),
    };
  })()`);

  assert(finalState.hasTranscriptPanel, 'Full speaker transcript panel is missing.');
  assert(!finalState.hasPicker, 'Legacy picker appeared after starting.');
  assert(finalState.audioChunks > 0, `Expected audio chunks > 0, got ${finalState.audioChunks}.`);
  assert(finalState.cardCount >= 2, `Expected at least two transcript cards, got ${finalState.cardCount}.`);
  assert(finalState.speakers.length >= 2, `Expected at least two automatic speaker labels, got ${finalState.speakers.join(', ')}.`);
  assert(finalState.cards.some((card) => card.text && card.text.length > 10), 'Transcript cards have no useful text.');

  console.log(JSON.stringify({ ok: true, clip: CLIP_WAV, finalState }, null, 2));
} finally {
  cleanup();
}

function loadLocalEnv() {
  const envPath = path.resolve(ROOT, '.env.local');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const equals = trimmed.indexOf('=');
    if (equals === -1) return;
    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = value;
  });
}

async function ensureDownloaded(url, outputPath) {
  if (existsSync(outputPath)) return;
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status}`);
  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
}

async function writeWavClip(sourcePath, outputPath, seconds, offsetSeconds) {
  const source = await readFile(sourcePath);
  const wav = parseWav(source);
  const offsetBytes = Math.min(wav.data.length, Math.floor(wav.fmt.byteRate * offsetSeconds / wav.fmt.blockAlign) * wav.fmt.blockAlign);
  const clipBytes = Math.min(wav.data.length - offsetBytes, Math.floor(wav.fmt.byteRate * seconds / wav.fmt.blockAlign) * wav.fmt.blockAlign);
  const clippedData = wav.data.subarray(offsetBytes, offsetBytes + clipBytes);
  await writeFile(outputPath, buildWav(wav.fmt.rawChunk, clippedData));
}

function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Source is not a RIFF/WAVE file.');
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + size;
    const chunk = buffer.subarray(chunkStart, chunkEnd);
    if (id === 'fmt ') {
      fmt = {
        rawChunk: chunk,
        audioFormat: chunk.readUInt16LE(0),
        channels: chunk.readUInt16LE(2),
        sampleRate: chunk.readUInt32LE(4),
        byteRate: chunk.readUInt32LE(8),
        blockAlign: chunk.readUInt16LE(12),
        bitsPerSample: chunk.readUInt16LE(14),
      };
    }
    if (id === 'data') {
      data = chunk;
      break;
    }
    offset = chunkEnd + (size % 2);
  }
  if (!fmt || !data) throw new Error('Could not find fmt/data chunks in WAV.');
  return { fmt, data };
}

function buildChromeFakeMicWav(fmt, data) {
  if (fmt.audioFormat !== 1 || fmt.channels !== 1 || fmt.sampleRate !== 16000 || fmt.bitsPerSample !== 16) {
    return buildWav(fmt.rawChunk, data);
  }

  const sourceSampleCount = Math.floor(data.length / 2);
  const outputSampleRate = 48000;
  const outputChannels = 2;
  const upsampleFactor = outputSampleRate / fmt.sampleRate;
  const outputData = Buffer.alloc(sourceSampleCount * upsampleFactor * outputChannels * 2);
  let outputOffset = 0;

  for (let index = 0; index < sourceSampleCount; index += 1) {
    const sample = data.readInt16LE(index * 2);
    for (let repeat = 0; repeat < upsampleFactor; repeat += 1) {
      outputData.writeInt16LE(sample, outputOffset); outputOffset += 2;
      outputData.writeInt16LE(sample, outputOffset); outputOffset += 2;
    }
  }

  const fmtChunk = Buffer.alloc(16);
  fmtChunk.writeUInt16LE(1, 0);
  fmtChunk.writeUInt16LE(outputChannels, 2);
  fmtChunk.writeUInt32LE(outputSampleRate, 4);
  fmtChunk.writeUInt32LE(outputSampleRate * outputChannels * 2, 8);
  fmtChunk.writeUInt16LE(outputChannels * 2, 12);
  fmtChunk.writeUInt16LE(16, 14);
  return buildWav(fmtChunk, outputData);
}

function buildWav(fmtChunk, data) {
  const riffSize = 4 + 8 + fmtChunk.length + 8 + data.length;
  const output = Buffer.alloc(8 + riffSize);
  let offset = 0;
  output.write('RIFF', offset); offset += 4;
  output.writeUInt32LE(riffSize, offset); offset += 4;
  output.write('WAVE', offset); offset += 4;
  output.write('fmt ', offset); offset += 4;
  output.writeUInt32LE(fmtChunk.length, offset); offset += 4;
  fmtChunk.copy(output, offset); offset += fmtChunk.length;
  output.write('data', offset); offset += 4;
  output.writeUInt32LE(data.length, offset); offset += 4;
  data.copy(output, offset);
  return output;
}

async function waitForHttp(url, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function connectToPage(debugBaseUrl, appPort) {
  const tabs = await (await fetch(`${debugBaseUrl}/json`)).json();
  const tab = tabs.find((entry) => entry.url.includes(`127.0.0.1:${appPort}`)) ?? tabs[0];
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.consoleAPICalled') {
      events.push({ method: message.method, args: message.params.args?.map((arg) => arg.value ?? arg.description), type: message.params.type });
    }
    if (message.method === 'Runtime.exceptionThrown' || message.method === 'Log.entryAdded') {
      events.push({ method: message.method, params: message.params });
    }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

  async function call(method, params = {}) {
    const callId = ++id;
    ws.send(JSON.stringify({ id: callId, method, params }));
    return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
  }

  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }

  async function waitForExpression(expression, timeoutMs = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await evaluate(expression)) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  return { call, evaluate, waitForExpression, events };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
