import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BrowserSpeechEngine,
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

const speakerOptions = ['You', 'Person 1', 'Person 2', 'Person 3', 'Uncertain speaker'] as const;
type SpeakerLabel = string;

const deepgramApiKey = import.meta.env.VITE_DEEPGRAM_API_KEY as string | undefined;
const speechBackend = deepgramApiKey ? 'Deepgram Nova' : 'Chrome Web Speech';
const automaticSpeakerIdEnabled = speechBackend === 'Deepgram Nova';

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
  const [currentSpeaker, setCurrentSpeaker] = useState<SpeakerLabel>('You');
  const [speakerByCaptionId, setSpeakerByCaptionId] = useState<Record<number, SpeakerLabel>>({});
  const activeCaptionRef = useRef<HTMLElement | null>(null);
  const stopVolumeMeterRef = useRef<(() => void) | null>(null);

  const captionSession = useMemo(
    () =>
      new CaptionSession(
        deepgramApiKey
          ? new DeepgramNovaSpeechEngine({ apiKey: deepgramApiKey, language, model: 'nova-3' })
          : new BrowserSpeechEngine(language),
      ),
    [],
  );
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
      captionSession.stop();
      void lifecycle.stop();
    },
    [captionSession, lifecycle],
  );

  useEffect(() => {
    setSpeakerByCaptionId((existingLabels) => {
      if (captionState.captions.length === 0) {
        return Object.keys(existingLabels).length ? {} : existingLabels;
      }

      const latestId = captionState.captions.at(-1)?.id;
      let changed = false;
      const nextLabels = { ...existingLabels };

      captionState.captions.forEach((caption) => {
        const label = caption.speakerLabel ?? currentSpeaker;
        if (!nextLabels[caption.id] || (!caption.finalized && caption.id === latestId)) {
          nextLabels[caption.id] = label;
          changed = true;
        }
      });

      return changed ? nextLabels : existingLabels;
    });
  }, [captionState.captions, currentSpeaker]);

  const latestCaption = captionState.captions.at(-1) ?? null;
  const finalizedCaptions = captionState.captions.filter((caption) => caption.finalized).slice(-12).reverse();
  const selectedLanguageLabel = languageOptions.find((option) => option.value === language)?.label ?? language;

  async function startCaptions() {
    setGuidance(null);
    setMicrophoneStatus('Requesting microphone access…');
    await lifecycle.start();
    await startVolumeMeter();
    captionSession.start();
  }

  async function stopCaptions() {
    stopVolumeMeterRef.current?.();
    stopVolumeMeterRef.current = null;
    setVolumePercent(0);
    setMicrophoneStatus('Stopped');
    captionSession.stop();
    await lifecycle.stop();
  }

  async function startVolumeMeter() {
    stopVolumeMeterRef.current?.();

    if (!navigator.mediaDevices?.getUserMedia) {
      setMicrophoneStatus('Microphone capture is not available in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) {
        setMicrophoneStatus('Microphone allowed; audio meter is unavailable.');
        stopVolumeMeterRef.current = () => stream.getTracks().forEach((track) => track.stop());
        return;
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
    } catch (error) {
      setMicrophoneStatus('Microphone access was blocked or failed.');
      setGuidance('I can’t hear anyone.');
      console.error('Microphone setup failed.', error);
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
              Start a real speech-recognition session. {automaticSpeakerIdEnabled ? 'Automatic speaker identification is enabled.' : 'Automatic speaker identification is not configured, so Chrome Web Speech can only provide transcription text.'}
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
                label="Speech recognition"
                value={captionState.available ? 'Browser supported' : 'Unavailable'}
                tone="microphone"
              />
              <StatusCard label="Speech backend" value={speechBackend} tone="offline" />
            </div>

            {captionState.availabilityMessage ? <Notice>{captionState.availabilityMessage}</Notice> : null}
            {captionState.error ? <Notice tone="error">{captionState.error.message}</Notice> : null}

            <button className="primary-action" type="button" onClick={() => void startCaptions()}>
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
            <div className="active-speaker">{latestCaption ? (speakerByCaptionId[latestCaption.id] ?? currentSpeaker) : currentSpeaker}</div>
            <p style={{ fontSize: `clamp(${2.2 * captionScale}rem, ${6.5 * captionScale}vw, ${5.4 * captionScale}rem)` }}>
              {latestCaption?.text || 'Listening… captions will appear here when speech is detected.'}
            </p>
            {latestCaption && !latestCaption.finalized ? <span className="interim-badge">Interim</span> : null}
          </article>

          <section className="speaker-controls" aria-labelledby="speaker-controls-heading">
            <div>
              <h2 id="speaker-controls-heading">Speaker identification</h2>
              <p>
                {automaticSpeakerIdEnabled
                  ? `Automatic diarization is enabled with ${speechBackend}. Speaker labels come from the speech backend.`
                  : 'Automatic diarization requires a Deepgram API key. This local Chrome fallback cannot infer speakers automatically.'}
              </p>
            </div>
            {!automaticSpeakerIdEnabled ? (
              <div className="speaker-button-row">
                {speakerOptions.map((speaker) => (
                  <button
                    key={speaker}
                    className="speaker-button"
                    type="button"
                    aria-pressed={currentSpeaker === speaker}
                    onClick={() => setCurrentSpeaker(speaker)}
                  >
                    {speaker}
                  </button>
                ))}
              </div>
            ) : null}
          </section>

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
            <button className="secondary-action" type="button" onClick={() => activeCaptionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
              Return to latest
            </button>
          </section>

          <section className="session-notices" aria-live="polite" aria-atomic="true">
            <p>{microphoneStatus}</p>
            <p>Session: {sessionState}. Wake lock: {wakeLocked ? 'on' : 'off'}.</p>
            {guidance ? <Notice>{guidance}</Notice> : null}
            {captionState.error ? <Notice tone="error">{captionState.error.message}</Notice> : null}
          </section>

          <section className="turns-panel" aria-labelledby="recent-turns-heading">
            <h2 id="recent-turns-heading">Recent finalized captions</h2>
            <div className="turn-list">
              {finalizedCaptions.length ? finalizedCaptions.map((caption) => <CaptionCard caption={caption} speaker={speakerByCaptionId[caption.id] ?? 'Uncertain speaker'} key={caption.id} />) : <p className="empty-state">No finalized captions yet.</p>}
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

function CaptionCard({ caption, speaker }: { caption: CaptionLine; speaker: SpeakerLabel }) {
  return (
    <article className="turn-card">
      <div>
        <strong>{speaker}</strong>
        <span>#{caption.id}</span>
      </div>
      <p>{caption.text}</p>
    </article>
  );
}

function Notice({ children, tone = 'info' }: { children: React.ReactNode; tone?: 'info' | 'error' }) {
  return <p className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</p>;
}
