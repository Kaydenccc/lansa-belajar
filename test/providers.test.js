'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { callFreeChain, toOpenAI, fromOpenAI, resetCooldowns } = require('../providers');
const { buildRequest, parseAnswer, extractJson } = require('../claude');

const answer = JSON.stringify({
  ada_soal: true,
  soal: '2 + 2 = ?',
  topik: 'Matematika - Penjumlahan',
  petunjuk: [],
  jawaban: '4',
  penjelasan: 'Dua ditambah dua.',
  tips: '',
  keyakinan: 'tinggi',
});

/** fetch tiruan: replies[model] = { status, body } atau fungsi. */
function fakeFetch(replies, log) {
  return async (url, opt) => {
    const body = JSON.parse(opt.body);
    log.push({ url, model: body.model, auth: opt.headers.authorization, body });
    const reply = replies[body.model];
    const r = (typeof reply === 'function' ? reply(body) : reply) || { status: 404, body: { error: { message: 'model not found' } } };
    return {
      ok: r.status < 300,
      status: r.status,
      headers: { get: (h) => (h === 'retry-after' ? r.retryAfter ?? null : null) },
      text: async () => JSON.stringify(r.body),
    };
  };
}

const ok = (content, finish = 'stop') => ({ status: 200, body: { model: 'x', choices: [{ message: { content }, finish_reason: finish }] } });
const parse = (msg) => parseAnswer(msg.content[0].text, msg.stop_reason);

test('toOpenAI: gambar jadi data URL, skema masuk prompt sistem, JSON mode aktif', () => {
  const req = buildRequest('claude-haiku-5-5', { jpegBase64: 'QUJD' }, { short: true });
  const o = toOpenAI(req, 'qwen/qwen3.8-27b');
  assert.equal(o.model, 'qwen/qwen3.8-27b');
  assert.equal(o.messages[0].role, 'system');
  assert.match(o.messages[0].content, /Balas HANYA dengan satu objek JSON/);
  assert.match(o.messages[0].content, /"ada_soal"/);
  assert.deepEqual(o.messages[1].content[0], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } });
  assert.deepEqual(o.response_format, { type: 'json_object' });
  assert.equal(o.max_tokens, 4000);
});

test('fromOpenAI + extractJson: blok <think> dan pagar markdown dibuang', () => {
  const msg = fromOpenAI({ choices: [{ message: { content: '<think>hmm</think>\n```json\n' + answer + '\n```' }, finish_reason: 'stop' }] });
  assert.equal(msg.stop_reason, 'end_turn');
  assert.equal(JSON.parse(extractJson(msg.content[0].text)).jawaban, '4');
  assert.equal(fromOpenAI({ choices: [{ message: { content: '{' }, finish_reason: 'length' }] }).stop_reason, 'max_tokens');
});

test('rantai gambar: kuota Groq habis (429) → OpenRouter, lalu Groq dilewati selama cooldown', async () => {
  resetCooldowns();
  const log = [];
  const clock = { t: 1_000_000 };
  const fetchImpl = fakeFetch(
    {
      'qwen/qwen3.8-27b': { status: 429, retryAfter: '120', body: { error: { message: 'Rate limit reached' } } },
      'nvidia/nemotron-3.5-super-vl:free': ok(answer),
    },
    log
  );
  const req = buildRequest('x', { jpegBase64: 'QUJD' });
  const keys = { groq: 'gsk_test', openrouter: 'sk-or-test' };

  const first = await callFreeChain(keys, req, parse, { fetchImpl, now: () => clock.t });
  assert.equal(first.result.text, 'Jawaban: 4\nPenjelasan: Dua ditambah dua.');
  assert.equal(first.servedBy, 'OpenRouter nvidia/nemotron-3.5-super-vl:free');
  assert.deepEqual(log.map((l) => l.model), ['qwen/qwen3.8-27b', 'nvidia/nemotron-3.5-super-vl:free']);
  assert.equal(log[0].auth, 'Bearer gsk_test');
  assert.match(log[0].url, /api\.groq\.com/);
  assert.match(log[1].url, /openrouter\.ai/);

  log.length = 0;
  clock.t += 60_000; // masih dalam retry-after 120 detik
  await callFreeChain(keys, req, parse, { fetchImpl, now: () => clock.t });
  assert.deepEqual(log.map((l) => l.model), ['nvidia/nemotron-3.5-super-vl:free']);

  log.length = 0;
  clock.t += 61_000; // cooldown selesai: Groq dicoba lagi
  await callFreeChain(keys, req, parse, { fetchImpl, now: () => clock.t });
  assert.equal(log[0].model, 'qwen/qwen3.8-27b');
});

