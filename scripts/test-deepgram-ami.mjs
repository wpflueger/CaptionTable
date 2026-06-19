import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const AMI_URL = 'https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2002a/audio/ES2002a.Mix-Headset.wav';
const CACHE_DIR = path.resolve('.cache/test-audio');
const SOURCE_WAV = path.join(CACHE_DIR, 'ami-es2002a-mix-headset.wav');
const CLIP_SECONDS = Number(process.env.AMI_CLIP_SECONDS ?? 90);
const CLIP_OFFSET_SECONDS = Number(process.env.AMI_CLIP_OFFSET_SECONDS ?? 180);
const CLIP_WAV = path.join(CACHE_DIR, `ami-es2002a-offset-${CLIP_OFFSET_SECONDS}s-duration-${CLIP_SECONDS}s.wav`);

loadLocalEnv();

const apiKey = process.env.DEEPGRAM_API_KEY || process.env.VITE_DEEPGRAM_API_KEY;
if (!apiKey) {
  console.error('Missing Deepgram key. Set DEEPGRAM_API_KEY or VITE_DEEPGRAM_API_KEY in .env.local.');
  process.exit(1);
}

await mkdir(CACHE_DIR, { recursive: true });
await ensureDownloaded(AMI_URL, SOURCE_WAV);
await writeWavClip(SOURCE_WAV, CLIP_WAV, CLIP_SECONDS, CLIP_OFFSET_SECONDS);
const result = await sendToDeepgram(CLIP_WAV, apiKey);
const summary = summarizeDeepgramResult(result);

console.log(JSON.stringify(summary, null, 2));

if (!summary.transcript.trim()) {
  throw new Error('Deepgram returned an empty transcript for the AMI clip.');
}

if (summary.uniqueSpeakers.length < 2) {
  throw new Error(`Expected at least 2 speakers from AMI diarization, got ${summary.uniqueSpeakers.length}.`);
}

console.log(`AMI Deepgram diarization check passed with ${summary.uniqueSpeakers.length} speakers.`);

function loadLocalEnv() {
  const envPath = path.resolve('.env.local');
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
  if (existsSync(outputPath)) {
    console.log(`Using cached AMI audio: ${outputPath}`);
    return;
  }

  console.log(`Downloading AMI audio from ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download AMI audio: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(outputPath, buffer);
  console.log(`Saved ${buffer.length} bytes to ${outputPath}`);
}

async function writeWavClip(sourcePath, outputPath, seconds, offsetSeconds) {
  const source = await readFile(sourcePath);
  const wav = parseWav(source);
  const offsetBytes = Math.min(wav.data.length, Math.floor(wav.fmt.byteRate * offsetSeconds / wav.fmt.blockAlign) * wav.fmt.blockAlign);
  const clipBytes = Math.min(wav.data.length - offsetBytes, Math.floor(wav.fmt.byteRate * seconds / wav.fmt.blockAlign) * wav.fmt.blockAlign);
  const clippedData = wav.data.subarray(offsetBytes, offsetBytes + clipBytes);
  const clip = buildWav(wav.fmt.rawChunk, clippedData);
  await writeFile(outputPath, clip);
  console.log(`Wrote ${seconds}s AMI clip from offset ${offsetSeconds}s: ${outputPath} (${clip.length} bytes)`);
}

function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('AMI source is not a RIFF/WAVE file.');
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

  if (!fmt || !data) {
    throw new Error('Could not find fmt/data chunks in AMI WAV.');
  }

  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 3) {
    throw new Error(`Unsupported AMI WAV format: ${fmt.audioFormat}`);
  }

  console.log(`AMI WAV: ${fmt.channels}ch ${fmt.sampleRate}Hz ${fmt.bitsPerSample}bit`);
  return { fmt, data };
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

async function sendToDeepgram(wavPath, key) {
  const wav = await readFile(wavPath);
  const params = new URLSearchParams({
    model: 'nova-3',
    diarize: 'true',
    smart_format: 'true',
    punctuate: 'true',
  });

  console.log('Sending AMI clip to Deepgram Nova prerecorded API with diarization.');
  const response = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${key}`,
      'Content-Type': 'audio/wav',
    },
    body: wav,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Deepgram request failed: ${response.status} ${response.statusText}\n${text}`);
  }

  return JSON.parse(text);
}

function summarizeDeepgramResult(result) {
  const alternative = result?.results?.channels?.[0]?.alternatives?.[0];
  const transcript = alternative?.transcript ?? '';
  const words = alternative?.words ?? [];
  const speakers = [...new Set(words.map((word) => word.speaker).filter((speaker) => typeof speaker === 'number'))].sort((a, b) => a - b);
  const sample = words.slice(0, 30).map((word) => ({ word: word.punctuated_word ?? word.word, speaker: word.speaker }));

  return {
    source: 'AMI ES2002a Mix-Headset clip',
    clipSeconds: CLIP_SECONDS,
    clipOffsetSeconds: CLIP_OFFSET_SECONDS,
    transcriptPreview: transcript.slice(0, 500),
    transcript,
    wordCount: words.length,
    uniqueSpeakers: speakers.map((speaker) => `Person ${speaker + 1}`),
    sampleWords: sample,
  };
}
