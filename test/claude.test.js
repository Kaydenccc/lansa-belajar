'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { askClaude, buildRequest, parseAnswer } = require('../claude');

const data = {
  ada_soal: true,
  soal: '2, 6, 12, 20, ...?',
  topik: 'TIU - Deret angka',
  petunjuk: ['Perhatikan selisihnya.', ' '],
  jawaban: 'B. 30',
  penjelasan: 'Selisih 4, 6, 8, lalu 10.',
  tips: '',
  keyakinan: 'sedang',
};

test('request memakai skema JSON dan thinking sesuai model', () => {
  const sonnet = buildRequest('claude-sonnet-5-5', { jpegBase64: 'AAA' });
  assert.equal(sonnet.output_config.format.type, 'json_schema');
  assert.deepEqual(sonnet.thinking, { type: 'between_tools' });
  assert.match(sonnet.system, /petunjuk: array kosong/);
  const haiku = buildRequest('claude-haiku-5-5', { jpegBase64: 'AAA' }, { hintMode: true });
  assert.deepEqual(haiku.thinking, { type: 'disabled' });
  assert.match(haiku.system, /2 sampai 3 petunjuk bertahap/);
});

test('parseAnswer: jawaban, petunjuk kosong dibuang, keyakinan non-tinggi ditampilkan', () => {
  const r = parseAnswer(JSON.stringify(data), 'end_turn');
  assert.equal(r.kind, 'answer');
  assert.equal(r.soal, '2, 6, 12, 20, ...?');
  assert.equal(r.topik, 'TIU - Deret angka');
  assert.deepEqual(r.hints, ['Perhatikan selisihnya.']);
  assert.equal(r.text, 'Jawaban: B. 30\nPenjelasan: Selisih 4, 6, 8, lalu 10.\nTingkat keyakinan: sedang');
});

test('parseAnswer: tidak ada soal, terpotong, dan JSON rusak', () => {
  assert.equal(parseAnswer(JSON.stringify({ ...data, ada_soal: false }), 'end_turn').kind, 'none');
  assert.throws(() => parseAnswer('{"ada_soal": tr', 'max_tokens'), /terpotong/);
  assert.throws(() => parseAnswer('bukan json', 'end_turn'), /tidak dikenali/);
});

test('askClaude: refusal dan error HTTP', async (t) => {
  const reply = (status, obj) =>
    t.mock.method(globalThis, 'fetch', async () => ({ ok: status < 300, status, text: async () => JSON.stringify(obj) }));
  reply(200, { stop_reason: 'refusal', content: [] });
  assert.equal((await askClaude({ conn: { apiKey: 'k' }, model: 'claude-sonnet-5-5', jpegBase64: 'A' })).kind, 'refusal');
  reply(401, { error: { message: 'invalid x-api-key' } });
  await assert.rejects(askClaude({ conn: { apiKey: 'k' }, model: 'claude-sonnet-5-5', jpegBase64: 'A' }), /API key tidak valid/);
});

test('askClaude lewat server Lensa: bearer token, URL server, dan pesan error server', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, opt) => {
    seen.push({ url, headers: opt.headers });
    return { ok: false, status: 429, text: async () => JSON.stringify({ error: { message: 'Kuota harian habis (50/50). Coba lagi besok.' } }) };
  });
  await assert.rejects(
    askClaude({ conn: { serverUrl: 'https://lensa.contoh.id/', token: 'tok' }, model: 'claude-sonnet-5-5', jpegBase64: 'A' }),
    /Kuota atau batas pemakaian tercapai: Kuota harian habis \(50\/50\)/
  );
  assert.equal(seen[0].url, 'https://lensa.contoh.id/v1/messages');
  assert.equal(seen[0].headers.authorization, 'Bearer tok');
  assert.equal(seen[0].headers['x-api-key'], undefined);
});

test('jawaban singkat dan teks salinan', () => {
  const short = buildRequest('claude-haiku-5-5', { text: 'Apa arti integritas?' }, { short: true });
  assert.equal(short.max_tokens, 800);
  assert.equal(typeof short.messages[0].content, 'string');
  assert.ok(short.messages[0].content.includes('<<<\nApa arti integritas?\n>>>'));
  assert.match(short.system, /teks yang disalin/);
  assert.match(short.system, /maksimal 2 kalimat/);
  assert.match(short.system, /tips: string kosong/);
  assert.equal(buildRequest('claude-haiku-5-5', { jpegBase64: 'A' }).max_tokens, 2000);
});

test('parseAnswer: teks salinan yang bukan soal tetap ditanggapi, layar tidak', () => {
  const notQuestion = JSON.stringify({ ...data, ada_soal: false, jawaban: '', penjelasan: 'Integritas berarti jujur dan konsisten.' });
  assert.deepEqual(parseAnswer(notQuestion, 'end_turn', { source: 'teks' }), {
    kind: 'answer',
    soal: '',
    topik: 'TIU - Deret angka',
    hints: [],
    text: 'Integritas berarti jujur dan konsisten.',
  });
  assert.equal(parseAnswer(notQuestion, 'end_turn').kind, 'none');
});
