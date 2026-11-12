import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { CALM_RATE, POCKET_JS, schedulePhrases, verseLines } from "../src/beats.ts";
import { CYPHER_DECK_JS } from "../src/cypher-deck.ts";
import { decodeWav, encodeWav, packPocket, preparePhrase } from "../src/audio.ts";

function strongBeat(bpm) {
  return (60 / bpm) * 2;
}

function onKicks(starts, bpm) {
  const strong = strongBeat(bpm);
  for (const start of starts) {
    const q = start / strong;
    assert.ok(Math.abs(q - Math.round(q)) < 1e-9, `${start} is not on a kick at ${bpm} bpm`);
  }
}

test("schedulePhrases lands every line on beat 1 or 3 and matches the browser copy", () => {
  const cases = [
    [90, [0.4, 0, 1.2, 2.4]],
    [82, [0.2, 0.8, 3]],
    [140, [0.5, 0.5, 0.5, 1.6]],
    [160, [0]],
  ];
  const sandbox = { result: null };
  vm.createContext(sandbox);
  vm.runInContext(POCKET_JS, sandbox);
  for (const [bpm, durations] of cases) {
    const slots = schedulePhrases(durations, bpm);
    const js = JSON.parse(
      vm.runInContext(`JSON.stringify(schedulePhrases(${JSON.stringify(durations)}, ${bpm}))`, sandbox)
    );
    assert.deepEqual(js, slots);
    assert.equal(slots.length, durations.length);
    onKicks(slots.map((s) => s.start), bpm);
    let cursor = 0;
    for (let i = 0; i < slots.length; i++) {
      assert.equal(slots[i].start, cursor);
      assert.ok(slots[i].slots >= 1);
      const strong = strongBeat(bpm);
      if (durations[i] > 0.001) {
        assert.ok(slots[i].slots * strong * 0.9 + 1e-9 >= durations[i]);
      }
      cursor += slots[i].slots * strong;
    }
  }
});

test("calm rate slows a phrase and the packed attacks sit on the kicks", () => {
  assert.ok(CALM_RATE < 1 && CALM_RATE >= 0.7);
  const sr = 24000;
  const burst = (sec) => {
    const n = Math.floor(sec * sr);
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = 0.35;
    return samples;
  };
  const raw = [burst(0.45), null, burst(1.05)];
  const prepared = raw.map((p) => (p ? preparePhrase(p, sr) : null));
  assert.ok(prepared[0].length > raw[0].length);
  assert.equal(prepared[1], null);
  const bpm = 90;
  const packed = packPocket(prepared, sr, bpm);
  onKicks(packed.phraseStarts, bpm);
  assert.equal(packed.phraseStarts.length, 3);
  assert.equal(packed.phraseStarts[0], 0);

  const attacks = [];
  let i = 0;
  while (i < packed.pcm.length) {
    while (i < packed.pcm.length && Math.abs(packed.pcm[i]) <= 0.012) i++;
    if (i >= packed.pcm.length) break;
    attacks.push(i / sr);
    while (i < packed.pcm.length && Math.abs(packed.pcm[i]) > 0.012) i++;
  }
  const spoken = packed.phraseStarts.filter((_, idx) => prepared[idx]);
  assert.equal(attacks.length, spoken.length);
  for (let n = 0; n < spoken.length; n++) {
    assert.ok(Math.abs(attacks[n] - spoken[n]) < 0.02, `attack ${attacks[n]} vs kick ${spoken[n]}`);
  }

  const wav = encodeWav(packed.pcm, sr);
  const decoded = decodeWav(wav);
  assert.ok(decoded);
  assert.equal(decoded.sampleRate, sr);
  assert.equal(decoded.samples.length, packed.pcm.length);
});

test("verse lines keep blank lines so rests stay on the grid", () => {
  const lines = verseLines("one\n\ntwo");
  assert.deepEqual(lines, ["one", "", "two"]);
  const legacy = verseLines("I'm Rift - don't ask, absorb it. Truth engine.");
  assert.ok(legacy.length > 4);
  assert.ok(legacy.includes(""));
});

