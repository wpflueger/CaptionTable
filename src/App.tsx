import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CaptionLine,
  CaptionSession,
  CaptionSessionState,
  DeepgramNovaSpeechEngine,
} from './speech';
import { SessionGuidance, SessionLifecycle, SessionState } from './session';

const initialCaptionState: CaptionSessionState = {
  active: false,
  captions: [],
  error: null,
  available: true,
  availabilityMessage: null,
};

const languageOptions = [
  { label: 'English (US)', value: 'en-US' },
  { label: 'English (UK)', value: 'en-GB' },
  { label: 'Spanish (Spain)', value: 'es-ES' },
  { label: 'French (France)', value: 'fr-FR' },
];

const deepgramApiKey = import.meta.env.VITE_DEEPGRAM_API_KEY as string | undefined;
const automaticSpeakerIdEnabled = Boolean(deepgramApiKey);

export function App() {
  const [captionState, setCaptionState] = useState<CaptionSessionState>(initialCaptionState);
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
  const stopVolumeMeterRef = useRef<(() => void) | null>(null);

  const speechEngine = useMemo(
    () => new DeepgramNovaSpeechEngine({ apiKey: deepgramApiKey ?? '', language, model: 'nova-3' }),
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

  useEffect(() => {
    captionSession.setLanguage(language);
  }, [captionSession, language]);

  useEffect(
    () => () => {
      stopVolumeMeterRef.current?.();
      speechEngine.setMediaStream(null);
      captionSession.stop();
      void lifecycle.stop();
    },
    [captionSession, lifecycle, speechEngine],
  );

  useEffect(() => {
    scrollTranscriptToBottom(transcriptRef.current);
  }, [captionState.captions]);

  const latestCaption = captionState.captions.at(-1) ?? null;
  const transcriptCaptions = captionState.captions;
  const selectedLanguageLabel = languageOptions.find((option) => option.value === language)?.label ?? language;

  async function startCaptions() {
    if (!deepgramApiKey) {
      setMicrophoneStatus('Deepgram API key is missing. Add VITE_DEEPGRAM_API_KEY to .env.local and restart npm run dev.');
      return;
    }

    setGuidance(null);
    setMicrophoneStatus('Requesting microphone access…');
    await lifecycle.start();
    const stream = await startVolumeMeter();
    if (!stream) {
      await lifecycle.stop();
      return;
    }

    speechEngine.setMediaStream(stream);
    captionSession.start();
  }

  async function stopCaptions() {
    stopVolumeMeterRef.current?.();
    stopVolumeMeterRef.current = null;
    setVolumePercent(0);
    setMicrophoneStatus('Stopped');
    speechEngine.setMediaStream(null);
    captionSession.stop();
    await lifecycle.stop();
  }

  async function startVolumeMeter(): Promise<MediaStream | null> {
    stopVolumeMeterRef.current?.();

    if (!navigator.mediaDevices?.getUserMedia) {
      setMicrophoneStatus('Microphone capture is not available in this browser.');
      return null;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) {
        setMicrophoneStatus('Microphone allowed; audio meter is unavailable.');
        stopVolumeMeterRef.current = () => stream.getTracks().forEach((track) => track.stop());
        return stream;
      }

      const audioContext = new AudioContextCtor();
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);
      const samples = new Uint8Array(analyser.fftSize);
      let animationFrame = 0;

      source.connect(analyser);
      setMicrophoneStatus('Microphone active');

      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        let total = 0;
        samples.forEach((sample) => {
          const centered = (sample - 128) / 128;
          total += centered * centered;
        });
        const rms = Math.sqrt(total / samples.length);
        lifecycle.reportInputVolume(rms);
        setVolumePercent(Math.min(100, Math.round(rms * 320)));
        animationFrame = requestAnimationFrame(tick);
      };

      tick();
      stopVolumeMeterRef.current = () => {
        cancelAnimationFrame(animationFrame);
        source.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        void audioContext.close();
      };
      return stream;
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

          <section className="turns-panel transcript-panel" aria-labelledby="transcript-heading">
            <h2 id="transcript-heading">Full speaker transcript</h2>
            <div className="turn-list transcript-list" ref={transcriptRef}>
              {transcriptCaptions.length ? (
                transcriptCaptions.map((caption) => <CaptionCard caption={caption} key={caption.id} />)
              ) : (
                <p className="empty-state">No captions yet. Start speaking and the transcript will appear here.</p>
              )}
            </div>
          </section>
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

function CaptionCard({ caption }: { caption: CaptionLine }) {
  return (
    <article className="turn-card" data-finalized={caption.finalized}>
      <div>
        <strong>{getSpeakerLabel(caption)}</strong>
        <span>{caption.finalized ? `#${caption.id}` : 'Live'}</span>
      </div>
      <p>{caption.text}</p>
    </article>
  );
}

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
