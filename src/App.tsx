import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AudioPipeline, BrowserAudioPipeline } from './audio/AudioPipeline';
import {
  CaptionLine,
  CaptionSession,
  CaptionSessionState,
  DeepgramNovaSpeechEngine,
} from './speech';
import { deepgramApiKey, e2eAudioFixtureUrl } from './appConfig';
import { SessionGuidance, SessionLifecycle, SessionState } from './session';

const initialCaptionState: CaptionSessionState = {
  active: false,
  captions: [],
  error: null,
  available: true,
  availabilityMessage: null,
  statusMessage: null,
  audioChunksSent: 0,
  audioBytesSent: 0,
};

const languageOptions = [
  { label: 'English (US)', value: 'en-US' },
  { label: 'English (UK)', value: 'en-GB' },
  { label: 'Spanish (Spain)', value: 'es-ES' },
  { label: 'French (France)', value: 'fr-FR' },
];

const automaticSpeakerIdEnabled = Boolean(deepgramApiKey);
const TRANSCRIPT_RENDER_WINDOW = 500;

export function App() {
  const [captionState, setCaptionState] = useState<CaptionSessionState>(initialCaptionState);
  const [captions, setCaptions] = useState<CaptionLine[]>([]);
  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const [guidance, setGuidance] = useState<SessionGuidance | null>(null);
  const [wakeLocked, setWakeLocked] = useState(false);
  const [captionScale, setCaptionScale] = useState(1);
  const [language, setLanguage] = useState('en-US');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [microphoneStatus, setMicrophoneStatus] = useState('Not started');
  const [volumePercent, setVolumePercent] = useState(0);
  const activeCaptionRef = useRef<HTMLElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const stopAudioPipelineRef = useRef<(() => Promise<void>) | null>(null);

  const speechEngine = useMemo(
    () => new DeepgramNovaSpeechEngine({
      apiKey: deepgramApiKey ?? '',
      language,
      model: 'nova-3',
      audioFixtureUrl: e2eAudioFixtureUrl,
      silenceGate: { enabled: !e2eAudioFixtureUrl, speechThreshold: 0.025, silenceTimeoutMs: 60_000, minConnectionMs: 10_000 },
    }),
    [],
  );
  const captionSession = useMemo(() => new CaptionSession(speechEngine), [speechEngine]);
  const lifecycle = useMemo(
    () =>
      new SessionLifecycle({
        onStateChange: setSessionState,
        onGuidance: setGuidance,
        onWakeLockChange: setWakeLocked,
      }),
    [],
  );

  useEffect(() => captionSession.subscribe(setCaptionState), [captionSession]);
  useEffect(() => captionSession.subscribeCaptions(setCaptions), [captionSession]);

  useEffect(() => {
    captionSession.setLanguage(language);
  }, [captionSession, language]);

  useEffect(
    () => () => {
      void stopAudioPipelineRef.current?.();
      speechEngine.setAudioSource(null);
      speechEngine.setMediaStream(null);
      captionSession.stop();
      void lifecycle.stop();
    },
    [captionSession, lifecycle, speechEngine],
  );

  useEffect(() => {
    scrollTranscriptToBottom(transcriptRef.current);
  }, [captions]);

  const latestCaption = captions.at(-1) ?? null;
  const transcriptCaptions = captions;
  const selectedLanguageLabel = languageOptions.find((option) => option.value === language)?.label ?? language;

  async function startCaptions() {
    if (!deepgramApiKey) {
      setMicrophoneStatus('Deepgram API key is missing. Add VITE_DEEPGRAM_API_KEY to .env.local and restart npm run dev.');
      return;
    }

    setGuidance(null);
    setMicrophoneStatus('Requesting microphone access…');
    void lifecycle.start();

    if (e2eAudioFixtureUrl) {
      setMicrophoneStatus('Using E2E audio fixture');
      speechEngine.setAudioSource(null);
      speechEngine.setMediaStream(null);
      captionSession.start();
      return;
    }

    const audioPipeline = await startAudioPipeline();
    if (!audioPipeline) {
      void lifecycle.stop();
      return;
    }

    speechEngine.setAudioSource(audioPipeline, { ownsSource: false });
    captionSession.start();
  }

  async function stopCaptions() {
    await stopAudioPipelineRef.current?.();
    stopAudioPipelineRef.current = null;
    setVolumePercent(0);
    setMicrophoneStatus('Stopped');
    speechEngine.setAudioSource(null);
    speechEngine.setMediaStream(null);
    captionSession.stop();
    await lifecycle.stop();
  }

  async function startAudioPipeline(): Promise<AudioPipeline | null> {
    await stopAudioPipelineRef.current?.();
    stopAudioPipelineRef.current = null;

    try {
      const pipeline = new BrowserAudioPipeline();
      const unsubscribeLevel = pipeline.subscribeLevel((level) => {
        lifecycle.reportInputVolume(level);
        setVolumePercent(Math.min(100, Math.round(level * 320)));
      });
      const info = await pipeline.start();
      setMicrophoneStatus(`Microphone active (${info.worklet ? 'AudioWorklet' : 'ScriptProcessor fallback'})`);
      stopAudioPipelineRef.current = async () => {
        unsubscribeLevel();
        await pipeline.stop();
      };
      return pipeline;
    } catch (error) {
      setMicrophoneStatus('Microphone access was blocked or failed.');
      setGuidance('I can’t hear anyone.');
      console.error('Microphone setup failed.', error);
      return null;
    }
  }

  return (
    <main className="app-shell">
      {!captionState.active ? (
        <section className="start-screen" aria-labelledby="product-title">
          <div className="hero-card">
            <button
              className="settings-button"
              type="button"
              aria-expanded={settingsOpen}
              aria-controls="settings-panel"
              onClick={() => setSettingsOpen((open) => !open)}
            >
              Settings
            </button>
            <p className="eyebrow">Installable caption display</p>
            <h1 id="product-title">Conversation Captioner</h1>
            <p className="intro">
              Set-and-forget live captions with Deepgram Nova automatic speaker identification and a full speaker-labeled transcript.
            </p>

            {settingsOpen ? (
              <SettingsPanel
                language={language}
                captionScale={captionScale}
                onLanguageChange={setLanguage}
                onCaptionScaleChange={setCaptionScale}
              />
            ) : null}

            <div className="readiness-grid" aria-label="Caption readiness">
              <StatusCard label="Current language" value={selectedLanguageLabel} tone="language" />
              <StatusCard
                label="Speaker identification"
                value={automaticSpeakerIdEnabled ? 'Automatic with Deepgram Nova' : 'Deepgram key missing'}
                tone="microphone"
              />
              <StatusCard label="Transcript" value="Full scrollable history" tone="offline" />
            </div>

            {!automaticSpeakerIdEnabled ? (
              <Notice tone="error">
                Add <code>VITE_DEEPGRAM_API_KEY</code> to <code>.env.local</code> and restart <code>npm run dev</code> to enable automatic speaker identification.
              </Notice>
            ) : null}
            {captionState.availabilityMessage ? <Notice>{captionState.availabilityMessage}</Notice> : null}
            {captionState.error ? <Notice tone="error">{captionState.error.message}</Notice> : null}

            <button className="primary-action" type="button" onClick={() => void startCaptions()} disabled={!automaticSpeakerIdEnabled}>
              Start Captions
            </button>
          </div>
        </section>
      ) : (
        <section className="caption-screen" aria-labelledby="caption-heading">
          <header className="caption-header">
            <div>
              <p className="listening-indicator"><span aria-hidden="true" /> {sessionState === 'interrupted' ? 'Interrupted' : 'Listening'}</p>
              <h1 id="caption-heading">Conversation Captioner</h1>
            </div>
            <button className="stop-button" type="button" onClick={() => void stopCaptions()}>
              Stop
            </button>
          </header>

          <article className="active-caption" aria-live="polite" ref={activeCaptionRef}>
            <div className="active-speaker">{getSpeakerLabel(latestCaption)}</div>
            <p style={{ fontSize: `clamp(${2.2 * captionScale}rem, ${6.5 * captionScale}vw, ${5.4 * captionScale}rem)` }}>
              {latestCaption?.text || 'Listening… captions will appear here when speech is detected.'}
            </p>
            {latestCaption && !latestCaption.finalized ? <span className="interim-badge">Interim</span> : null}
          </article>

          <DeepgramDiagnostics
            statusMessage={captionState.statusMessage}
            volumePercent={volumePercent}
            audioChunksSent={captionState.audioChunksSent}
            audioBytesSent={captionState.audioBytesSent}
          />

          <section className="caption-tools" aria-label="Caption controls">
            <label>
              Text size
              <input
                type="range"
                min="0.8"
                max="1.4"
                step="0.1"
                value={captionScale}
                onChange={(event) => setCaptionScale(Number(event.target.value))}
              />
            </label>
            <div className="meter" aria-label={`Microphone volume ${volumePercent}%`}>
              <span style={{ width: `${volumePercent}%` }} />
            </div>
            <button className="secondary-action" type="button" onClick={() => scrollTranscriptToBottom(transcriptRef.current)}>
              Latest transcript
            </button>
          </section>

          <section className="session-notices" aria-live="polite" aria-atomic="true">
            <p>{microphoneStatus}</p>
            <p>Session: {sessionState}. Wake lock: {wakeLocked ? 'on' : 'off'}.</p>
            {guidance ? <Notice>{guidance}</Notice> : null}
            {captionState.error ? <Notice tone="error">{captionState.error.message}</Notice> : null}
          </section>

          <TranscriptPanel captions={transcriptCaptions} transcriptRef={transcriptRef} />
        </section>
      )}
    </main>
  );
}