test('jawaban rusak atau terpotong membuat model berikutnya dicoba', async () => {
  resetCooldowns();
  const log = [];
  const fetchImpl = fakeFetch(
    {
      'openai/gpt-oss-120b': ok('maaf, ini bukan JSON'),
      'qwen/qwen3.8-27b': ok('{"ada_soal": tr', 'length'),
      'openai/gpt-oss-20b': ok(answer),
    },
    log
  );
  const req = buildRequest('x', { text: 'Berapa 2 + 2?' });
  const r = await callFreeChain({ groq: 'gsk' }, req, parse, { fetchImpl });
  assert.equal(r.servedBy, 'Groq openai/gpt-oss-20b');
  assert.deepEqual(log.map((l) => l.model), ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b']);
});

test('hanya penyedia yang punya key yang dipakai; semua gagal → pesan berisi alasan tiap model', async () => {
  resetCooldowns();
  const log = [];
  const fetchImpl = fakeFetch({}, log);
  const req = buildRequest('x', { jpegBase64: 'QUJD' });
  await assert.rejects(callFreeChain({ openrouter: 'sk-or' }, req, parse, { fetchImpl }), (err) => {
    assert.match(err.message, /^Semua model gratis gagal\./);
    assert.match(err.message, /OpenRouter nvidia\/nemotron-3\.5-super-vl:free: model tidak tersedia/);
    assert.match(err.message, /OpenRouter google\/gemma-4-31b-it:free/);
    return true;
  });
  assert.ok(log.every((l) => l.url.includes('openrouter.ai')));
  await assert.rejects(callFreeChain({}, req, parse, { fetchImpl }), /Isi key Groq atau OpenRouter/);
});

test('key salah (401) melewati semua model penyedia itu; 429 OpenRouter menunda seluruh OpenRouter', async () => {
  resetCooldowns();
  const log = [];
  const unauthorized = { status: 401, body: { error: { message: 'Invalid API Key' } } };
  const fetchImpl = fakeFetch(
    {
      'openai/gpt-oss-120b': unauthorized,
      'qwen/qwen3.8-27b': unauthorized,
      'openai/gpt-oss-20b': unauthorized,
      'nvidia/nemotron-3.5-super-vl:free': { status: 429, body: { error: { message: 'free-models-per-day' } } },
      'google/gemma-4-31b-it:free': ok(answer),
    },
    log
  );
  const req = buildRequest('x', { text: 'Berapa 2 + 2?' });
  await assert.rejects(callFreeChain({ groq: 'salah', openrouter: 'sk-or' }, req, parse, { fetchImpl }), /Semua model gratis gagal/);
  assert.deepEqual(log.map((l) => l.model), ['openai/gpt-oss-120b', 'nvidia/nemotron-3.5-super-vl:free']);
});

test('model diminta berpikir dulu; jika parameter itu ditolak (400), model yang sama dicoba lagi tanpanya', async () => {
  resetCooldowns();
  const log = [];
  const fetchImpl = fakeFetch(
    {
      'qwen/qwen3.8-27b': (body) =>
        body.reasoning_effort ? { status: 400, body: { error: { message: 'unsupported reasoning_effort' } } } : ok(answer),
    },
    log
  );
  const req = buildRequest('x', { jpegBase64: 'QUJD' });
  const r = await callFreeChain({ groq: 'gsk' }, req, parse, { fetchImpl });
  assert.equal(r.servedBy, 'Groq qwen/qwen3.8-27b');
  assert.equal(log[0].body.reasoning_effort, 'medium');
  assert.equal(log[0].body.reasoning_format, 'hidden');
  assert.equal(log[1].body.reasoning_effort, undefined);
  assert.equal(log.length, 2);

  const text = toOpenAI(buildRequest('x', { text: 'a' }), 'openai/gpt-oss-120b', { reasoning_effort: 'medium', include_reasoning: false });
  assert.equal(text.include_reasoning, false);
});
