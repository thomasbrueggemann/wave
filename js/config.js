/* WAVE — deployment configuration.
 *
 * Put your Google Drive API key here and WAVE needs nothing from its visitors:
 * they open a link and it plays. No sign-in, no consent screen, no setup.
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
 * browser. Convenient while developing; set it here before you share the link.
 */
window.WAVE = window.WAVE || {};
WAVE.config = {
  apiKey: ''
};
