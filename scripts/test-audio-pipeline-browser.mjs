import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.AUDIO_PIPELINE_E2E_PORT ?? 5194);
const DEBUG_PORT = Number(process.env.AUDIO_PIPELINE_E2E_DEBUG_PORT ?? 9294);

const devServer = spawn('npm', ['run', 'dev', '--', '--port', String(PORT)], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let chrome;

function cleanup() {
  devServer.kill('SIGTERM');
  chrome?.kill('SIGTERM');
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

try {
  await waitForHttp(`http://127.0.0.1:${PORT}/`);
  chrome = spawn(CHROME_PATH, [
    ...(process.env.AUDIO_PIPELINE_E2E_HEADLESS === '0' ? [] : ['--headless=new']),
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--user-data-dir=/tmp/captiontable-audio-pipeline-e2e-${Date.now()}`,
    `http://127.0.0.1:${PORT}/`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  const cdp = await connectToPage(`http://127.0.0.1:${DEBUG_PORT}`, PORT);
  await cdp.call('Runtime.enable');
  await cdp.call('Log.enable');
  await cdp.call('Page.enable');
  await cdp.call('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await cdp.waitForExpression(`document.querySelector('h1')?.textContent === 'Conversation Captioner'`);

  const result = await cdp.evaluate(`(async () => {
    const { BrowserAudioPipeline } = await import('/src/audio/AudioPipeline.ts');
    const pipeline = new BrowserAudioPipeline();
    let levels = 0;
    let pcms = 0;
    let bytes = 0;
    pipeline.subscribeLevel((level) => {
      if (typeof level === 'number' && level >= 0) levels += 1;
    });
    pipeline.subscribePcm((pcm) => {
      pcms += 1;
      bytes += pcm.byteLength;
    });
    const info = await pipeline.start();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await pipeline.stop();
    return { info, levels, pcms, bytes };
  })()`);

  if (!result.info?.sampleRate || result.info.channels !== 1) {
    throw new Error(`Audio pipeline did not report valid info: ${JSON.stringify(result)}`);
  }
  if (!result.info.worklet) {
    throw new Error(`Expected AudioWorklet primary path in Chrome, got fallback: ${JSON.stringify(result)}`);
  }
  if (result.levels <= 0 || result.pcms <= 0 || result.bytes <= 0) {
    throw new Error(`Audio pipeline did not emit level/PCM messages: ${JSON.stringify(result)}`);
  }

  console.log(JSON.stringify({ ok: true, result }, null, 2));
} finally {
  cleanup();
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
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  });

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

  return { call, evaluate, waitForExpression };
}