function SettingsPanel({
  language,
  captionScale,
  onLanguageChange,
  onCaptionScaleChange,
}: {
  language: string;
  captionScale: number;
  onLanguageChange: (language: string) => void;
  onCaptionScaleChange: (scale: number) => void;
}) {
  return (
    <section id="settings-panel" className="settings-panel" aria-label="Caption settings">
      <label>
        Language
        <select value={language} onChange={(event) => onLanguageChange(event.target.value)}>
          {languageOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <label>
        Default text size
        <input
          type="range"
          min="0.8"
          max="1.4"
          step="0.1"
          value={captionScale}
          onChange={(event) => onCaptionScaleChange(Number(event.target.value))}
        />
      </label>
    </section>
  );
}

function StatusCard({ label, value, tone }: { label: string; value: string; tone: 'language' | 'microphone' | 'offline' }) {
  return (
    <article className={`status-card ${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      <p>{label}</p>
      <strong>{value}</strong>
    </article>
  );
}

const DeepgramDiagnostics = memo(function DeepgramDiagnostics({
  statusMessage,
  volumePercent,
  audioChunksSent,
  audioBytesSent,
}: {
  statusMessage: string | null;
  volumePercent: number;
  audioChunksSent: number;
  audioBytesSent: number;
}) {
  return (
    <section className="deepgram-diagnostics" aria-live="polite" aria-atomic="true">
      <strong>Deepgram status</strong>
      <span>{statusMessage ?? 'Starting Deepgram…'}</span>
      <span>Mic level: {volumePercent}%</span>
      <span>Audio sent: {audioChunksSent} chunks / {Math.round(audioBytesSent / 1024)} KB</span>
    </section>
  );
});

const TranscriptPanel = memo(function TranscriptPanel({
  captions,
  transcriptRef,
}: {
  captions: CaptionLine[];
  transcriptRef: React.RefObject<HTMLDivElement | null>;
}) {
  const hiddenCount = Math.max(0, captions.length - TRANSCRIPT_RENDER_WINDOW);
  const renderedCaptions = hiddenCount ? captions.slice(-TRANSCRIPT_RENDER_WINDOW) : captions;

  return (
    <section className="turns-panel transcript-panel" aria-labelledby="transcript-heading">
      <h2 id="transcript-heading">Full speaker transcript</h2>
      {hiddenCount ? (
        <p className="transcript-window-note">Showing latest {TRANSCRIPT_RENDER_WINDOW} of {captions.length} transcript turns.</p>
      ) : null}
      <div className="turn-list transcript-list" ref={transcriptRef}>
        {renderedCaptions.length ? (
          renderedCaptions.map((caption) => <CaptionCard caption={caption} key={caption.id} />)
        ) : (
          <p className="empty-state">No captions yet. Start speaking and the transcript will appear here.</p>
        )}
      </div>
    </section>
  );
});

const CaptionCard = memo(function CaptionCard({ caption }: { caption: CaptionLine }) {
  return (
    <article className="turn-card" data-finalized={caption.finalized}>
      <div>
        <strong>{getSpeakerLabel(caption)}</strong>
        <span>{caption.finalized ? `#${caption.id}` : 'Live'}</span>
      </div>
      <p>{caption.text}</p>
    </article>
  );
});

function getSpeakerLabel(caption: CaptionLine | null): string {
  return caption?.speakerLabel || 'Identifying speaker';
}

function scrollTranscriptToBottom(element: HTMLDivElement | null): void {
  if (!element) {
    return;
  }

  if (typeof element.scrollTo === 'function') {
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    return;
  }

  element.scrollTop = element.scrollHeight;
}

function Notice({ children, tone = 'info' }: { children: React.ReactNode; tone?: 'info' | 'error' }) {
  return <p className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</p>;
}
