/* WAVE — deployment configuration.
 *
 * Put your Google OAuth **client ID** here and visitors never see a setup step:
 * they just click "Sign in with Google".
 *
 *   WAVE.config = { clientId: '1234567890-abcdef.apps.googleusercontent.com' };
 *
 * A client ID is public by design — it's safe to commit and safe to serve. It is
 * not a secret, and this flow has no client secret at all.
 *
 * Create one at https://console.cloud.google.com/apis/credentials
 *   → Create credentials → OAuth client ID → Web application
 *   → add every origin WAVE is served from under "Authorized JavaScript origins"
 *     (e.g. http://localhost:8123 and https://your-host)
 *
 * Left empty, WAVE asks for the client ID in its setup panel and remembers it in
 * this browser — handy while developing, but set it here before you deploy.
 */
window.WAVE = window.WAVE || {};
WAVE.config = {
  clientId: ''
};
