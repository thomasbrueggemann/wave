/* WAVE — peak extraction and waveform drawing. */
window.WAVE = window.WAVE || {};

WAVE.waveform = (function () {
  'use strict';

  var BUCKETS = 16384; // fixed high-res peak cache; drawing downsamples from it

  // Reduces each channel to its own min/max/rms per bucket, so stereo files can
  // be drawn as a pair of lanes instead of a mixdown.
  function computePeaks(buffer, buckets) {
    buckets = buckets || BUCKETS;
    var len = buffer.length;
    var step = len / buckets;
    var channels = [];

    for (var c = 0; c < buffer.numberOfChannels; c++) {
      var data = buffer.getChannelData(c);
      var min = new Float32Array(buckets);
      var max = new Float32Array(buckets);
      var rms = new Float32Array(buckets);

      for (var b = 0; b < buckets; b++) {
        var from = Math.floor(b * step);
        var to = Math.min(len, Math.floor((b + 1) * step));
        if (to <= from) to = Math.min(len, from + 1);

        var lo = 0, hi = 0, sum = 0, n = 0;
        for (var i = from; i < to; i++) {
          var v = data[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
          sum += v * v;
          n++;
        }
        min[b] = lo;
        max[b] = hi;
        rms[b] = n ? Math.sqrt(sum / n) : 0;
      }
      channels.push({ min: min, max: max, rms: rms });
    }

    return { channels: channels, buckets: buckets };
  }

  // Draws `peaks` into the first `opts.spanPx` pixels of the canvas. The canvas
  // spans the whole session, so a stem shorter than the session occupies only
  // part of it — that's what keeps stacked tracks on a common timeline.
  function draw(canvas, peaks, opts) {
    opts = opts || {};
    var cw = canvas.width, h = canvas.height;
    var w = Math.max(1, Math.min(cw, Math.round(opts.spanPx == null ? cw : opts.spanPx)));
    var ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, cw, h);

    // background + centre line, drawn only where the stem actually exists
    if (opts.bg) { ctx.fillStyle = opts.bg; ctx.fillRect(0, 0, w, h); }
    if (!peaks || !peaks.channels || !peaks.channels.length) {
      ctx.fillStyle = opts.grid || 'rgba(255,255,255,.06)';
      ctx.fillRect(0, Math.round(h / 2), w, 1);
      return;
    }

    // Each channel gets its own horizontal band; a mono file still fills the lane.
    var chans = peaks.channels;
    var nch = chans.length;
    var bandH = h / nch;
    for (var c = 0; c < nch; c++) {
      if (c > 0) {
        ctx.fillStyle = opts.grid || 'rgba(255,255,255,.06)';
        ctx.fillRect(0, Math.round(c * bandH), w, 1);
      }
      drawChannel(ctx, chans[c], peaks.buckets, w, c * bandH + bandH / 2, bandH, opts);
    }
  }

  function drawChannel(ctx, ch, B, w, mid, bandH, opts) {
    var perPx = B / w;
    var amp = (bandH / 2) * 0.94;

    ctx.fillStyle = opts.grid || 'rgba(255,255,255,.06)';
    ctx.fillRect(0, Math.round(mid), w, 1);

    // outer envelope
    ctx.fillStyle = opts.color || '#4aa8ff';
    for (var x = 0; x < w; x++) {
      var from = Math.floor(x * perPx);
      var to = Math.floor((x + 1) * perPx);
      if (to <= from) to = from + 1;
      if (to > B) to = B;

      var lo = 0, hi = 0;
      for (var b = from; b < to; b++) {
        if (ch.min[b] < lo) lo = ch.min[b];
        if (ch.max[b] > hi) hi = ch.max[b];
      }
      var y0 = mid - hi * amp;
      var y1 = mid - lo * amp;
      if (y1 - y0 < 1) { y0 = mid - 0.5; y1 = mid + 0.5; }
      ctx.fillRect(x, y0, 1, y1 - y0);
    }

    // brighter rms body inside the envelope
    ctx.fillStyle = opts.rmsColor || 'rgba(255,255,255,.35)';
    for (var x2 = 0; x2 < w; x2++) {
      var f2 = Math.floor(x2 * perPx);
      var t2 = Math.floor((x2 + 1) * perPx);
      if (t2 <= f2) t2 = f2 + 1;
      if (t2 > B) t2 = B;
      var s = 0, n = 0;
      for (var b2 = f2; b2 < t2; b2++) { s += ch.rms[b2]; n++; }
      var r = n ? (s / n) * amp : 0;
      if (r < 0.5) continue;
      ctx.fillRect(x2, mid - r, 1, r * 2);
    }
  }

  /* ── time ruler ──────────────────────────────────────── */

  var TICKS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

  function fmtTick(t) {
    var m = Math.floor(t / 60);
    var s = t - m * 60;
    var whole = Math.abs(s - Math.round(s)) < 1e-6;
    if (!whole) return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
    s = Math.round(s);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function drawRuler(canvas, duration, pxPerSec, dpr, theme) {
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // pick the smallest tick that keeps labels ~70px apart
    var step = TICKS[TICKS.length - 1];
    for (var i = 0; i < TICKS.length; i++) {
      if (TICKS[i] * pxPerSec >= 70) { step = TICKS[i]; break; }
    }

    ctx.font = (10 * dpr) + 'px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'alphabetic';

    // Indexed rather than accumulated, so tick times stay exact and labels
    // don't drift into "0:04.0".
    var sub = step / 5;
    var n = Math.ceil(duration / sub) + 1;
    for (var i2 = 0; i2 <= n; i2++) {
      var t = i2 * sub;
      var x = Math.round(t * pxPerSec * dpr) + 0.5;
      if (x > w) break;
      var major = i2 % 5 === 0;
      ctx.fillStyle = major ? (theme.tickMajor || '#5c6675') : (theme.tickMinor || '#333b46');
      ctx.fillRect(x, major ? h - 10 * dpr : h - 5 * dpr, dpr, major ? 10 * dpr : 5 * dpr);
      if (major) {
        ctx.fillStyle = theme.label || '#8b95a5';
        ctx.fillText(fmtTick(t), x + 4 * dpr, h - 13 * dpr);
      }
    }
  }

  return { computePeaks: computePeaks, draw: draw, drawRuler: drawRuler, BUCKETS: BUCKETS };
})();
