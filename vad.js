'use strict';

/**
 * Pemotong ucapan sederhana berbasis energi (dipakai di jendela aplikasi, bisa diuji di Node).
 * Audio mono 16 kHz dimasukkan per potongan; setiap ucapan pendek yang selesai dikembalikan utuh
 * untuk ditranskripsi. Ucapan yang terlalu panjang dianggap obrolan dan dibuang.
 */
class SpeechSegmenter {
  constructor({
    sampleRate = 16000,
    frameMs = 20,
    startFrames = 3, // berapa frame berturut-turut di atas ambang untuk dianggap mulai bicara
    endSilenceMs = 500, // jeda sunyi yang menandai akhir ucapan
    preRollMs = 200, // audio sebelum awal ucapan yang ikut disertakan
    minSpeechMs = 250,
    maxSpeechMs = 3000,
    minThreshold = 0.012,
  } = {}) {
    this.frameLen = Math.round((sampleRate * frameMs) / 1000);
    this.startFrames = startFrames;
    this.endFrames = Math.round(endSilenceMs / frameMs);
    this.preRollFrames = Math.round(preRollMs / frameMs);
    this.minFrames = Math.round(minSpeechMs / frameMs);
    this.maxFrames = Math.round(maxSpeechMs / frameMs);
    this.minThreshold = minThreshold;
    this.noise = minThreshold / 3;
    this.pending = new Float32Array(0);
    this.preRoll = [];
    this.frames = [];
    this.loud = 0;
    this.quiet = 0;
    this.state = 'idle'; // idle | speech | toolong
  }

  get threshold() {
    return Math.max(this.minThreshold, this.noise * 3);
  }

  /** Masukkan audio; mengembalikan daftar ucapan (Float32Array) yang selesai pada potongan ini. */
  push(samples) {
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending);
    joined.set(samples, this.pending.length);
    const out = [];
    let i = 0;
    for (; i + this.frameLen <= joined.length; i += this.frameLen) {
      const segment = this.frame(joined.slice(i, i + this.frameLen));
      if (segment) out.push(segment);
    }
    this.pending = joined.slice(i);
    return out;
  }

  frame(f) {
    let sum = 0;
    for (const v of f) sum += v * v;
    const rms = Math.sqrt(sum / f.length);
    const loud = rms > this.threshold;

    if (this.state === 'idle') {
      if (!loud) this.noise = 0.95 * this.noise + 0.05 * rms;
      this.preRoll.push(f);
      if (this.preRoll.length > this.preRollFrames + this.startFrames) this.preRoll.shift();
      this.loud = loud ? this.loud + 1 : 0;
      if (this.loud >= this.startFrames) {
        this.state = 'speech';
        this.frames = this.preRoll;
        this.preRoll = [];
        this.quiet = 0;
      }
      return null;
    }

    this.quiet = loud ? 0 : this.quiet + 1;
    if (this.state === 'toolong') {
      // Tunggu sampai obrolan panjang selesai sebelum mendengarkan lagi.
      if (this.quiet >= this.endFrames) this.reset();
      return null;
    }

    this.frames.push(f);
    if (this.frames.length > this.maxFrames + this.preRollFrames) {
      this.state = 'toolong';
      this.frames = [];
      return null;
    }
    if (this.quiet < this.endFrames) return null;

    const speechFrames = this.frames.length - this.preRollFrames - this.quiet;
    const frames = this.frames;
    this.reset();
    if (speechFrames < this.minFrames) return null;
    const audio = new Float32Array(frames.length * this.frameLen);
    frames.forEach((fr, k) => audio.set(fr, k * this.frameLen));
    return audio;
  }

  reset() {
    this.state = 'idle';
    this.frames = [];
    this.preRoll = [];
    this.loud = 0;
    this.quiet = 0;
  }
}

if (typeof module !== 'undefined') module.exports = { SpeechSegmenter };
