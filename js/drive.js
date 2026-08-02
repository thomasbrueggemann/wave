/* WAVE — Google Drive access.
 *
 * Everything here goes through the public Drive v3 REST API on googleapis.com,
 * which is the only Drive surface that sends CORS headers — verified: it
 * reflects the requesting origin in access-control-allow-origin. The classic
 * download hosts (drive.google.com/uc, drive.usercontent.google.com) send no
 * CORS header at all, so a static page cannot read them.
 *
 * Requests are identified by a browser API key, which is enough for files
 * shared as "Anyone with the link" — no user, no sign-in.
 */
window.WAVE = window.WAVE || {};

WAVE.drive = (function () {
  'use strict';

  var API = 'https://www.googleapis.com/drive/v3';
  var KEY_STORE = 'wave.apiKey';

  var AUDIO_EXT = [
    'wav', 'wave', 'mp3', 'flac', 'ogg', 'oga', 'opus',
    'm4a', 'mp4', 'aac', 'aif', 'aiff', 'aifc', 'caf', 'weba', 'webm'
  ];

  function ls(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }

  /* ── key ─────────────────────────────────────────────── */

  // config.js wins; otherwise fall back to whatever this browser was given.
  function getKey() {
    var cfg = (WAVE.config && WAVE.config.apiKey || '').trim();
    return cfg || ls(function () { return localStorage.getItem(KEY_STORE) || ''; }, '');
  }
  function setKey(k) {
    ls(function () {
      if (k) localStorage.setItem(KEY_STORE, k);
      else localStorage.removeItem(KEY_STORE);
    });
  }
  function configuredInCode() {
    return !!(WAVE.config && (WAVE.config.apiKey || '').trim());
  }

  /* ── url parsing ─────────────────────────────────────── */

  // Returns {kind:'folder'|'file'|'unknown', id} or null.
  function parseShareUrl(raw) {
    var s = String(raw || '').trim();
    if (!s) return null;

    // A bare id pasted on its own.
    if (/^[A-Za-z0-9_-]{15,}$/.test(s)) return { kind: 'unknown', id: s };

    var m;
    if ((m = s.match(/\/folders\/([A-Za-z0-9_-]+)/))) return { kind: 'folder', id: m[1] };
    if ((m = s.match(/\/file\/d\/([A-Za-z0-9_-]+)/))) return { kind: 'file', id: m[1] };
    if ((m = s.match(/\/d\/([A-Za-z0-9_-]+)/)))      return { kind: 'file', id: m[1] };
    if ((m = s.match(/[?&]id=([A-Za-z0-9_-]+)/)))    return { kind: 'unknown', id: m[1] };
    // .../drive/u/0/mobile/folders/ID and other variants land here.
    if ((m = s.match(/folders?\/([A-Za-z0-9_-]{15,})/))) return { kind: 'folder', id: m[1] };
    return null;
  }

  function isAudio(file) {
    if (file.mimeType && /^audio\//.test(file.mimeType)) return true;
    var ext = (file.name || '').split('.').pop().toLowerCase();
    // video/mp4 containers are commonly used for .m4a; trust the extension.
    return AUDIO_EXT.indexOf(ext) !== -1;
  }

  function isFolder(file) {
    return file.mimeType === 'application/vnd.google-apps.folder';
  }

  /* ── requests ────────────────────────────────────────── */

  function describeError(status, body) {
    var msg = '';
    try { msg = (JSON.parse(body).error || {}).message || ''; } catch (e) {}

    if (status === 404) {
      return 'Not found. An API key can only read files shared as “Anyone with the link” — ' +
             'check the sharing setting on the folder, and that the link is right. ' +
             'Folders shared privately with you can\'t be opened this way.';
    }
    if (status === 403) {
      if (/API key not valid|expired|invalid/i.test(msg)) return 'The API key was rejected: ' + msg;
      if (/has not been used|disabled/i.test(msg)) {
        return 'The Drive API is not enabled for this key\'s project. Enable “Google Drive API” in the Cloud console. (' + msg + ')';
      }
      if (/referer|referrer|blocked|not authorized/i.test(msg)) {
        return 'The key\'s website restrictions don\'t allow ' + location.origin + '. ' +
               'Add it in the Cloud console under the key\'s Website restrictions. (' + msg + ')';
      }
      if (/quota|rate/i.test(msg)) return 'The key is out of quota for now: ' + msg;
      return 'Access denied' + (msg ? ': ' + msg : '.');
    }
    if (status === 400 && /API key/i.test(msg)) return 'Invalid API key: ' + msg;
    if (status === 401) return 'The request was rejected as unauthenticated — the API key is missing or wrong.';
    return 'Drive returned ' + status + (msg ? ': ' + msg : '');
  }

  function api(path, params) {
    var q = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    });
    q.push('key=' + encodeURIComponent(getKey()));

    return fetch(API + path + '?' + q.join('&')).then(function (r) {
      if (r.ok) return r.json();
      return r.text().then(function (t) { throw new Error(describeError(r.status, t)); });
    });
  }

  function getMeta(id) {
    return api('/files/' + encodeURIComponent(id), {
      fields: 'id,name,mimeType,size,modifiedTime',
      supportsAllDrives: 'true'
    });
  }

  function listChildren(folderId) {
    var out = [];
    function page(token) {
      var params = {
        q: "'" + folderId + "' in parents and trashed = false",
        fields: 'nextPageToken, files(id,name,mimeType,size,modifiedTime)',
        pageSize: '1000',
        orderBy: 'name_natural',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true'
      };
      if (token) params.pageToken = token;
      return api('/files', params).then(function (res) {
        out = out.concat(res.files || []);
        if (res.nextPageToken && out.length < 2000) return page(res.nextPageToken);
        return out;
      });
    }
    return page(null);
  }

  // Lists a folder's direct children, split into subfolders and audio files.
  // The tree UI expands lazily, so this is called once per visible folder.
  function listFolder(folderId) {
    return listChildren(folderId).then(function (files) {
      var folders = [], audio = [];
      files.forEach(function (f) {
        if (isFolder(f)) folders.push(f);
        else if (isAudio(f)) audio.push(f);
      });
      return { folders: folders, files: audio };
    });
  }

  /* ── download ────────────────────────────────────────── */

  // Resolves to an ArrayBuffer. onProgress(loadedBytes, totalBytesOrNull).
  function download(id, onProgress) {
    var url = API + '/files/' + encodeURIComponent(id) +
              '?alt=media&supportsAllDrives=true&key=' + encodeURIComponent(getKey());

    return fetch(url).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(describeError(r.status, t)); });

      var total = Number(r.headers.get('content-length')) || null;
      if (!r.body || !r.body.getReader) return r.arrayBuffer();

      var reader = r.body.getReader();
      var chunks = [], loaded = 0;
      return (function pump() {
        return reader.read().then(function (res) {
          if (res.done) {
            var buf = new Uint8Array(loaded), at = 0;
            for (var i = 0; i < chunks.length; i++) { buf.set(chunks[i], at); at += chunks[i].length; }
            return buf.buffer;
          }
          chunks.push(res.value);
          loaded += res.value.length;
          if (onProgress) onProgress(loaded, total);
          return pump();
        });
      })();
    });
  }

  return {
    getKey: getKey,
    setKey: setKey,
    configuredInCode: configuredInCode,
    parseShareUrl: parseShareUrl,
    getMeta: getMeta,
    listFolder: listFolder,
    isAudio: isAudio,
    isFolder: isFolder,
    download: download
  };
})();
