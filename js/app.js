/* WAVE — UI, layout and wiring. */
(function () {
  'use strict';

  var drive = WAVE.drive;
  var wf = WAVE.waveform;

  var HEAD_W = 268;      // keep in sync with --head-w
  var RULER_H = 30;      // keep in sync with --ruler-h
  var MAX_PX = 14000;    // widest we let the timeline get, so canvases stay sane
  var PARALLEL = 2;      // simultaneous download+decode pipelines

  var $ = function (s) { return document.querySelector(s); };
  var el = {
    sourceForm: $('#source-form'), sourceUrl: $('#source-url'),
    keyBtn: $('#key-btn'), setup: $('#setup'), keyForm: $('#key-form'),
    apiKey: $('#api-key'), keyClear: $('#key-clear'), originHint: $('#origin-hint'),
    status: $('#status'), statusTitle: $('#status-title'),
    statusMsg: $('#status-msg'), statusList: $('#status-list'),
    empty: $('#empty'), daw: $('#daw'),
    btnStart: $('#btn-start'), btnPlay: $('#btn-play'),
    btnStop: $('#btn-stop'), btnLoop: $('#btn-loop'), btnReload: $('#btn-reload'),
    timePos: $('#time-pos'), timeDur: $('#time-dur'),
    masterVol: $('#master-vol'), masterDb: $('#master-db'),
    masterMeter: $('.master-meter'),
    zoom: $('#zoom'), trackCount: $('#track-count'),
    scroll: $('#scroll'), content: $('#content'),
    ruler: $('#ruler'), lanes: $('#lanes'),
    playhead: $('#playhead'), cornerName: $('#corner-name')
  };

  var engine = null;
  var rows = [];         // {file, track, node, canvas, ...}
  var pxPerSec = 10;
  var duration = 0;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var loadToken = 0;     // invalidates an in-flight load when a new one starts

  var collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  /* ── small helpers ───────────────────────────────────── */

  function fmtTime(t) {
    if (!isFinite(t)) t = 0;
    var m = Math.floor(t / 60);
    var s = Math.floor(t - m * 60);
    var ms = Math.floor((t - Math.floor(t)) * 1000);
    return m + ':' + (s < 10 ? '0' : '') + s + '.' + ('00' + ms).slice(-3);
  }
  function fmtDb(db) {
    if (db <= WAVE.Engine.MIN_DB) return '-∞ dB';
    return (db > 0 ? '+' : '') + db.toFixed(1) + ' dB';
  }
  function fmtPan(p) {
    if (Math.abs(p) < 0.005) return 'C';
    return (p < 0 ? 'L' : 'R') + Math.round(Math.abs(p) * 100);
  }
  function fmtBytes(n) {
    if (!n) return '';
    var u = ['B', 'KB', 'MB', 'GB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  }
  function baseName(n) { return String(n).replace(/\.[A-Za-z0-9]{1,5}$/, ''); }
  function show(node, on) { node.hidden = !on; }

  /* ── URL state ───────────────────────────────────────── */

  function urlFromHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) return '';
    var params = new URLSearchParams(h);
    return params.get('s') || '';
  }
  function writeHash(src) {
    var next = '#s=' + encodeURIComponent(src);
    if (location.hash !== next) {
      suppressHashChange = true;
      location.hash = next;
    }
  }
  var suppressHashChange = false;

  /* ── panels ──────────────────────────────────────────── */

  function showError(title, msg) {
    el.status.classList.add('error');
    el.statusTitle.textContent = title;
    el.statusMsg.textContent = msg;
    el.statusList.innerHTML = '';
    show(el.status, true);
    show(el.empty, false);
  }
  function showStatus(title, msg) {
    el.status.classList.remove('error');
    el.statusTitle.textContent = title;
    el.statusMsg.textContent = msg || '';
    show(el.status, true);
    show(el.empty, false);
  }

  function toggleSetup(on) {
    var next = on == null ? el.setup.hidden : on;
    show(el.setup, next);
    if (next) {
      el.apiKey.value = drive.getKey();
      el.originHint.textContent = location.origin + '/*';
      el.apiKey.focus();
    }
  }

  // The key is a one-time deployment setting — hide the entry point entirely
  // once it's baked into config.js.
  show(el.keyBtn, !drive.configuredInCode());

  el.keyBtn.addEventListener('click', function () { toggleSetup(null); });

  el.keyForm.addEventListener('submit', function (e) {
    e.preventDefault();
    drive.setKey(el.apiKey.value.trim());
    toggleSetup(false);
    var src = el.sourceUrl.value.trim() || urlFromHash();
    if (drive.getKey() && src) load(src);
  });

  el.keyClear.addEventListener('click', function () {
    drive.setKey('');
    el.apiKey.value = '';
  });

  /* ── loading ─────────────────────────────────────────── */

  el.sourceForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var src = el.sourceUrl.value.trim();
    if (src) load(src);
  });

  window.addEventListener('hashchange', function () {
    if (suppressHashChange) { suppressHashChange = false; return; }
    var src = urlFromHash();
    if (src) { el.sourceUrl.value = src; load(src); }
  });

  function loadRow(name, sub) {
    var li = document.createElement('li');
    li.innerHTML = '<span class="nm"></span><span class="bar"><i></i></span><span class="st"></span>';
    li.querySelector('.nm').textContent = name;
    li.querySelector('.st').textContent = sub || 'queued';
    el.statusList.appendChild(li);
    return {
      node: li,
      progress: function (loaded, total) {
        li.querySelector('.bar i').style.width = total ? (loaded / total * 100) + '%' : '35%';
        li.querySelector('.st').textContent = total
          ? Math.round(loaded / total * 100) + '%'
          : fmtBytes(loaded);
      },
      set: function (txt, cls) {
        li.querySelector('.st').textContent = txt;
        if (cls) {
          li.classList.remove('decoding');
          li.classList.add(cls);
        } else if (txt === 'decoding') {
          li.classList.add('decoding');
        }
        if (cls === 'done') li.querySelector('.bar i').style.width = '100%';
      }
    };
  }

  function load(src) {
    var token = ++loadToken;

    // Done here rather than at the call sites so the URL always reflects the
    // session on screen, however the load was triggered.
    writeHash(src);
    el.sourceUrl.value = src;

    if (!drive.getKey()) {
      showError('No Drive API key configured',
        'WAVE identifies itself to the Drive API with a key. Open “API key” above to set one.');
      toggleSetup(true);
      return;
    }

    var parsed = drive.parseShareUrl(src);
    if (!parsed) {
      showError('That link doesn\'t look like Google Drive',
        'Expected something like https://drive.google.com/drive/folders/… or https://drive.google.com/file/d/…');
      return;
    }

    teardown();
    el.statusList.innerHTML = '';
    showStatus('Reading Drive', 'Resolving ' + parsed.id + '…');
    document.title = 'WAVE — loading…';

    resolve(parsed)
      .then(function (res) {
        if (token !== loadToken) return;
        if (!res.files.length) {
          showError('No audio files found',
            res.kind === 'folder'
              ? 'That folder holds no files WAVE recognises as audio (wav, mp3, flac, ogg, m4a, aiff, opus…). Subfolders are scanned two levels deep.'
              : 'That file isn\'t an audio file WAVE recognises.');
          return;
        }
        res.files.sort(function (a, b) { return collator.compare(a.name, b.name); });
        el.cornerName.textContent = res.title;
        document.title = 'WAVE — ' + res.title;
        showStatus('Loading ' + res.files.length + ' track' + (res.files.length === 1 ? '' : 's'), res.title);
        return build(res.files, token);
      })
      .catch(function (err) {
        if (token !== loadToken) return;
        showError('Couldn\'t load that link', err.message || String(err));
        document.title = 'WAVE';
      });
  }

  // Figures out whether the id is a folder or a file, and returns the audio files in it.
  function resolve(parsed) {
    return drive.getMeta(parsed.id).then(function (meta) {
      if (drive.isFolder(meta)) {
        return drive.listAudioFiles(parsed.id).then(function (files) {
          return { kind: 'folder', title: meta.name, files: files };
        });
      }
      return { kind: 'file', title: meta.name, files: drive.isAudio(meta) ? [meta] : [] };
    });
  }

  function build(files, token) {
    engine = new WAVE.Engine();
    WAVE._engine = engine; // handy from the console
    engine.onEnded = function () { setPlayUI(false); };
    engine.setMasterDb(Number(el.masterVol.value));
    engine.loop = el.btnLoop.classList.contains('on');

    rows = files.map(function (f, i) { return makeRow(f, i); });
    el.trackCount.textContent = files.length + ' track' + (files.length === 1 ? '' : 's');

    var loaders = files.map(function (f, i) {
      return loadRow((f.path ? f.path + '/' : '') + f.name);
    });

    var next = 0, failures = 0, ok = 0;
    function worker() {
      if (token !== loadToken) return Promise.resolve();
      var i = next++;
      if (i >= files.length) return Promise.resolve();
      var f = files[i], ui = loaders[i], row = rows[i];

      ui.set('downloading');
      return drive.download(f.id, ui.progress)
        .then(function (buf) {
          if (token !== loadToken) throw new Error('cancelled');
          ui.set('decoding');
          return engine.decode(buf);
        })
        .then(function (audioBuffer) {
          if (token !== loadToken) throw new Error('cancelled');
          var peaks = wf.computePeaks(audioBuffer);
          var track = engine.addTrack({ id: f.id, name: baseName(f.name), buffer: audioBuffer, peaks: peaks });
          row.track = track;
          row.ready(audioBuffer, peaks);
          ui.set('ready', 'done');
          ok++;
          if (ok === 1) revealDaw();
          relayout();
          return worker();
        })
        .catch(function (err) {
          if (token !== loadToken || /cancelled/.test(err.message || '')) return;
          failures++;
          ui.set('failed', 'fail');
          row.fail(err.message || String(err));
          return worker();
        });
    }

    var pool = [];
    for (var p = 0; p < Math.min(PARALLEL, files.length); p++) pool.push(worker());

    return Promise.all(pool).then(function () {
      if (token !== loadToken) return;
      if (!ok) {
        showError('Nothing could be loaded',
          'All ' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' failed to download or decode. See the list above for details.');
        return;
      }
      if (failures) {
        showStatus(failures + ' of ' + files.length + ' failed',
          'The rest loaded and are playable. Formats the browser can\'t decode (some AIFF/WMA variants) are the usual cause.');
      } else {
        show(el.status, false);
      }
      revealDaw();
      relayout();
    });
  }

  function teardown() {
    if (engine) { engine.dispose(); engine = null; }
    rows = [];
    el.lanes.innerHTML = '';
    duration = 0;
    show(el.daw, false);
    setPlayUI(false);
    el.playhead.style.opacity = 0;
  }

  function revealDaw() {
    show(el.daw, true);
    show(el.empty, false);
    show(el.setup, false);
    el.playhead.style.opacity = 1;
  }

  /* ── track rows ──────────────────────────────────────── */

  function makeRow(file, index) {
    var node = document.createElement('div');
    node.className = 'row track-row';
    node.innerHTML =
      '<div class="head">' +
        '<div class="h-controls">' +
          '<div class="t-top">' +
            '<span class="t-num"></span>' +
            '<span class="t-name"></span>' +
            '<button class="t-btn m" title="Mute">M</button>' +
            '<button class="t-btn s" title="Solo">S</button>' +
          '</div>' +
          '<div class="t-row"><span class="lbl">Vol</span>' +
            '<input class="vol" type="range" min="-60" max="6" step="0.5" value="0" disabled>' +
            '<span class="val vval">0.0 dB</span></div>' +
          '<div class="t-row"><span class="lbl">Pan</span>' +
            '<input class="pan" type="range" min="-1" max="1" step="0.01" value="0" disabled>' +
            '<span class="val pval">C</span></div>' +
          '<div class="t-meta"><span class="mi">loading…</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="lane"><canvas class="wave"></canvas></div>';

    var q = function (s) { return node.querySelector(s); };
    q('.t-num').textContent = index + 1;
    q('.t-name').textContent = baseName(file.name);
    q('.t-name').title = (file.path ? file.path + '/' : '') + file.name;

    var r = {
      file: file, node: node, track: null,
      canvas: q('canvas.wave'),
      meterBar: null,
      dim: false
    };

    var meter = document.createElement('div');
    meter.className = 'meter';
    meter.innerHTML = '<i></i>';
    q('.head').appendChild(meter);
    r.meterBar = meter.querySelector('i');

    var vol = q('.vol'), pan = q('.pan'), mBtn = q('.t-btn.m'), sBtn = q('.t-btn.s');

    vol.addEventListener('input', function () {
      if (!r.track) return;
      r.track.gainDb = Number(vol.value);
      q('.vval').textContent = fmtDb(r.track.gainDb);
      engine.applyGains();
    });
    vol.addEventListener('dblclick', function () {
      vol.value = 0; vol.dispatchEvent(new Event('input'));
    });
    pan.addEventListener('input', function () {
      if (!r.track) return;
      r.track.pan = Number(pan.value);
      q('.pval').textContent = fmtPan(r.track.pan);
      engine.applyGains();
    });
    pan.addEventListener('dblclick', function () {
      pan.value = 0; pan.dispatchEvent(new Event('input'));
    });
    mBtn.addEventListener('click', function () {
      if (!r.track) return;
      r.track.mute = !r.track.mute;
      mBtn.classList.toggle('on', r.track.mute);
      engine.applyGains();
      redrawRow(r);
    });
    sBtn.addEventListener('click', function () {
      if (!r.track) return;
      r.track.solo = !r.track.solo;
      sBtn.classList.toggle('on', r.track.solo);
      engine.applyGains();
      rows.forEach(redrawRow);
    });

    r.canvas.addEventListener('pointerdown', function (e) {
      seekFromClientX(e.clientX, r.canvas);
    });

    r.ready = function (buffer, peaks) {
      r.peaks = peaks;
      vol.disabled = pan.disabled = false;
      q('.mi').textContent =
        fmtTime(buffer.duration).replace(/\.\d+$/, '') + '  ·  ' +
        (buffer.numberOfChannels === 1 ? 'mono' : buffer.numberOfChannels === 2 ? 'stereo' : buffer.numberOfChannels + 'ch') +
        '  ·  ' + Math.round(buffer.sampleRate / 100) / 10 + ' kHz';
      redrawRow(r);
    };

    r.fail = function (msg) {
      node.classList.add('failed');
      q('.mi').textContent = 'failed';
      q('.mi').style.color = 'var(--danger)';
      q('.t-name').title = msg;
      mBtn.disabled = sBtn.disabled = true;
    };

    el.lanes.appendChild(node);
    return r;
  }

  /* ── layout & drawing ────────────────────────────────── */

  function totalWidth() {
    return Math.max(1, Math.min(MAX_PX, duration * pxPerSec));
  }

  function effDpr(w) {
    return Math.min(dpr, Math.max(0.75, 16000 / Math.max(1, w)));
  }

  function relayout() {
    if (!engine) return;
    duration = engine.duration();
    el.timeDur.textContent = fmtTime(duration);

    var avail = Math.max(200, el.scroll.clientWidth - HEAD_W);
    var fit = duration > 0 ? avail / duration : 1;
    var zoom = Number(el.zoom.value);
    pxPerSec = fit * zoom;

    var w = totalWidth();
    if (duration > 0) pxPerSec = w / duration; // honour the MAX_PX clamp

    var d = effDpr(w);

    // ruler
    el.ruler.style.width = w + 'px';
    el.ruler.width = Math.round(w * d);
    el.ruler.height = Math.round(RULER_H * d);
    wf.drawRuler(el.ruler, duration, pxPerSec, d,
      { tickMajor: '#5c6675', tickMinor: '#333b46', label: '#8b95a5' });

    el.content.style.width = (HEAD_W + w) + 'px';

    rows.forEach(function (r) {
      r.node.querySelector('.lane').style.width = w + 'px';
      r.canvas.style.width = w + 'px';
      redrawRow(r);
    });

    updatePlayhead();
  }

  function redrawRow(r) {
    var w = totalWidth();
    var d = effDpr(w);
    var h = r.canvas.clientHeight || 122;
    r.canvas.width = Math.round(w * d);
    r.canvas.height = Math.round(h * d);
    if (!r.peaks) {
      var c = r.canvas.getContext('2d');
      c.clearRect(0, 0, r.canvas.width, r.canvas.height);
      return;
    }

    var soloed = engine && engine.tracks.some(function (t) { return t.solo; });
    var silent = r.track && (r.track.mute || (soloed && !r.track.solo));

    // A stem shorter than the session must stop where it ends, not stretch.
    var span = r.canvas.width;
    if (r.track && duration > 0) {
      span = r.canvas.width * Math.min(1, r.track.buffer.duration / duration);
    }

    wf.draw(r.canvas, r.peaks, {
      dpr: d, spanPx: span,
      color: silent ? '#39424e' : '#4aa8ff',
      rmsColor: silent ? 'rgba(255,255,255,.10)' : 'rgba(190,225,255,.45)',
      grid: 'rgba(255,255,255,.07)'
    });
  }

  function updatePlayhead() {
    if (!engine) return;
    var x = HEAD_W + engine.position() * pxPerSec;
    el.playhead.style.transform = 'translateX(' + x + 'px)';
  }

  function seekFromClientX(clientX, target) {
    if (!engine) return;
    var rect = target.getBoundingClientRect();
    var t = (clientX - rect.left) / pxPerSec;
    engine.seek(t);
    updatePlayhead();
    el.timePos.textContent = fmtTime(engine.position());
  }

  el.ruler.addEventListener('pointerdown', function (e) { seekFromClientX(e.clientX, el.ruler); });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(relayout, 120);
  });
  el.zoom.addEventListener('input', function () {
    var before = el.scroll.scrollLeft;
    var anchor = duration > 0 ? (before + el.scroll.clientWidth / 2 - HEAD_W) / pxPerSec : 0;
    relayout();
    // keep whatever was centred, centred
    el.scroll.scrollLeft = Math.max(0, anchor * pxPerSec - el.scroll.clientWidth / 2 + HEAD_W);
  });

  /* ── transport ───────────────────────────────────────── */

  function setPlayUI(on) {
    el.btnPlay.textContent = on ? '⏸' : '▶';
    el.btnPlay.classList.toggle('on', on);
  }

  el.btnPlay.addEventListener('click', function () {
    if (!engine) return;
    if (engine.playing) { engine.pause(); setPlayUI(false); }
    else engine.play().then(function () { setPlayUI(engine.playing); });
  });
  el.btnStop.addEventListener('click', function () {
    if (!engine) return;
    engine.stop(); setPlayUI(false); updatePlayhead();
    el.timePos.textContent = fmtTime(0);
  });
  el.btnStart.addEventListener('click', function () {
    if (!engine) return;
    engine.seek(0); updatePlayhead();
  });
  el.btnLoop.addEventListener('click', function () {
    var on = !el.btnLoop.classList.contains('on');
    el.btnLoop.classList.toggle('on', on);
    if (engine) engine.loop = on;
  });
  el.btnReload.addEventListener('click', function () {
    var src = urlFromHash();
    if (src) load(src);
  });

  el.masterVol.addEventListener('input', function () {
    var db = Number(el.masterVol.value);
    el.masterDb.textContent = fmtDb(db);
    if (engine) engine.setMasterDb(db);
  });
  el.masterVol.addEventListener('dblclick', function () {
    el.masterVol.value = 0;
    el.masterVol.dispatchEvent(new Event('input'));
  });

  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (!engine) return;
    if (e.code === 'Space') { e.preventDefault(); el.btnPlay.click(); }
    else if (e.code === 'Home') { e.preventDefault(); el.btnStart.click(); }
    else if (e.code === 'Escape') { e.preventDefault(); el.btnStop.click(); }
  });

  /* ── animation frame ─────────────────────────────────── */

  function meterWidth(peak) {
    if (peak <= 0.0005) return 0;
    var db = 20 * Math.log10(peak);          // -60..0 mapped to 0..100%
    var pct = (db + 60) / 60 * 100;
    return Math.max(0, Math.min(100, pct));
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!engine) return;

    engine.tick();
    if (!engine.playing) setPlayUI(false);

    el.timePos.textContent = fmtTime(engine.position());
    updatePlayhead();

    var bars = el.masterMeter.children;
    bars[0].style.width = meterWidth(engine.peakOf(engine.masterL)) + '%';
    bars[1].style.width = meterWidth(engine.peakOf(engine.masterR)) + '%';

    rows.forEach(function (r) {
      if (!r.track || !r.meterBar) return;
      r.meterBar.style.height = (100 - meterWidth(engine.peakOf(r.track.analyser))) + '%';
    });

    // keep the playhead in view while playing
    if (engine.playing) {
      var x = engine.position() * pxPerSec;
      var left = el.scroll.scrollLeft;
      var viewW = el.scroll.clientWidth - HEAD_W;
      if (x < left - 2 || x > left + viewW - 40) {
        el.scroll.scrollLeft = Math.max(0, x - viewW * 0.5);
      }
    }
  }
  requestAnimationFrame(frame);

  /* ── boot ────────────────────────────────────────────── */

  (function init() {
    el.masterDb.textContent = fmtDb(Number(el.masterVol.value));
    var src = urlFromHash();
    if (src) el.sourceUrl.value = src;

    if (drive.getKey()) {
      // With a key in config.js this is the whole story: a shared link just opens.
      if (src) load(src);
    } else {
      toggleSetup(true);
    }
  })();
})();
