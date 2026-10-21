/**
 * Makes the app installable. The user installs from the browser's own menu: the app never offers
 * the installation, so the install prompt event is swallowed (no Android mini-bar).
 * The service worker is registered in production builds only; in development it would hide changes.
 */
export function registerPwa(): void {
  window.addEventListener('beforeinstallprompt', (event) => event.preventDefault());
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Installability is a bonus: a refused registration (for example a blocked worker) changes nothing else.
    });
  });
}
