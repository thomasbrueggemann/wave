# WAVE

A static HTML5 page that turns a Google Drive share link into a DAW-style stem player.

Paste a link to a **folder** and every audio file in it becomes a track — stacked, on one
shared timeline, sample-aligned, all playing together into a single master bus. Paste a link to a **single file** and you get a single track. The link lives in the page
URL, so a reload restores the session and the page is shareable.

## Running it

It's static — no build step, no server code.

```bash
python3 -m http.server 8123
```

Then open <http://localhost:8123>. Any static host works too (GitHub Pages, Netlify, S3) — add
its origin to the API key's website restrictions (see below).

Opening `index.html` straight from disk (`file://`) also works, since everything loads as
classic scripts rather than ES modules.

## No sign-in — just a key

Visitors do nothing. They open a WAVE link and it plays.

That's possible because a Drive **API key** identifies the *app*, not a user, and it's enough
to read anything shared as “Anyone with the link”. Put the key in
[`js/config.js`](js/config.js) and the setup panel never appears for anyone.

A browser can't skip credentials entirely, though — that part is not a choice:

| Host | CORS | Usable from a static page |
|---|---|---|
| `drive.google.com/uc?export=download` | no `access-control-allow-origin` | ✗ |
| `drive.usercontent.google.com/download` | no `access-control-allow-origin` | ✗ |
| `googleapis.com/drive/v3` | reflects the requesting origin | ✓ (needs a key) |

Without a key that last one answers *“The request is missing a valid API key.”* There is also
no unauthenticated way to list a folder's contents at all. So: no login required, one key
required.

### One-time setup (you, not your visitors)

1. [Google Cloud console → Credentials](https://console.cloud.google.com/apis/credentials) — create or pick a project.
2. Enable the [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) for it.
3. *Create credentials → API key*.
4. Restrict it — **API restrictions** to Google Drive API, **Website restrictions** to the origins WAVE is served from (e.g. `https://you.github.io/*`, `http://localhost:8123/*`).
5. Put it in [`js/config.js`](js/config.js).

Leave `config.js` empty and WAVE asks for a key in its setup panel and remembers it in that
browser — handy while developing.

### Is committing the key safe?

Yes, with the caveat below. A browser API key is designed to ship in page source. It reads
only files that are *already* public, so it exposes nothing that wasn't exposed already, and
it cannot reach anything private in your Drive.

The caveat is quota, not data: referrer restrictions are enforced by browsers and can be
spoofed by a non-browser client, so a copied key could burn your free Drive quota. If that
ever happens, rotate the key — one click, one commit.

### What this costs you

Only link-public folders work. A folder shared *privately* with you can't be opened, because
there's no user in the picture to have that access. The alternative — OAuth sign-in — was
built and then removed: with the restricted `drive.readonly` scope, every recipient of a
shared link would have to be added by hand to a 100-person test-user list and click through an
"unverified app" warning, which defeats the point of a shareable link. Going beyond that needs
Google verification plus an annual paid CASA security assessment.

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
index.html        markup and the setup/status panels
styles.css        dark DAW theme; --head-w / --lane-h / --ruler-h drive the layout
js/config.js      your Drive API key
js/drive.js       Drive v3 access: URL parsing, folder walk, download, error messages
js/waveform.js    peak extraction and canvas rendering (waveforms + time ruler)
js/audio.js       the mix engine: buffers → gain → pan → analyser → master, and transport
js/app.js         UI, layout, zoom, transport wiring, URL state
```
