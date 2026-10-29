'use strict';

// Proses terpisah (Electron utilityProcess) untuk transkripsi Whisper lokal, supaya jendela tidak macet.
// Audio tidak pernah meninggalkan komputer; hanya model yang diunduh sekali dari Hugging Face.

const { pipeline, env } = require('@huggingface/transformers');

const MODEL = 'Xenova/whisper-tiny'; // multibahasa, ±40 MB (q8)
let asr = null;
let queue = Promise.resolve();

const send = (msg) => process.parentPort.postMessage(msg);

async function init(cacheDir) {
  env.cacheDir = cacheDir;
  env.allowLocalModels = false;
  asr = await pipeline('automatic-speech-recognition', MODEL, {
    dtype: 'q8',
    progress_callback: (p) => {
      if (p.status === 'progress' && typeof p.progress === 'number' && String(p.file).endsWith('.onnx')) {
        send({ type: 'progress', progress: Math.round(p.progress) });
      }
    },
  });
  send({ type: 'ready' });
}

async function transcribe(audio) {
  const out = await asr(audio, { language: 'indonesian', task: 'transcribe' });
  send({ type: 'result', text: String(out.text || '').trim() });
}

process.parentPort.on('message', (e) => {
  const msg = e.data;
  // Diproses berurutan: satu transkripsi selesai sebelum yang berikutnya dimulai.
  queue = queue
    .then(() => (msg.type === 'init' ? init(msg.cacheDir) : msg.type === 'transcribe' && asr ? transcribe(msg.audio) : null))
    .catch((err) => send({ type: 'error', message: err.message || String(err) }));
});
