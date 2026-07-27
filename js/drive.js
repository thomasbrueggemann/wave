/* WAVE — Google Drive access.
 *
 * Everything here goes through the public Drive v3 REST API on googleapis.com,
 * which is the only Drive surface that sends CORS headers. The classic share
 * hosts (drive.google.com, docs.google.com) do not, so they cannot be fetched
 * from a static page at all.
 *
 * Requests are authorised with the signed-in user's OAuth access token. A 401
 * means the token went stale mid-session, so each call refreshes once and
 * retries before giving up.
 */
window.WAVE = window.WAVE || {};

WAVE.drive = (function () {
  'use strict';

  var API = 'https://www.googleapis.com/drive/v3';

  var AUDIO_EXT = [
    'wav', 'wave', 'mp3', 'flac', 'ogg', 'oga', 'opus',
    'm4a', 'mp4', 'aac', 'aif', 'aiff', 'aifc', 'caf', 'weba', 'webm'
  ];

  // Injected by the app so this module doesn't depend on the auth module directly.
  var tokenProvider = function () { return Promise.reject(new Error('Not signed in.')); };
  function setTokenProvider(fn) { tokenProvider = fn; }

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
      return 'Not found. Your Google account has to be able to open it — either the share is ' +
             '“Anyone with the link”, or the folder is shared with you directly. Also check the link itself.';
    }
    if (status === 403) {
      if (/has not been used|disabled/i.test(msg)) {
        return 'The Drive API is not enabled for this app\'s Cloud project. Enable “Google Drive API” there. (' + msg + ')';
      }
      if (/insufficient|scope/i.test(msg)) {
        return 'The sign-in didn\'t grant Drive read access. Sign out and back in, and accept the permission. (' + msg + ')';
      }
      return 'Access denied' + (msg ? ': ' + msg : '.');
    }
    return 'Drive returned ' + status + (msg ? ': ' + msg : '');
  }

  // Runs `attempt(token)`; on 401 refreshes the token once and runs it again.
  function withAuth(attempt) {
    return tokenProvider(false).then(attempt).then(function (r) {
      if (r.status !== 401) return r;
      return tokenProvider(true).then(attempt);
    });
  }

  function api(path, params) {
    var q = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');

    return withAuth(function (token) {
      return fetch(API + path + '?' + q, { headers: { Authorization: 'Bearer ' + token } });
    }).then(function (r) {
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
        includeItemsFromAllDrives: 'true',
        corpora: 'allDrives'
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

  // Walks a folder, collecting audio files. Subfolders are flattened, depth-first.
  function listAudioFiles(folderId, maxDepth) {
    maxDepth = maxDepth == null ? 2 : maxDepth;
    var found = [];

    function walk(id, depth, prefix) {
      return listChildren(id).then(function (files) {
        var subs = [];
        files.forEach(function (f) {
          if (isFolder(f)) { if (depth < maxDepth) subs.push(f); return; }
          if (isAudio(f)) { f.path = prefix; found.push(f); }
        });
        return subs.reduce(function (chain, sub) {
          return chain.then(function () {
            return walk(sub.id, depth + 1, prefix ? prefix + '/' + sub.name : sub.name);
          });
        }, Promise.resolve());
      });
    }

    return walk(folderId, 0, '').then(function () { return found; });
  }

  /* ── download ────────────────────────────────────────── */

  // Resolves to an ArrayBuffer. onProgress(loadedBytes, totalBytesOrNull).
  function download(id, onProgress) {
    var url = API + '/files/' + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true';

    return withAuth(function (token) {
      return fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    }).then(function (r) {
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
    setTokenProvider: setTokenProvider,
    parseShareUrl: parseShareUrl,
    getMeta: getMeta,
    listAudioFiles: listAudioFiles,
    isAudio: isAudio,
    isFolder: isFolder,
    download: download
  };
})();
