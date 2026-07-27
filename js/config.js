/* WAVE — deployment configuration.
 *
 * On GitHub Pages, .github/workflows/deploy.yml overwrites the apiKey below
 * with the DRIVE_API_KEY repository secret at build time, so visitors get a
 * working key with no setup and it never appears in source control.
 *
 * For local development, set it here instead:
 *
 *   WAVE.config = { apiKey: 'AIzaSy…' };
 *
 * A browser API key is meant to be public. It reads only files that are already
 * shared as "Anyone with the link", so it exposes nothing that isn't public
 * already — it can't reach anything private in your Drive. Restrict it anyway:
 *
 *   https://console.cloud.google.com/apis/credentials
 *     → Create credentials → API key
 *     → API restrictions:     Google Drive API only
 *     → Website restrictions: the origins WAVE is served from, e.g.
 *                             https://thomasbrueggemann.github.io/*
 *
 * Referrer restrictions are a browser-level control and can be spoofed by a
 * non-browser client, so treat the key as quota (not data) that's worth
 * protecting. If someone starts burning it, rotate the key — it's one click.
 *
 * Left empty, WAVE asks for a key in its setup panel and remembers it in that
 * browser. Convenient while developing.
 *
 * Adding an origin: put it in Website restrictions in the console, or requests
 * from it come back 403 "Requests from referer … are blocked".
 */
window.WAVE = window.WAVE || {};
WAVE.config = {
  // Injected at GitHub Pages build time from the DRIVE_API_KEY repo secret
  // (see .github/workflows/deploy.yml). Empty here in source control.
  apiKey: ''
};
