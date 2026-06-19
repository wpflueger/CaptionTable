import { useMemo, useState } from 'react';

type Turn = {
  speaker: string;
  text: string;
  time: string;
};

const recentTurns: Turn[] = [
  {
    speaker: 'Speaker 1',
    text: 'The tablet is ready on the table and captions will stay large enough for everyone nearby.',
    time: 'Now',
  },
  {
    speaker: 'Speaker 2',
    text: 'Recent speaker turns remain visible so people can catch up without losing the current sentence.',
    time: '1 min ago',
  },
  {
    speaker: 'Speaker 1',
    text: 'Offline readiness is shown before starting, with no account, usage meter, or subscription prompt.',
    time: '2 min ago',
  },
];

export function App() {
  const [isCapturing, setIsCapturing] = useState(false);
  const [captionScale, setCaptionScale] = useState(1);

  const captionStyle = useMemo(
    () => ({ fontSize: `clamp(${2.2 * captionScale}rem, ${6.5 * captionScale}vw, ${5.4 * captionScale}rem)` }),
    [captionScale],
  );

  return (
    <main className="app-shell">
      {!isCapturing ? (
        <section className="start-screen" aria-labelledby="product-title">
          <div className="hero-card">
            <button className="settings-button" type="button" aria-label="Open settings">
              Settings
            </button>
            <p className="eyebrow">Installable caption display</p>
            <h1 id="product-title">Conversation Captioner</h1>
            <p className="intro">
              A responsive, table-friendly caption surface for in-person conversations on phones, tablets, and laptops.
            </p>

            <div className="readiness-grid" aria-label="Caption readiness">
              <StatusCard label="Current language" value="English (US)" tone="language" />
              <StatusCard label="Microphone readiness" value="Ready to listen" tone="microphone" />
              <StatusCard label="Offline readiness" value="App shell available" tone="offline" />
            </div>

            <button className="primary-action" type="button" onClick={() => setIsCapturing(true)}>
              Start Captions
            </button>
          </div>
        </section>
      ) : (
        <section className="caption-screen" aria-labelledby="caption-heading">
          <header className="caption-header">
            <div>
              <p className="listening-indicator"><span aria-hidden="true" /> Listening</p>
              <h1 id="caption-heading">Conversation Captioner</h1>
            </div>
            <button className="stop-button" type="button" onClick={() => setIsCapturing(false)}>
              Stop
            </button>
          </header>

          <article className="active-caption" aria-live="polite">
            <p style={captionStyle}>
              “Let’s keep the captions visible while everyone finishes their thought.”
            </p>
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
            <button className="secondary-action" type="button">Return to latest</button>
          </section>

          <section className="turns-panel" aria-labelledby="recent-turns-heading">
            <h2 id="recent-turns-heading">Recent speaker turns</h2>
            <div className="turn-list">
              {recentTurns.map((turn) => (
                <article className="turn-card" key={`${turn.speaker}-${turn.time}`}>
                  <div>
                    <strong>{turn.speaker}</strong>
                    <span>{turn.time}</span>
                  </div>
                  <p>{turn.text}</p>
                </article>
              ))}
            </div>
          </section>
        </section>
      )}
    </main>
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
