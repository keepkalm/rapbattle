/** Browser vibe deck, served as /cypher-deck.js */

export const CYPHER_DECK_JS = `"use strict";
window.createCypherDeck = function () {
  var STEPS = 16;
  var VIBES = {
    "boom-bap": { bpm: 90, swing: 0.58 },
    "boom-bap-slow": { bpm: 84, swing: 0.58 },
    "lo-fi": { bpm: 82, swing: 0.62 },
    trap: { bpm: 140, swing: 0.5 },
    grime: { bpm: 140, swing: 0.5 },
    drill: { bpm: 145, swing: 0.5 },
    jersey: { bpm: 160, swing: 0.52 }
  };
  function noiseBuf(ctx, sec) {
    var buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * sec)), ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  return {
    ctx: null, master: null, drums: null, vocals: null, noise: null,
    timer: null, uiTimer: null, endTimer: null,
    nextStep: 0, nextTime: 0, originTime: 0, running: false,
    vocalSource: null, vocalStart: 0, vocalEnd: 0, lineCount: 1,
    lastBeat: -1, lastLine: -1, handlers: {},
    vibe: "boom-bap", bpm: 90, swing: 0.58,
    setVibe: function (id) {
      var v = VIBES[id] || VIBES["boom-bap"];
      this.vibe = VIBES[id] ? id : "boom-bap";
      this.bpm = v.bpm;
      this.swing = v.swing;
      return this.vibe;
    },
    stepTime: function (step) {
      var six = 60 / this.bpm / 4;
      var pair = Math.floor(step / 2);
      var odd = step % 2;
      return pair * six * 2 + (odd ? six * 2 * this.swing : 0);
    },
    barLength: function () { return this.stepTime(STEPS); },
    unlock: function () {
      if (!this.ctx) {
        var ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
        var master = ctx.createGain();
        var drums = ctx.createGain();
        var vocals = ctx.createGain();
        var comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -16; comp.knee.value = 8; comp.ratio.value = 2.4;
        comp.attack.value = 0.008; comp.release.value = 0.14;
        drums.gain.value = 0.78; vocals.gain.value = 1; master.gain.value = 0.9;
        drums.connect(comp); vocals.connect(comp); comp.connect(master); master.connect(ctx.destination);
        this.ctx = ctx; this.master = master; this.drums = drums; this.vocals = vocals;
        this.noise = noiseBuf(ctx, 0.5);
      }
      if (this.ctx.state === "suspended") this.ctx.resume();
      return this.ctx;
    },
    start: function (handlers) {
      var ctx = this.unlock();
      this.stopInternal(false);
      this.handlers = handlers || {};
      this.running = true;
      this.nextStep = 0;
      this.nextTime = ctx.currentTime + 0.03;
      this.originTime = this.nextTime;
      this.lastBeat = -1; this.lastLine = -1;
      this.vocalStart = 0; this.vocalEnd = 0;
      if (this.handlers.onPhase) this.handlers.onPhase("countin");
      this.scheduler();
      this.pulseUi();
    },
    preview: function (id) {
      if (id) this.setVibe(id);
      this.start(this.handlers);
      var self = this;
      var wait = this.barLength() * 2;
      if (this.endTimer) clearTimeout(this.endTimer);
      this.endTimer = setTimeout(function () { if (self.running) self.stop(); }, wait * 1000);
    },
    drop: function (arrayBuffer, lineCount) {
      var self = this;
      var ctx = this.unlock();
      if (!this.running) this.start(this.handlers);
      this.lineCount = Math.max(1, lineCount);
      return ctx.decodeAudioData(arrayBuffer.slice(0)).then(function (buffer) {
        var bar = self.barLength();
        var raw = Math.max(0.4, buffer.duration);
        var bars = Math.max(4, Math.round(raw / bar));
        var rate = raw / (bars * bar);
        if (rate < 0.88) { bars = Math.max(4, Math.floor(raw / (0.88 * bar))); rate = raw / (bars * bar); }
        else if (rate > 1.12) { bars = Math.max(4, Math.ceil(raw / (1.12 * bar))); rate = raw / (bars * bar); }
        rate = Math.min(1.12, Math.max(0.88, rate));
        var vocalDur = raw / rate;
        var step = self.nextStep;
        var time = self.nextTime;
        while (step % STEPS !== 0 || step < STEPS) {
          step += 1;
          time += self.stepTime(step) - self.stepTime(step - 1);
        }
        var dropTime = time;
        if (dropTime < ctx.currentTime + 0.08) dropTime += bar;
        try { if (self.vocalSource) self.vocalSource.stop(); } catch (e) {}
        var src = ctx.createBufferSource();
        src.buffer = buffer;
        src.playbackRate.value = rate;
        var hp = ctx.createBiquadFilter();
        hp.type = "highpass"; hp.frequency.value = 90; hp.Q.value = 0.7;
        src.connect(hp); hp.connect(self.vocals);
        src.start(dropTime);
        src.stop(dropTime + vocalDur + 0.05);
        src.onended = function () { if (self.vocalSource === src) self.finishSoon(dropTime + vocalDur); };
        self.vocalSource = src;
        self.vocalStart = dropTime;
        self.vocalEnd = dropTime + vocalDur;
        self.drums.gain.cancelScheduledValues(dropTime);
        self.drums.gain.setTargetAtTime(0.42, dropTime, 0.06);
        setTimeout(function () {
          if (self.running && self.handlers.onPhase) self.handlers.onPhase("verse");
        }, Math.max(0, (dropTime - ctx.currentTime) * 1000));
      });
    },
    stop: function () { this.stopInternal(true); },
    finishSoon: function (when) {
      var self = this;
      if (!this.ctx || !this.running) return;
      if (this.handlers.onPhase) this.handlers.onPhase("tail");
      this.drums.gain.setTargetAtTime(0.78, when, 0.12);
      var wait = Math.max(0.25, when + this.barLength() - this.ctx.currentTime);
      if (this.endTimer) clearTimeout(this.endTimer);
      this.endTimer = setTimeout(function () { if (self.running) self.stop(); }, wait * 1000);
    },
    stopInternal: function (notify) {
      this.running = false;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      if (this.endTimer) { clearTimeout(this.endTimer); this.endTimer = null; }
      if (this.uiTimer) { cancelAnimationFrame(this.uiTimer); this.uiTimer = null; }
      try { if (this.vocalSource) this.vocalSource.stop(); } catch (e) {}
      this.vocalSource = null;
      if (this.ctx && this.drums && this.master) {
        var now = this.ctx.currentTime;
        this.drums.gain.cancelScheduledValues(now);
        this.drums.gain.setTargetAtTime(0.78, now, 0.04);
        this.master.gain.setTargetAtTime(0.0001, now, 0.03);
        this.master.gain.setTargetAtTime(0.9, now + 0.08, 0.02);
      }
      if (this.handlers.onBeat) this.handlers.onBeat(0);
      if (this.handlers.onLine) this.handlers.onLine(-1);
      if (this.handlers.onPhase) this.handlers.onPhase("stopped");
      if (notify && this.handlers.onEnd) this.handlers.onEnd();
      this.handlers = {};
    },
    scheduler: function () {
      var self = this;
      if (!this.ctx || !this.running) return;
      var horizon = this.ctx.currentTime + 0.12;
      while (this.nextTime < horizon) {
        this.hit(this.nextStep, this.nextTime);
        this.nextStep += 1;
        this.nextTime += this.stepTime(this.nextStep) - this.stepTime(this.nextStep - 1);
      }
      this.timer = setTimeout(function () { self.scheduler(); }, 25);
    },
    pulseUi: function () {
      var self = this;
      if (!this.running || !this.ctx) return;
      var t = this.ctx.currentTime;
      var beat = Math.max(0, Math.min(3, Math.floor(((t - this.originTime) / (60 / this.bpm)) % 4)));
      if (beat !== this.lastBeat) {
        this.lastBeat = beat;
        if (this.handlers.onBeat) this.handlers.onBeat(beat);
      }
      if (this.vocalStart && t >= this.vocalStart && this.vocalEnd > this.vocalStart) {
        var p = Math.min(0.999, Math.max(0, (t - this.vocalStart) / (this.vocalEnd - this.vocalStart)));
        var line = Math.min(this.lineCount - 1, Math.floor(p * this.lineCount));
        if (line !== this.lastLine) {
          this.lastLine = line;
          if (this.handlers.onLine) this.handlers.onLine(line);
        }
      }
      this.uiTimer = requestAnimationFrame(function () { self.pulseUi(); });
    },
    hit: function (step, time) {
      var ctx = this.ctx, bus = this.drums, noise = this.noise;
      if (!ctx || !bus || !noise) return;
      var s = step % STEPS;
      var v = this.vibe;
      if (v === "trap") {
        if (s === 0 || s === 6 || s === 8 || s === 10) this.kick(ctx, bus, time, s === 6 ? 0.7 : 1);
        if (s === 4 || s === 12) this.snare(ctx, bus, noise, time);
        this.hat(ctx, bus, noise, time, s === 14, s === 14 ? 0.2 : 0.09);
        if (s === 0) this.bass(ctx, bus, time, 41.2, 0.72, 0.55);
        if (s === 6) this.bass(ctx, bus, time, 36.71, 0.55, 0.45);
        if (s === 10) this.bass(ctx, bus, time, 55, 0.38, 0.32);
        return;
      }
      if (v === "grime") {
        if (s === 0 || s === 6) this.kick(ctx, bus, time, 1);
        if (s === 8) this.snare(ctx, bus, noise, time);
        if (s === 4 || s === 12 || s === 14) this.hat(ctx, bus, noise, time, s === 14);
        if (s === 0) this.bass(ctx, bus, time, 49, 0.65, 0.5);
        return;
      }
      if (v === "drill") {
        if (s === 0 || s === 3 || s === 7 || s === 10) this.kick(ctx, bus, time, s === 3 ? 0.55 : 1);
        if (s === 4 || s === 12) this.snare(ctx, bus, noise, time);
        if (s % 2 === 1) this.hat(ctx, bus, noise, time, false, 0.08);
        if (s === 0) this.bass(ctx, bus, time, 36.71, 0.78, 0.55);
        if (s === 7) this.bass(ctx, bus, time, 41.2, 0.5, 0.42);
        return;
      }
      if (v === "jersey") {
        if (s === 0 || s === 3 || s === 8 || s === 11) this.kick(ctx, bus, time, 1);
        if (s === 4 || s === 12) this.snare(ctx, bus, noise, time);
        if (s % 2 === 0) this.hat(ctx, bus, noise, time, s === 6 || s === 14, 0.14);
        if (s === 0 || s === 8) this.bass(ctx, bus, time, 55, 0.48);
        return;
      }
      if (v === "lo-fi") {
        if (s === 0 || s === 10) this.kick(ctx, bus, time, s === 10 ? 0.55 : 0.85);
        if (s === 4 || s === 12) this.snare(ctx, bus, noise, time);
        if (s === 2 || s === 6 || s === 8 || s === 14) this.hat(ctx, bus, noise, time, s === 14, 0.12);
        if (s === 0) this.bass(ctx, bus, time, 65.41, 0.38);
        if (s === 8) this.bass(ctx, bus, time, 49, 0.3);
        return;
      }
      if (s === 0 || s === 8 || s === 10) this.kick(ctx, bus, time, s === 10 ? 0.55 : 1);
      if (s === 4 || s === 12) this.snare(ctx, bus, noise, time);
      if (s % 2 === 0) this.hat(ctx, bus, noise, time, s === 14);
      if (s === 0) this.bass(ctx, bus, time, 65.41, 0.55);
      if (s === 8) this.bass(ctx, bus, time, 49.0, 0.42);
      if (s === 10) this.bass(ctx, bus, time, 77.78, 0.28);
    },
    kick: function (ctx, bus, time, amp) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(148, time);
      osc.frequency.exponentialRampToValueAtTime(42, time + 0.08);
      gain.gain.setValueAtTime(amp, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
      osc.connect(gain); gain.connect(bus);
      osc.start(time); osc.stop(time + 0.34);
    },
    snare: function (ctx, bus, noise, time) {
      var src = ctx.createBufferSource();
      src.buffer = noise;
      var bp = ctx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = 1800; bp.Q.value = 0.9;
      var ng = ctx.createGain();
      ng.gain.setValueAtTime(0.55, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + 0.14);
      src.connect(bp); bp.connect(ng); ng.connect(bus);
      src.start(time); src.stop(time + 0.16);
      var osc = ctx.createOscillator();
      var og = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(186, time);
      og.gain.setValueAtTime(0.28, time);
      og.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
      osc.connect(og); og.connect(bus);
      osc.start(time); osc.stop(time + 0.12);
    },
    hat: function (ctx, bus, noise, time, open, amp) {
      var src = ctx.createBufferSource();
      src.buffer = noise;
      var hp = ctx.createBiquadFilter();
      hp.type = "highpass"; hp.frequency.value = open ? 6400 : 7800;
      var g = ctx.createGain();
      var dur = open ? 0.16 : 0.038;
      g.gain.setValueAtTime(amp != null ? amp : (open ? 0.22 : 0.16), time);
      g.gain.exponentialRampToValueAtTime(0.001, time + dur);
      src.connect(hp); hp.connect(g); g.connect(bus);
      src.start(time); src.stop(time + dur + 0.02);
    },
    bass: function (ctx, bus, time, freq, amp, slide) {
      if (slide == null) slide = 0.38;
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, time);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * 0.72), time + slide);
      g.gain.setValueAtTime(amp, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + slide + 0.16);
      osc.connect(g); g.connect(bus);
      osc.start(time); osc.stop(time + slide + 0.2);
    }
  };
};
`;
