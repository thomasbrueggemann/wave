/* WAVE — the mix engine.
 *
 * Every track is an AudioBuffer fed through gain → pan → analyser into a single
 * master bus. Transport start schedules one BufferSource per track at the same
 * absolute AudioContext time, which is what keeps stems sample-aligned.
 */
window.WAVE = window.WAVE || {};

WAVE.Engine = (function () {
  'use strict';

  var MIN_DB = -60;

  function dbToGain(db) { return db <= MIN_DB ? 0 : Math.pow(10, db / 20); }

  function Engine() {
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('This browser has no Web Audio support.');

    this.ctx = new Ctor();
    this.tracks = [];
    this.playing = false;
    this.loop = false;
    this._offset = 0;      // transport position when stopped, in seconds
    this._startedAt = 0;   // ctx.currentTime at which _offset was playing
    this.onEnded = null;

    var ctx = this.ctx;
    this.master = ctx.createGain();
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;

    var splitter = ctx.createChannelSplitter(2);
    this.masterL = ctx.createAnalyser();
    this.masterR = ctx.createAnalyser();
    this.masterL.fftSize = this.masterR.fftSize = 1024;

    this.master.connect(this.masterAnalyser);
    this.masterAnalyser.connect(ctx.destination);
    this.masterAnalyser.connect(splitter);
    splitter.connect(this.masterL, 0);
    splitter.connect(this.masterR, 1);

    this._buf = new Float32Array(1024);
  }

  Engine.prototype.decode = function (arrayBuffer) {
    var ctx = this.ctx;
    return new Promise(function (resolve, reject) {
      // Callback form for Safari, which still lacks the promise overload.
      var p = ctx.decodeAudioData(arrayBuffer, resolve, function (e) {
        reject(new Error('Could not decode this file — ' +
          'the browser may not support the format. ' + (e && e.message ? e.message : '')));
      });
      if (p && p.then) p.then(resolve, reject);
    });
  };

  Engine.prototype.addTrack = function (spec) {
    var ctx = this.ctx;
    var t = {
      id: spec.id,
      name: spec.name,
      buffer: spec.buffer,
      peaks: spec.peaks || null,
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      source: null,
      gainNode: ctx.createGain(),
      panNode: ctx.createStereoPanner ? ctx.createStereoPanner() : null,
      analyser: ctx.createAnalyser()
    };
    t.analyser.fftSize = 1024;

    t.gainNode.connect(t.panNode || t.analyser);
    if (t.panNode) t.panNode.connect(t.analyser);
    t.analyser.connect(this.master);

    this.tracks.push(t);
    this.applyGains();
    return t;
  };

  Engine.prototype.duration = function () {
    var d = 0;
    this.tracks.forEach(function (t) { if (t.buffer.duration > d) d = t.buffer.duration; });
    return d;
  };

  Engine.prototype.position = function () {
    if (!this.playing) return this._offset;
    var p = this._offset + (this.ctx.currentTime - this._startedAt);
    var d = this.duration();
    if (p < 0) p = 0;
    return p > d ? d : p;
  };

  /* ── mixing ──────────────────────────────────────────── */

  Engine.prototype.applyGains = function () {
    var soloed = this.tracks.some(function (t) { return t.solo; });
    var now = this.ctx.currentTime;
    this.tracks.forEach(function (t) {
      var silent = t.mute || (soloed && !t.solo);
      var g = silent ? 0 : dbToGain(t.gainDb);
      t.gainNode.gain.setTargetAtTime(g, now, 0.01);
      if (t.panNode) t.panNode.pan.setTargetAtTime(t.pan, now, 0.01);
    });
  };

  Engine.prototype.setMasterDb = function (db) {
    this.master.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.01);
  };

  /* ── transport ───────────────────────────────────────── */

  Engine.prototype._stopSources = function () {
    this.tracks.forEach(function (t) {
      if (!t.source) return;
      try { t.source.onended = null; t.source.stop(); } catch (e) {}
      try { t.source.disconnect(); } catch (e) {}
      t.source = null;
    });
  };

  Engine.prototype.play = function () {
    var self = this;
    if (this.playing) return Promise.resolve();

    var resume = this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
    return resume.then(function () {
      var dur = self.duration();
      if (!dur) return;
      if (self._offset >= dur - 0.001) self._offset = 0;

      var at = self.ctx.currentTime + 0.06; // small lookahead so every start lands together
      var offset = self._offset;

      self.tracks.forEach(function (t) {
        if (offset >= t.buffer.duration) return; // shorter stem: nothing left to play
        var src = self.ctx.createBufferSource();
        src.buffer = t.buffer;
        src.connect(t.gainNode);
        src.start(at, offset);
        t.source = src;
      });

      self._startedAt = at;
      self.playing = true;
    });
  };

  Engine.prototype.pause = function () {
    if (!this.playing) return;
    var p = this.position();
    this._stopSources();
    this.playing = false;
    this._offset = p;
  };

  Engine.prototype.stop = function () {
    this._stopSources();
    this.playing = false;
    this._offset = 0;
  };

  Engine.prototype.seek = function (t) {
    var d = this.duration();
    if (t < 0) t = 0;
    if (t > d) t = d;
    if (this.playing) {
      this._stopSources();
      this.playing = false;
      this._offset = t;
      this.play();
    } else {
      this._offset = t;
    }
  };

  // Called from the UI's animation frame: handles reaching the end.
  Engine.prototype.tick = function () {
    if (!this.playing) return;
    var d = this.duration();
    if (this.position() < d - 0.005) return;
    if (this.loop) {
      this._stopSources();
      this.playing = false;
      this._offset = 0;
      this.play();
    } else {
      this._stopSources();
      this.playing = false;
      this._offset = d;
      if (this.onEnded) this.onEnded();
    }
  };

  /* ── metering ────────────────────────────────────────── */

  Engine.prototype.peakOf = function (analyser) {
    var buf = this._buf;
    if (analyser.getFloatTimeDomainData) {
      analyser.getFloatTimeDomainData(buf);
    } else {
      var b = new Uint8Array(buf.length);
      analyser.getByteTimeDomainData(b);
      for (var i = 0; i < b.length; i++) buf[i] = (b[i] - 128) / 128;
    }
    var peak = 0;
    for (var j = 0; j < buf.length; j++) {
      var v = buf[j] < 0 ? -buf[j] : buf[j];
      if (v > peak) peak = v;
    }
    return peak;
  };

  Engine.prototype.dispose = function () {
    this._stopSources();
    try { this.ctx.close(); } catch (e) {}
  };

  Engine.MIN_DB = MIN_DB;
  Engine.dbToGain = dbToGain;
  return Engine;
})();
