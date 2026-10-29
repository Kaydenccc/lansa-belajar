'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesCommand } = require('../voice-command');
const { SpeechSegmenter } = require('../vad');

const RATE = 16000;

test('perintah pendek berisi "baca" memicu', () => {
  for (const t of ['baca', 'Baca.', ' Baca. Selamat tinggal.', 'tolong baca', 'Tullong. Baca.', 'bacakan dong', 'BACA!']) {
    assert.ok(matchesCommand(t), t);
  }
});

test('kata lain dan kalimat percakapan tidak memicu', () => {
  for (const t of ['membaca', 'bacaan', 'dibaca', 'Bacha', '', ' Halo, how are you today?', 'Aku mau baca buku dulu. Nanti kita belajar.']) {
    assert.ok(!matchesCommand(t), t);
  }
});

// Audio sintetis: sunyi berderau kecil, lalu "ucapan" berupa nada 220 Hz.
function audio(parts) {
  const chunks = parts.map(([kind, seconds]) => {
    const n = Math.round(seconds * RATE);
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      a[i] = kind === 'speech' ? 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE) : (Math.random() - 0.5) * 0.004;
    }
    return a;
  });
  const out = new Float32Array(chunks.reduce((s, c) => s + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// Masukkan audio dalam potongan 128 sampel, seperti dari AudioWorklet.
function run(samples) {
  const seg = new SpeechSegmenter();
  const found = [];
  for (let i = 0; i < samples.length; i += 128) found.push(...seg.push(samples.subarray(i, i + 128)));
  return found;
}

test('VAD: satu ucapan pendek menghasilkan satu potongan berdurasi wajar', () => {
  const found = run(audio([['silence', 1], ['speech', 0.8], ['silence', 1]]));
  assert.equal(found.length, 1);
  const seconds = found[0].length / RATE;
  assert.ok(seconds > 0.8 && seconds < 1.6, `durasi ${seconds}`);
});

test('VAD: dua ucapan terpisah menjadi dua potongan', () => {
  const found = run(audio([['silence', 0.5], ['speech', 0.5], ['silence', 1], ['speech', 0.6], ['silence', 1]]));
  assert.equal(found.length, 2);
});

test('VAD: ucapan panjang (obrolan) dibuang, bunyi sangat pendek diabaikan', () => {
  assert.equal(run(audio([['silence', 0.5], ['speech', 4.5], ['silence', 1]])).length, 0);
  assert.equal(run(audio([['silence', 0.5], ['speech', 0.1], ['silence', 1]])).length, 0);
  assert.equal(run(audio([['silence', 3]])).length, 0);
});

test('VAD: setelah obrolan panjang selesai, perintah berikutnya tetap terdeteksi', () => {
  const found = run(audio([['silence', 0.5], ['speech', 4.5], ['silence', 1], ['speech', 0.7], ['silence', 1]]));
  assert.equal(found.length, 1);
});
