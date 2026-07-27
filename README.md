# WAVE

A static HTML5 page that turns a Google Drive share link into a DAW-style stem player.

Sign in with Google, paste a link to a **folder**, and every audio file in it becomes a track
— stacked, on one shared timeline, sample-aligned, all playing together into a single master
bus. Paste a link to a **single file** and you get a single track. The link lives in the page
URL, so a reload restores the session and the page is shareable.

## Running it

It's static — no build step, no server code.

```bash
python3 -m http.server 8123
```

Then open <http://localhost:8123>. Any static host works too (GitHub Pages, Netlify, S3) — as
long as you register its origin with the OAuth client (see below).

## Sign-in

Visitors click **Sign in with Google** and that's it. Google Identity Services' token flow
runs entirely in the browser — no backend, no client secret. The access token is held in
memory only, never written to storage, and every Drive request carries it as a bearer token.

Drive's share hosts (`drive.google.com`, `docs.google.com`) send no CORS headers, so a static
page can't fetch from them at all; `googleapis.com/drive/v3` is the only browser-reachable
Drive surface, and it needs authorisation.

Because WAVE reads Drive *as you*, it opens anything your account can already open — public
“Anyone with the link” shares **and** folders shared with you directly.

### One-time setup (you, not your visitors)

1. [Google Cloud console → Credentials](https://console.cloud.google.com/apis/credentials) — create or pick a project.
2. Enable the [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com).
3. Configure the OAuth consent screen. While the app is unverified, add each Google account that will use it under **Test users**.
4. *Create credentials → OAuth client ID → Web application*. Add every origin WAVE is served from under **Authorized JavaScript origins** — e.g. `http://localhost:8123` and `https://your-host`.
5. Put the client ID in [`js/config.js`](js/config.js).

A client ID is public by design — safe to commit, safe to serve. There is no secret in this
flow. If you leave `config.js` empty, WAVE asks for the client ID in its setup panel and
remembers it in that browser, which is convenient while developing.

Because OAuth requires registered JavaScript origins, WAVE must now be **served over http(s)** —
opening `index.html` from `file://` no longer works for signing in.

### The verification ceiling

WAVE uses the `drive.readonly` scope, which Google classifies as **restricted**. Unverified,
that's capped at 100 manually-added test users and shows an "unverified app" warning — fine
for personal or band-sized use. Publishing it beyond that requires Google verification plus a
third-party CASA security assessment, repeated annually.

The way out, if you ever need it, is the Google Picker with the non-sensitive `drive.file`
scope — but that trades "paste a link" for "browse and pick", so it changes the product.

### Sessions

Signing out drops the token locally and clears the tracks; the grant itself stays, so signing
back in is one click. Revoke it entirely at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

On reload, WAVE asks Google for a token without prompting. That succeeds while the grant and
your Google session are live; if Google can't do it silently, WAVE falls back to the sign-in
button with the link preserved.

## Sharing

The source link is stored in the hash:

```
https://your-host/wave/#s=https%3A%2F%2Fdrive.google.com%2Fdrive%2Ffolders%2FABC123
```

## What it does

- **Folder or file links** — `/drive/folders/…`, `/file/d/…`, `open?id=…`, or a bare id.
  Subfolders are scanned two levels deep and flattened; tracks sort by natural name order
  (`2 Bass` before `10 Vox`).
- **Aligned lanes** — every lane shares one time-to-pixel mapping, so a stem shorter than
  the session stops where it actually ends instead of stretching to fill.
- **One transport** — play/pause, stop, return to start, loop. Every stem is scheduled at
  the same absolute `AudioContext` time, which is what keeps them in sync.
- **Per track** — volume (−60…+6 dB), pan, mute, solo, peak meter. Double-click a fader to
  reset it.
- **Master bus** — volume and stereo peak metering.
- **Timeline** — click any waveform or the ruler to seek; zoom up to 40×; the view follows
  the playhead during playback.
- **Keys** — <kbd>Space</kbd> play/pause, <kbd>Home</kbd> to start, <kbd>Esc</kbd> stop.

## Formats

Decoding is the browser's `decodeAudioData`, so support follows the browser: WAV, MP3, FLAC,
OGG/Opus, M4A/AAC everywhere current; AIFF on Safari and Chrome; WMA nowhere. Files that
fail to decode are marked in the load list and the rest still play.

Everything is decoded to memory as `AudioBuffer`s, resampled to the context rate — which is
also what guarantees alignment across stems recorded at different sample rates. A large
folder of long WAVs is correspondingly heavy on RAM.

## Layout

```
index.html        markup and the sign-in/status panels
styles.css        dark DAW theme; --head-w / --lane-h / --ruler-h drive the layout
js/config.js      your OAuth client ID
js/auth.js        Google sign-in: token acquisition, silent resume, refresh, sign-out
js/drive.js       Drive v3 access: URL parsing, folder walk, download, 401 retry
js/waveform.js    peak extraction and canvas rendering (waveforms + time ruler)
js/audio.js       the mix engine: buffers → gain → pan → analyser → master, and transport
js/app.js         UI, layout, zoom, transport wiring, URL state
```
