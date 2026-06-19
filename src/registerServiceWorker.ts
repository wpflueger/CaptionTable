export function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
        console.info('Service worker registration skipped.', error);
      });
    });
  }
}
