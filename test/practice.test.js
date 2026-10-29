'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PracticeStore, computeStats } = require('../practice');
const { parsePractice, buildPracticeRequest } = require('../claude');

const q = (over = {}) => ({
  topik: 'TIU - Deret angka',
  soal: '2, 6, 12, 20, ...',
  pilihan: ['28', '30', '32', '34', '36'],
  penjelasan: 'Selisih 4, 6, 8, lalu 10.',
  skor: [0, 5, 0, 0, 0],
  ...over,
});

test('parsePractice: soal valid dipakai, soal dengan skor tidak konsisten dibuang', () => {
  const text = JSON.stringify({
    soal_latihan: [
      q(),
      q({ skor: [5, 5, 0, 0, 0] }), // dua kunci
      q({ pilihan: ['a', 'b'] }), // pilihan kurang
      q({ topik: 'TKP - Pelayanan publik', skor: [3, 5, 1, 2, 4] }),
      q({ topik: 'TKP - Jejaring kerja', skor: [3, 5, 1, 1, 4] }), // nilai TKP berulang
    ],
  });
  const out = parsePractice(text, 'end_turn');
  assert.deepEqual(
    out.map((x) => [x.kategori, x.terbaik]),
    [
      ['TIU', 1],
      ['TKP', 1],
    ]
  );
  assert.throws(() => parsePractice(JSON.stringify({ soal_latihan: [q({ skor: [1, 1, 1, 1, 1] })] }), 'end_turn'), /tidak valid/);
  assert.throws(() => parsePractice('{"soal_latihan": [', 'max_tokens'), /terpotong/);
});

test('buildPracticeRequest: kategori atau fokus topik lemah', () => {
  const a = buildPracticeRequest('claude-haiku-5-5', { kategori: 'TWK' });
  assert.match(a.messages[0].content, /Kategori: TWK/);
  assert.equal(a.output_config.format.schema.properties.soal_latihan.items.required.at(-1), 'skor');
  const b = buildPracticeRequest('claude-haiku-5-5', { focusTopics: ['TIU - Deret angka', 'TWK - Pancasila'] });
  assert.match(b.messages[0].content, /TIU - Deret angka; TWK - Pancasila/);
});

test('PracticeStore menyimpan dan membaca ulang', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lensa-practice-')), 'practice.json');
  const store = new PracticeStore(file, () => 1000);
  store.record({ topik: 'TIU - Deret angka', benar: true, skor: 5 });
  store.record({ topik: 'TWK - Pancasila', benar: false, skor: 0 });
  const reloaded = new PracticeStore(file);
  assert.deepEqual(
    reloaded.list().map((a) => [a.kategori, a.benar]),
    [
      ['TIU', true],
      ['TWK', false],
    ]
  );
  reloaded.clear();
  assert.equal(new PracticeStore(file).list().length, 0);
});

test('computeStats: gabungan latihan + ulasan, urut dari terlemah, topik lemah', () => {
  const attempts = [
    { topik: 'TIU - Deret angka', benar: false },
    { topik: 'TIU - deret  Angka', benar: false }, // topik sama walau beda huruf/spasi
    { topik: 'TIU - Deret angka', benar: true },
    { topik: 'TWK - Pancasila', benar: true },
    { topik: 'TWK - Pancasila', benar: true },
  ];
  const history = [
    { topik: 'TIU - Deret angka', reviews: 2, lapses: 1 },
    { topik: 'TKP - Pelayanan publik', reviews: 0, lapses: 0 },
  ];
  const { topics, categories, weak } = computeStats(history, attempts);

  const deret = topics[0];
  assert.equal(deret.topik, 'TIU - Deret angka');
  assert.deepEqual([deret.latihan, deret.benar, deret.ulasan, deret.lupa, deret.total, deret.salah], [3, 1, 2, 1, 5, 3]);
  assert.equal(deret.akurasi, 0.4);
  assert.equal(topics[1].topik, 'TWK - Pancasila');
  assert.equal(topics[2].akurasi, null); // TKP: tersimpan tapi belum ada data
  assert.deepEqual(weak.map((w) => w.topik), ['TIU - Deret angka']);
  assert.deepEqual(categories.map((c) => c.kategori), ['TWK', 'TIU', 'TKP']);
});
