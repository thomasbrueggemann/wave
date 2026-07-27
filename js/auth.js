/* WAVE — Google sign-in.
 *
 * Google Identity Services token flow: entirely client-side, no backend and no
 * client secret. The token lives in memory only — it is never written to
 * storage, so a reload re-asks Google (silently, if the grant is still valid).
 */
window.WAVE = window.WAVE || {};

WAVE.auth = (function () {
  'use strict';

  // Read-only access to the signed-in user's Drive. This is a *restricted*
  // scope: fine unverified for up to 100 test users, but going public requires
  // Google verification plus an annual CASA security assessment.
  var SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

  var CLIENT_STORE = 'wave.clientId';
  var SEEN_STORE = 'wave.signedIn'; // "we've been granted before" — worth a silent retry

  var tokenClient = null;
  var token = null;
  var expiresAt = 0;
  var pending = null;
  var listeners = [];

  function ls(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }

  function clientId() {
    var cfg = (WAVE.config && WAVE.config.clientId || '').trim();
    return cfg || ls(function () { return localStorage.getItem(CLIENT_STORE) || ''; }, '');
  }
  function setClientId(id) {
    ls(function () {
      if (id) localStorage.setItem(CLIENT_STORE, id);
      else localStorage.removeItem(CLIENT_STORE);
    });
    tokenClient = null; // rebuild against the new id
  }
  function configuredInCode() {
    return !!(WAVE.config && (WAVE.config.clientId || '').trim());
  }

  function hasGranted() { return ls(function () { return !!localStorage.getItem(SEEN_STORE); }, false); }
  function markGranted(on) {
    ls(function () {
      if (on) localStorage.setItem(SEEN_STORE, '1');
      else localStorage.removeItem(SEEN_STORE);
    });
  }

  function onChange(fn) { listeners.push(fn); }
  function emit() {
    var state = { signedIn: isSignedIn() };
    listeners.forEach(function (fn) { try { fn(state); } catch (e) {} });
  }

  function isSignedIn() { return !!token && Date.now() < expiresAt; }

  /* ── loading the GIS library ─────────────────────────── */

  function gisReady() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) {
      return Promise.resolve();
    }
    return new Promise(function (resolve, reject) {
      var waited = 0;
      var iv = setInterval(function () {
        if (window.google && window.google.accounts && window.google.accounts.oauth2) {
          clearInterval(iv); resolve();
        } else if ((waited += 100) > 10000) {
          clearInterval(iv);
          reject(new Error('Google\'s sign-in library didn\'t load. Check the network, ' +
                           'and any content blocker that might be blocking accounts.google.com.'));
        }
      }, 100);
    });
  }

  function client() {
    if (tokenClient) return tokenClient;
    var id = clientId();
    if (!id) throw new Error('No OAuth client ID configured.');
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: id,
      scope: SCOPE,
      callback: function () {} // replaced per request
    });
    return tokenClient;
  }

  function describeAuthError(err) {
    var type = err && (err.type || err.error) || '';
    if (/popup_closed|popup_failed_to_open/.test(type)) {
      return 'The Google sign-in window was closed or blocked. Allow pop-ups for this site and try again.';
    }
    if (/access_denied/.test(type)) {
      return 'Google denied the request. If this app is unverified, your account has to be added ' +
             'as a test user on its OAuth consent screen.';
    }
    if (/idpiframe|invalid_client|unauthorized_client/.test(type)) {
      return 'Google rejected the client ID. Check that it\'s a "Web application" client and that ' +
             location.origin + ' is listed under Authorized JavaScript origins.';
    }
    return (err && (err.message || err.type || err.error)) || 'Sign-in failed.';
  }

  /* ── token acquisition ───────────────────────────────── */

  // interactive:false asks Google for a token without UI — works when the grant
  // is still live. Falls back to the consent pop-up when interactive:true.
  function requestToken(interactive) {
    if (pending) return pending;

    pending = gisReady().then(function () {
      return new Promise(function (resolve, reject) {
        var tc;
        try { tc = client(); } catch (e) { return reject(e); }

        tc.callback = function (resp) {
          if (resp && resp.access_token) {
            token = resp.access_token;
            expiresAt = Date.now() + (Number(resp.expires_in || 3600) * 1000) - 60000;
            markGranted(true);
            emit();
            resolve(token);
          } else {
            reject(new Error(describeAuthError(resp)));
          }
        };
        tc.error_callback = function (err) { reject(new Error(describeAuthError(err))); };

        try {
          tc.requestAccessToken({ prompt: interactive ? 'consent' : '' });
        } catch (e) {
          reject(new Error(describeAuthError(e)));
        }
      });
    });

    pending.catch(function () {}).then(function () { pending = null; });
    return pending;
  }

  // The one entry point the rest of the app uses. force=true drops a token that
  // the server has already rejected.
  function ensureToken(force) {
    if (!force && isSignedIn()) return Promise.resolve(token);
    if (force) { token = null; expiresAt = 0; }
    // Silent only: this runs mid-session on behalf of a Drive request, so it
    // must never raise a pop-up the user didn't ask for. If it fails they're
    // sent back to the sign-in button.
    return requestToken(false);
  }

  function signIn() { return requestToken(true); }

  // Local sign-out: drops the token here. The grant itself stays, so signing
  // back in is one click. Revoke it entirely at myaccount.google.com/permissions.
  function signOut() {
    token = null;
    expiresAt = 0;
    markGranted(false);
    emit();
  }

  // Best-effort restore on page load, used only when this browser has granted
  // access before.
  function resume() {
    if (!clientId() || !hasGranted()) return Promise.resolve(null);
    return requestToken(false).catch(function () { return null; });
  }

  return {
    SCOPE: SCOPE,
    clientId: clientId,
    setClientId: setClientId,
    configuredInCode: configuredInCode,
    hasGranted: hasGranted,
    isSignedIn: isSignedIn,
    getToken: function () { return token; },
    ensureToken: ensureToken,
    signIn: signIn,
    signOut: signOut,
    resume: resume,
    onChange: onChange
  };
})();
