'use strict';

/**
 * Mode "Gratis": rantai model dari penyedia berkuota gratis (Groq, OpenRouter) lewat API
 * kompatibel OpenAI. Jika satu model gagal atau kuotanya habis, model berikutnya dicoba otomatis.
 * Request dan respons diterjemahkan dari/ke bentuk Claude Messages API, supaya sisa aplikasi tidak berubah.
 */

const ENDPOINTS = {
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', label: 'Groq' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', label: 'OpenRouter' },
};

// Model "berpikir" dulu sebelum menjawab (jauh lebih teliti untuk soal); pemikirannya tidak dikirim balik.
// Qwen di Groq tidak berpikir pada pengaturan bawaan. Lihat console.groq.com/docs/reasoning.
const THINK = {
  qwen: { reasoning_effort: 'medium', reasoning_format: 'hidden' },
  gptOss: { reasoning_effort: 'medium', include_reasoning: false },
  openrouter: { reasoning: { effort: 'medium', exclude: true } },
};

// Diperiksa Oktober 2026 (console.groq.com/docs/vision, openrouter.ai/api/v1/models).
const CHAINS = {
  image: [
    { provider: 'groq', model: 'qwen/qwen3.8-27b', think: THINK.qwen },
    { provider: 'openrouter', model: 'nvidia/nemotron-3.5-super-vl:free', think: THINK.openrouter },
    { provider: 'openrouter', model: 'google/gemma-4-31b-it:free' },
  ],
  text: [
    { provider: 'groq', model: 'openai/gpt-oss-120b', think: THINK.gptOss },
    { provider: 'groq', model: 'qwen/qwen3.8-27b', think: THINK.qwen },
    { provider: 'groq', model: 'openai/gpt-oss-20b', think: THINK.gptOss },
    { provider: 'openrouter', model: 'nvidia/nemotron-3.5-super-vl:free', think: THINK.openrouter },
    { provider: 'openrouter', model: 'google/gemma-4-31b-it:free' },
  ],
};

const DEFAULT_COOLDOWN_MS = 60_000;
const AUTH_COOLDOWN_MS = 10 * 60_000;
// Token "berpikir" ikut dihitung; batas dinaikkan supaya JSON tidak terpotong (tetap gratis).
const MIN_FREE_MAX_TOKENS = 4000;

// Model yang sedang kehabisan kuota / ditolak dilewati sampai waktu ini (ms).
const cooldowns = new Map();

const keyOf = (step) => `${step.provider}/${step.model}`;

/**
 * Key salah (401/403) berlaku untuk semua model penyedia itu. Kuota gratis OpenRouter dihitung per akun,
 * sedangkan kuota Groq dihitung per model.
 */
function blocksWholeProvider(provider, status) {
  return status === 401 || status === 403 || (provider === 'openrouter' && status === 429);
}

function isCoolingDown(step, now) {
  return Math.max(cooldowns.get(keyOf(step)) || 0, cooldowns.get(step.provider) || 0) > now;
}

function hasImage(request) {
  const content = request.messages?.[0]?.content;
  return Array.isArray(content) && content.some((b) => b.type === 'image');
}

/** Claude Messages API → chat completions (OpenAI-compatible). Skema JSON dijelaskan di prompt sistem. */
function toOpenAI(request, model, think) {
  const schema = request.output_config?.format?.schema;
  const system = schema
    ? `${request.system}\n\nBalas HANYA dengan satu objek JSON yang valid (tanpa teks lain, tanpa markdown) sesuai skema berikut:\n${JSON.stringify(schema)}`
    : request.system;
  const content = request.messages[0].content;
  const user =
    typeof content === 'string'
      ? content
      : content.map((b) =>
          b.type === 'image'
            ? { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
            : { type: 'text', text: b.text }
        );
  return {
    model,
    max_tokens: Math.max(request.max_tokens || 0, MIN_FREE_MAX_TOKENS),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    ...(schema && { response_format: { type: 'json_object' } }),
    ...think,
  };
}

/** Chat completions → bentuk pesan Claude ({ content: [{type:'text'}], stop_reason }). */
function fromOpenAI(body) {
  const choice = body.choices?.[0] || {};
  const text = String(choice.message?.content || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
  return {
    content: [{ type: 'text', text }],
    stop_reason: choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
    model: body.model,
  };
}

function cooldownFor(status, headers) {
  if (status === 401 || status === 403) return AUTH_COOLDOWN_MS;
  const retryAfter = Number(headers?.get?.('retry-after'));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : DEFAULT_COOLDOWN_MS;
}

function describe(status, bodyText) {
  let detail = '';
  try {
    detail = JSON.parse(bodyText)?.error?.message || '';
  } catch {
    detail = String(bodyText).slice(0, 120);
  }
  const hint = { 401: 'key tidak valid', 403: 'akses ditolak', 404: 'model tidak tersedia', 429: 'kuota habis' }[status];
  return [hint || `HTTP ${status}`, detail].filter(Boolean).join(': ');
}

/**
 * Coba setiap model dalam rantai sampai satu berhasil dan hasilnya bisa dibaca oleh parse(msg).
 * keys: { groq, openrouter }. Mengembalikan { result, servedBy }.
 */
async function callFreeChain(keys, request, parse, { timeoutMs = 60000, now = Date.now, fetchImpl = fetch } = {}) {
  const chain = CHAINS[hasImage(request) ? 'image' : 'text'].filter((s) => keys[s.provider]);
  if (!chain.length) throw new Error('Isi key Groq atau OpenRouter di Pengaturan.');
  const errors = [];
  for (const step of chain) {
    const label = `${ENDPOINTS[step.provider].label} ${step.model}`;
    if (isCoolingDown(step, now())) {
      errors.push(`${label}: dilewati sementara`);
      continue;
    }
    const post = (think) =>
      fetchImpl(ENDPOINTS[step.provider].url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${keys[step.provider]}` },
        body: JSON.stringify(toOpenAI(request, step.model, think)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    let res;
    let bodyText;
    try {
      res = await post(step.think);
      bodyText = await res.text();
      // Jika penyedia menolak parameter berpikir, jangan lewati modelnya: coba lagi tanpa parameter itu.
      if (res.status === 400 && step.think) {
        res = await post(undefined);
        bodyText = await res.text();
      }
    } catch (err) {
      errors.push(`${label}: ${err.name === 'TimeoutError' ? 'waktu habis' : err.message}`);
      continue;
    }
    if (!res.ok) {
      if ([401, 403, 404, 429].includes(res.status) || res.status >= 500) {
        const target = blocksWholeProvider(step.provider, res.status) ? step.provider : keyOf(step);
        cooldowns.set(target, now() + cooldownFor(res.status, res.headers));
      }
      errors.push(`${label}: ${describe(res.status, bodyText)}`);
      continue;
    }
    try {
      return { result: parse(fromOpenAI(JSON.parse(bodyText))), servedBy: label };
    } catch (err) {
      // Jawaban tidak bisa dibaca (mis. JSON rusak/terpotong): coba model berikutnya.
      errors.push(`${label}: ${err.message}`);
    }
  }
  throw new Error(`Semua model gratis gagal. ${errors.join(' · ')}`);
}

function resetCooldowns() {
  cooldowns.clear();
}

module.exports = { callFreeChain, toOpenAI, fromOpenAI, CHAINS, ENDPOINTS, resetCooldowns };
