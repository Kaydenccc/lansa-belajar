'use strict';

// Pengendali perintah suara "baca" di proses utama: menjalankan worker Whisper dan mencocokkan perintah.

const path = require('node:path');
const { utilityProcess } = require('electron');
const { matchesCommand } = require('./voice-command');

class VoiceController {
  /**
   * onStatus(state, message): status untuk bar atas. onListening(on): minta jendela menyalakan/mematikan mikrofon.
   * onCommand(text): ucapan yang cocok dengan perintah "baca".
   */
  constructor({ cacheDir, onStatus, onListening, onCommand }) {
    Object.assign(this, { cacheDir, onStatus, onListening, onCommand });
    this.worker = null;
    this.ready = false;
  }

  start() {
    if (this.worker) return;
    this.ready = false;
    this.worker = utilityProcess.fork(path.join(__dirname, 'voice-worker.js'), [], { serviceName: 'Lensa Belajar Suara' });
    this.worker.on('message', (msg) => this.handle(msg));
    this.worker.on('exit', () => {
      const unexpected = this.worker !== null;
      this.worker = null;
      this.ready = false;
      this.onListening(false);
      if (unexpected) this.onStatus('error', 'Perintah suara berhenti tiba-tiba.');
    });
    this.onStatus('busy', 'Menyiapkan perintah suara...');
    this.worker.postMessage({ type: 'init', cacheDir: this.cacheDir });
  }

  stop() {
    const w = this.worker;
    this.worker = null;
    this.ready = false;
    this.onListening(false);
    if (w) w.kill();
  }

  /** Potongan ucapan (Float32Array 16 kHz) dari jendela aplikasi. */
  transcribe(audio) {
    if (this.worker && this.ready) this.worker.postMessage({ type: 'transcribe', audio });
  }

  handle(msg) {
    if (msg.type === 'progress') {
      this.onStatus('busy', `Mengunduh model suara (sekali saja)... ${msg.progress}%`);
    } else if (msg.type === 'ready') {
      this.ready = true;
      this.onListening(true);
      this.onStatus('idle', 'Ucapkan "baca" untuk membaca layar.');
    } else if (msg.type === 'result') {
      if (matchesCommand(msg.text)) this.onCommand(msg.text);
    } else if (msg.type === 'error') {
      this.onStatus('error', `Perintah suara gagal: ${msg.message}`);
      if (!this.ready) this.stop();
    }
  }
}

module.exports = { VoiceController };
