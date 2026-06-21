export const deepgramApiKey = import.meta.env.VITE_DEEPGRAM_API_KEY as string | undefined;
export const e2eAudioFixtureUrl = getDevE2eAudioFixtureUrl();

function getDevE2eAudioFixtureUrl(): string | undefined {
  if (!import.meta.env.DEV) return undefined;
  return new URLSearchParams(window.location.search).get('e2eAudio') ?? undefined;
}
