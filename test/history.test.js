'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HistoryStore, schedule, previewLabels, DAY_MS, RELEARN_MS } = require('../history');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lensa-history-'));
  const clock = { t: Date.UTC(2026, 0, 1) };
  const store = new HistoryStore(path.join(dir, 'history.json'), () => clock.t);
  return { store, clock, file: path.join(dir, 'history.json') };
}

const sample = { soal: '2, 6, 12, 20, ...?  A. 28  B. 30', topik: 'TIU - Deret angka', jawaban: 'Jawaban: B', model: 'm' };

test('soal baru masuk kotak 0 dan jatuh tempo besok', () => {
  const { store, clock } = makeStore();
  const item = store.add(sample);
  assert.equal(item.box, 0);
  assert.equal(item.due, clock.t + DAY_MS);
  assert.equal(store.due().length, 0);
  clock.t += DAY_MS;
  assert.equal(store.due().length, 1);
});

test('soal yang sama tidak diduplikasi dan jadwalnya tetap', () => {
  const { store } = makeStore();
  const a = store.add(sample);
  const b = store.add({ ...sample, soal: '  2, 6, 12, 20, ...?\nA. 28 B. 30 '.replace('B. 30', ' B. 30'), jawaban: 'baru' });
  assert.equal(store.list().length, 1);
  assert.equal(b.id, a.id);
  assert.equal(b.jawaban, 'baru');
});

test('jadwal Leitner: ingat naik kotak, ragu tetap, lupa kembali ke awal', () => {
  const now = 1000;
  const item = { box: 2, lapses: 0 };
  assert.deepEqual(schedule(item, 'ingat', now), { box: 3, due: now + 8 * DAY_MS, lapses: 0 });
  assert.deepEqual(schedule(item, 'ragu', now), { box: 2, due: now + 4 * DAY_MS, lapses: 0 });
  assert.deepEqual(schedule(item, 'lupa', now), { box: 0, due: now + RELEARN_MS, lapses: 1 });
  assert.equal(schedule({ box: 5, lapses: 0 }, 'ingat', now).box, 5);
  assert.throws(() => schedule(item, 'mungkin', now));
});

test('label pratinjau tombol', () => {
  assert.deepEqual(previewLabels({ box: 0, lapses: 0 }, 0), { lupa: '10 menit', ragu: '1 hari', ingat: '2 hari' });
});

test('review menyimpan ke disk dan bisa dibaca ulang', () => {
  const { store, clock, file } = makeStore();
  const item = store.add(sample);
  clock.t += DAY_MS;
  store.review(item.id, 'ingat');
  const reloaded = new HistoryStore(file, () => clock.t);
  const [saved] = reloaded.list();
  assert.equal(saved.box, 1);
  assert.equal(saved.reviews, 1);
  assert.equal(saved.due, clock.t + 2 * DAY_MS);
  assert.equal(reloaded.nextDueAt(), saved.due);
});

test('hapus satu dan hapus semua', () => {
  const { store } = makeStore();
  const a = store.add(sample);
  store.add({ ...sample, soal: 'Soal lain' });
  store.remove(a.id);
  assert.deepEqual(store.list().map((i) => i.soal), ['Soal lain']);
  store.clear();
  assert.equal(store.list().length, 0);
});