function installDeck() {
  const started = [];
  function gainParam() {
    return {
      value: 1,
      setValueAtTime() {},
      exponentialRampToValueAtTime() {},
      setTargetAtTime() {},
      cancelScheduledValues() {},
    };
  }
  function AudioContext() {
    this.currentTime = 10;
    this.sampleRate = 24000;
    this.state = "running";
    this.destination = {};
  }
  AudioContext.prototype.resume = () => Promise.resolve();
  AudioContext.prototype.createGain = () => ({ gain: gainParam(), connect() {} });
  AudioContext.prototype.createDynamicsCompressor = () => ({
    threshold: { value: 0 },
    knee: { value: 0 },
    ratio: { value: 1 },
    attack: { value: 0 },
    release: { value: 0 },
    connect() {},
  });
  AudioContext.prototype.createBiquadFilter = () => ({
    type: "highpass",
    frequency: { value: 90 },
    Q: { value: 0.7 },
    connect() {},
  });
  AudioContext.prototype.createOscillator = () => ({
    type: "sine",
    frequency: { value: 100, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
    connect() {},
    start() {},
    stop() {},
  });
  AudioContext.prototype.createBuffer = (_ch, len, sr) => {
    const data = new Float32Array(len);
    return {
      duration: len / sr,
      sampleRate: sr,
      length: len,
      numberOfChannels: 1,
      getChannelData: () => data,
    };
  };
  AudioContext.prototype.createBufferSource = () => {
    const src = {
      buffer: null,
      playbackRate: { value: 1 },
      connect() {},
      start(when, offset, duration) {
        if (duration === undefined) return;
        started.push({ when, offset: offset ?? 0, duration, rate: src.playbackRate.value });
      },
      stop() {},
      onended: null,
    };
    return src;
  };
  AudioContext.prototype.decodeAudioData = (buf) => {
    let dur = 4;
    if (buf.byteLength === 8) dur = new DataView(buf).getFloat64(0);
    const sr = 24000;
    const length = Math.max(1, Math.floor(dur * sr));
    const data = new Float32Array(length);
    data.fill(0.25);
    return Promise.resolve({
      duration: length / sr,
      sampleRate: sr,
      length,
      numberOfChannels: 1,
      getChannelData: () => data,
    });
  };
  const sandbox = {
    window: { AudioContext, webkitAudioContext: AudioContext },
    AudioContext,
    webkitAudioContext: AudioContext,
    setTimeout: () => 1,
    clearTimeout: () => {},
    Math,
    isFinite,
    parseFloat,
    String,
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(CYPHER_DECK_JS, sandbox);
  const deck = sandbox.window.createCypherDeck();
  deck.setVibe("boom-bap");
  return { deck, started };
}

test("pocket audio plays at rate 1 from the next downbeat", async () => {
  const { deck, started } = installDeck();
  const buf = new ArrayBuffer(16);
  await deck.drop(buf, 4, "0.0000,1.3333,2.6667,4.0000");
  assert.equal(started.length, 1);
  assert.equal(started[0].rate, 1);
  const downbeat = 10.03 + deck.stepTime(16);
  assert.ok(Math.abs(started[0].when - downbeat) < 1e-6);
  assert.equal(deck.phraseStarts.length, 4);
  deck.stop();
});

test("separate phrases start on successive kicks and never play faster than calm", async () => {
  const { deck, started } = installDeck();
  const buf = (sec) => {
    const b = new ArrayBuffer(8);
    new DataView(b).setFloat64(0, sec);
    return b;
  };
  await deck.dropPhrases([buf(0.5), null, buf(1)], CALM_RATE);
  assert.equal(started.length, 2);
  for (const src of started) assert.ok(src.rate <= CALM_RATE + 1e-9);
  const downbeat = started[0].when;
  const slots = schedulePhrases([0.5 / CALM_RATE, 0, 1 / CALM_RATE], deck.bpm);
  assert.ok(Math.abs(started[0].when - (10.03 + deck.stepTime(16))) < 1e-6);
  assert.ok(Math.abs(started[1].when - (downbeat + slots[2].start)) < 1e-6);
  onKicks([started[0].when - downbeat, started[1].when - downbeat], deck.bpm);
  deck.stop();
});
