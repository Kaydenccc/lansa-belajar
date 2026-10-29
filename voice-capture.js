'use strict';

/* global SpeechSegmenter */

// Mikrofon → AudioWorklet (16 kHz) → pemotong ucapan → potongan ucapan pendek dikirim ke proses utama.
class VoiceCapture {
  constructor(onSegment) {
    this.onSegment = onSegment;
    this.stream = null;
    this.ctx = null;
  }

  get active() {
    return this.stream !== null;
  }

  async start() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    try {
      this.ctx = new AudioContext({ sampleRate: 16000 });
      await this.ctx.audioWorklet.addModule('voice-worklet.js');
      const source = this.ctx.createMediaStreamSource(this.stream);
      const tap = new AudioWorkletNode(this.ctx, 'lensa-tap');
      const segmenter = new SpeechSegmenter({ sampleRate: this.ctx.sampleRate });
      tap.port.onmessage = (e) => {
        for (const segment of segmenter.push(e.data)) this.onSegment(segment);
      };
      source.connect(tap);
      // Node keluaran hanya berisi sunyi; disambungkan supaya worklet terus diproses.
      tap.connect(this.ctx.destination);
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  stop() {
    if (this.stream) for (const track of this.stream.getTracks()) track.stop();
    if (this.ctx) this.ctx.close();
    this.stream = null;
    this.ctx = null;
  }
}
