'use strict';

// Panggilan ke Claude Messages API (REST langsung, sesuai PANDUAN.md bagian 3).
// Kedua mode memakai keluaran JSON terstruktur supaya teks soal dan topiknya bisa disimpan
// untuk riwayat dan ulasan ulang.

const { categoryOf } = require('./practice');
const { callFreeChain } = require('./providers');

const API_URL = 'https://api.anthropic.com/v1/messages';

const MODELS = {
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 (default)',
  'claude-haiku-5-5': 'Claude Haiku 5.5 (hemat)',
};
const DEFAULT_MODEL = 'claude-sonnet-5-5';

function systemPrompt(hintMode, { short = false, source = 'layar' } = {}) {
  const hintRule = hintMode
    ? `${short ? '1 sampai 2' : '2 sampai 3'} petunjuk bertahap. Petunjuk pertama paling umum (konsep atau rumus yang diuji), berikutnya makin spesifik. Jangan menyebut opsi yang benar atau hasil akhir di petunjuk mana pun.`
    : 'array kosong.';
  const fromText = source === 'teks';
  const intro = fromText
    ? 'Kamu menerima teks yang disalin pengguna saat belajar.'
    : 'Kamu menerima tangkapan layar (penuh atau sebagian) milik pengguna yang sedang belajar atau latihan soal.';
  const adaSoal = fromText
    ? 'ada_soal: true jika teks berisi pertanyaan/soal. Jika bukan soal, isi false, kosongkan jawaban, dan tulis tanggapan singkat (arti, ringkasan, atau koreksi) di kolom penjelasan.'
    : 'ada_soal: true jika ada pertanyaan/soal di layar, false jika tidak ada (kolom lain boleh kosong).';
  const penjelasan = short
    ? 'penjelasan: inti alasannya saja, maksimal 2 kalimat pendek.'
    : 'penjelasan: langkah-langkah singkat dan jelas supaya pengguna paham konsepnya. Jika soal berpilihan ganda, jelaskan mengapa opsi lain salah. Untuk soal TKP (tes CPNS), jelaskan alasan skor tertinggi berdasarkan nilai ASN (BerAKHLAK).';
  const tips = short ? 'tips: string kosong.' : 'tips: satu kiat cepat untuk soal sejenis, atau string kosong jika tidak relevan.';
  return `Kamu adalah tutor belajar yang membantu pengguna memahami materi dan soal latihan apa pun: pelajaran sekolah, kuliah, tes masuk, tes CPNS (TWK, TIU, TKP), dan pengetahuan umum.
${intro}${hintMode ? '\nPengguna memakai mode "petunjuk dulu": mereka ingin mencoba berpikir sendiri sebelum melihat jawaban.' : ''}
Isi setiap kolom dalam Bahasa Indonesia:
- ${adaSoal}
- soal: salin teks soal secara ringkas beserta pilihan jawabannya (jika ada), supaya bisa diulas lagi. Jangan sertakan nama, nomor peserta, atau data pribadi lain.
- topik: kategori singkat dengan pola "Bidang - Subtopik", misalnya "TIU - Deret angka", "TWK - Pancasila", "Matematika - Pecahan".
- petunjuk: ${hintRule}
- jawaban: pilihan atau hasil akhir. Kerjakan dulu dengan teliti: untuk pilihan ganda, uji setiap pilihan satu per satu; untuk analogi, tentukan jenis hubungannya secara tepat (alat, bahan, objek, tempat, hasil, pelaku) lalu cari pasangan dengan hubungan yang sama persis. Abaikan warna atau tanda jawaban yang mungkin sudah tampil.
- ${penjelasan}
- ${tips}
- keyakinan: tinggi, sedang, atau rendah. Jika ada pilihan lain yang juga bisa dibenarkan, sebutkan pilihan itu di penjelasan dan isi sedang atau rendah. Jujurlah jika ragu.
- Jangan gunakan format markdown (tanpa tanda bintang atau pagar).`;
}

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    ada_soal: { type: 'boolean' },
    soal: { type: 'string' },
    topik: { type: 'string' },
    petunjuk: { type: 'array', items: { type: 'string' } },
    jawaban: { type: 'string' },
    penjelasan: { type: 'string' },
    tips: { type: 'string' },
    keyakinan: { type: 'string', enum: ['tinggi', 'sedang', 'rendah'] },
  },
  required: ['ada_soal', 'soal', 'topik', 'petunjuk', 'jawaban', 'penjelasan', 'tips', 'keyakinan'],
  additionalProperties: false,
};

const MAX_COPIED_CHARS = 4000;

// Thinking dimatikan agar seluruh max_tokens dipakai untuk jawaban.
// Sonnet 5.5 menolak {type:"disabled"} dan memakai "between_tools" sebagai setelan terendah.
function thinkingFor(model) {
  return model === 'claude-sonnet-5-5' ? { type: 'between_tools' } : { type: 'disabled' };
}

/**
 * input: { jpegBase64 } untuk gambar (layar penuh atau area), atau { text } untuk teks yang disalin.
 * short: jawaban singkat (penjelasan maks. 2 kalimat, tanpa tips) supaya token lebih hemat.
 */
function buildRequest(model, { jpegBase64, text }, { hintMode = false, short = false } = {}) {
  const source = text !== undefined ? 'teks' : 'layar';
  const content =
    source === 'teks'
      ? `Teks yang disalin:\n<<<\n${String(text).slice(0, MAX_COPIED_CHARS)}\n>>>`
      : [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegBase64 } },
          { type: 'text', text: 'Lihat gambar ini. Jika ada soal, bantu jawab dan jelaskan.' },
        ];
  return {
    model,
    // Batas atas saja (yang ditagih hanya token terpakai); JSON yang terpotong tidak bisa dibaca.
    max_tokens: short ? 800 : 2000,
    thinking: thinkingFor(model),
    system: systemPrompt(hintMode, { short, source }),
    output_config: { format: { type: 'json_schema', schema: ANSWER_SCHEMA } },
    messages: [{ role: 'user', content }],
  };
}

// Server Lensa memakai bentuk error yang sama dengan Claude API ({ error: { message } }).
function describeHttpError(status, body, { viaServer = false } = {}) {
  let detail = '';
  try {
    detail = JSON.parse(body)?.error?.message || '';
  } catch {
    detail = body.slice(0, 200);
  }
  const hints = {
    400: 'Permintaan tidak valid',
    401: viaServer ? 'Sesi server berakhir' : 'API key tidak valid',
    403: viaServer ? 'Akun ditolak server' : 'Akses ditolak untuk API key ini',
    404: 'Model tidak ditemukan',
    413: 'Gambar terlalu besar',
    429: viaServer ? 'Kuota atau batas pemakaian tercapai' : 'Batas pemakaian tercapai, coba lagi sebentar lagi',
    500: 'Server Anthropic sedang bermasalah',
    502: 'Server Lensa gagal menghubungi Claude',
    529: 'Server Anthropic sedang sibuk',
  };
  const hint = hints[status] || `HTTP ${status}`;
  return detail ? `${hint}: ${detail}` : hint;
}

function formatAnswer(data) {
  const lines = [`Jawaban: ${data.jawaban}`, `Penjelasan: ${data.penjelasan}`];
  if (data.tips?.trim()) lines.push(`Tips: ${data.tips}`);
  if (data.keyakinan && data.keyakinan !== 'tinggi') lines.push(`Tingkat keyakinan: ${data.keyakinan}`);
  return lines.join('\n');
}

// source 'teks': teks salinan yang bukan soal tetap ditanggapi singkat (tanpa disimpan ke riwayat).
// Model gratis kadang membungkus JSON dengan ```json ... ``` atau menambahkan teks; ambil objeknya saja.
function extractJson(text) {
  const s = String(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
}

function parseAnswer(text, stopReason, { source = 'layar' } = {}) {
  if (stopReason === 'max_tokens') throw new Error('Jawaban terpotong sebelum selesai. Coba lagi.');
  let data;
  try {
    data = JSON.parse(extractJson(text));
  } catch {
    throw new Error('Format jawaban tidak dikenali. Coba lagi.');
  }
  if (!data.ada_soal) {
    const reply = String(data.penjelasan || '').trim();
    if (source !== 'teks' || !reply) return { kind: 'none' };
    return { kind: 'answer', soal: '', topik: String(data.topik || '').trim(), hints: [], text: reply };
  }
  return {
    kind: 'answer',
    soal: String(data.soal || '').trim(),
    topik: String(data.topik || '').trim(),
    hints: (data.petunjuk || []).map((h) => String(h).trim()).filter(Boolean),
    text: formatAnswer(data),
  };
}

/**
 * Kirim satu request Messages API; mengembalikan pesan yang sudah di-parse.
 * conn: { apiKey } untuk langsung ke Anthropic, atau { serverUrl, token } lewat server Lensa (butir 4).
 */
async function callMessages(conn, request, timeoutMs) {
  const viaServer = !!conn.serverUrl;
  const url = viaServer ? `${conn.serverUrl.replace(/\/+$/, '')}/v1/messages` : API_URL;
  const auth = viaServer ? { authorization: `Bearer ${conn.token}` } : { 'x-api-key': conn.apiKey };
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...auth },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('Waktu habis menunggu jawaban dari Claude');
    throw new Error(`Gagal terhubung ke ${viaServer ? 'server Lensa' : 'API'}: ${err.message}`);
  }
  const body = await res.text();
  if (!res.ok) throw new Error(describeHttpError(res.status, body, { viaServer }));
  return JSON.parse(body);
}

const messageText = (msg) =>
  (msg.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

/**
 * Gambar ({ jpegBase64 }) atau teks salinan ({ text }).
 * Mengembalikan { kind: 'none' | 'refusal' } atau { kind: 'answer', soal, topik, hints, text }.
 */
async function askClaude({ conn, model, jpegBase64, text, hintMode = false, short = false, timeoutMs = 60000 }) {
  const request = buildRequest(model, { jpegBase64, text }, { hintMode, short });
  const source = text !== undefined ? 'teks' : 'layar';
  if (conn.free) {
    // Mode gratis: rantai model; jawaban yang tidak terbaca membuat model berikutnya dicoba.
    const { result, servedBy } = await callFreeChain(
      conn.free,
      request,
      (msg) => parseAnswer(messageText(msg), msg.stop_reason, { source }),
      { timeoutMs }
    );
    return { ...result, servedBy };
  }
  const msg = await callMessages(conn, request, timeoutMs);
  if (msg.stop_reason === 'refusal') {
    return { kind: 'refusal', text: 'Model menolak menjawab permintaan ini.' };
  }
  return parseAnswer(messageText(msg), msg.stop_reason, { source });
}

// ---------- Latihan soal (butir 3) ----------

const PRACTICE_COUNT = 5;

const PRACTICE_SYSTEM_PROMPT = `Kamu adalah pembuat soal latihan tes CPNS (SKD) yang teliti, untuk pengguna yang belajar mandiri.
Buat soal pilihan ganda orisinal (bukan salinan soal resmi) dalam Bahasa Indonesia.
Cakupan kategori:
- TWK (Tes Wawasan Kebangsaan): Pancasila, UUD 1945, NKRI, Bhinneka Tunggal Ika, nasionalisme, integritas, bela negara, bahasa Indonesia.
- TIU (Tes Intelegensia Umum): verbal (analogi, silogisme, penalaran analitis) dan numerik (deret, hitung cepat, perbandingan, soal cerita). Jangan membuat soal figural/gambar.
- TKP (Tes Karakteristik Pribadi): pelayanan publik, jejaring kerja, sosial budaya, teknologi informasi, profesionalisme, anti radikalisme.
Aturan tiap soal:
- topik: pola "KATEGORI - Subtopik", misalnya "TIU - Deret angka" atau "TKP - Pelayanan publik".
- soal: teks soal lengkap tanpa pilihan jawaban.
- pilihan: tepat 5 teks pilihan, tanpa huruf A sampai E di depannya.
- penjelasan: kerjakan dulu langkah demi langkah dan periksa ulang hasilnya, lalu jelaskan mengapa jawaban terbaik benar dan opsi lain kurang tepat. Untuk TKP, jelaskan berdasarkan nilai ASN BerAKHLAK.
- TWK dan TIU: pastikan hanya satu pilihan yang benar. Pengecoh tidak boleh bisa dibenarkan dengan tafsiran lain; misalnya pada analogi, jangan sertakan pilihan yang cocok dengan jenis hubungan lain yang juga masuk akal.
- skor: 5 bilangan bulat sesuai urutan pilihan. TWK dan TIU: 5 untuk satu-satunya jawaban benar dan 0 untuk yang lain. TKP: nilai 1 sampai 5, masing-masing dipakai tepat sekali.
- Jangan gunakan format markdown (tanpa tanda bintang atau pagar).`;

// Urutan kolom sengaja: penjelasan ditulis sebelum skor, supaya kunci jawaban ditentukan setelah soal dikerjakan.
const PRACTICE_SCHEMA = {
  type: 'object',
  properties: {
    soal_latihan: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topik: { type: 'string' },
          soal: { type: 'string' },
          pilihan: { type: 'array', items: { type: 'string' } },
          penjelasan: { type: 'string' },
          skor: { type: 'array', items: { type: 'integer' } },
        },
        required: ['topik', 'soal', 'pilihan', 'penjelasan', 'skor'],
        additionalProperties: false,
      },
    },
  },
  required: ['soal_latihan'],
  additionalProperties: false,
};

function buildPracticeRequest(model, { kategori, focusTopics = [] }) {
  const lines = [`Buat ${PRACTICE_COUNT} soal latihan.`];
  if (focusTopics.length) {
    lines.push(`Fokuskan pada subtopik yang masih lemah ini: ${focusTopics.join('; ')}.`);
  } else {
    lines.push(`Kategori: ${kategori}. Variasikan subtopiknya.`);
  }
  return {
    model,
    // 5 soal beserta penjelasan; batas atas saja (yang ditagih hanya token terpakai).
    max_tokens: 6000,
    thinking: thinkingFor(model),
    system: PRACTICE_SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: PRACTICE_SCHEMA } },
    messages: [{ role: 'user', content: lines.join('\n') }],
  };
}

// Soal yang skornya tidak sesuai aturan dibuang supaya kunci jawaban yang ditampilkan selalu konsisten.
function validQuestion(q) {
  if (!q || !Array.isArray(q.pilihan) || !Array.isArray(q.skor)) return false;
  if (q.pilihan.length !== 5 || q.skor.length !== 5 || !q.soal?.trim()) return false;
  if (!q.skor.every(Number.isInteger)) return false;
  if (categoryOf(q.topik) === 'TKP') return [...q.skor].sort().join() === '1,2,3,4,5';
  return q.skor.filter((s) => s === 5).length === 1 && q.skor.filter((s) => s === 0).length === 4;
}

function parsePractice(text, stopReason) {
  if (stopReason === 'max_tokens') throw new Error('Soal latihan terpotong sebelum selesai. Coba lagi.');
  let data;
  try {
    data = JSON.parse(extractJson(text));
  } catch {
    throw new Error('Format soal latihan tidak dikenali. Coba lagi.');
  }
  const questions = (data.soal_latihan || []).filter(validQuestion).map((q) => ({
    topik: q.topik.trim(),
    kategori: categoryOf(q.topik),
    soal: q.soal.trim(),
    pilihan: q.pilihan.map((p) => String(p).trim()),
    penjelasan: q.penjelasan.trim(),
    skor: q.skor,
    terbaik: q.skor.indexOf(Math.max(...q.skor)),
  }));
  if (!questions.length) throw new Error('Soal latihan yang dibuat tidak valid. Coba lagi.');
  return questions;
}

async function generatePractice({ conn, model, kategori, focusTopics, timeoutMs = 120000 }) {
  const request = buildPracticeRequest(model, { kategori, focusTopics });
  if (conn.free) {
    const { result } = await callFreeChain(conn.free, request, (msg) => parsePractice(messageText(msg), msg.stop_reason), {
      timeoutMs,
    });
    return result;
  }
  const msg = await callMessages(conn, request, timeoutMs);
  if (msg.stop_reason === 'refusal') throw new Error('Model menolak membuat soal latihan ini.');
  return parsePractice(messageText(msg), msg.stop_reason);
}

module.exports = {
  askClaude,
  buildRequest,
  describeHttpError,
  parseAnswer,
  generatePractice,
  buildPracticeRequest,
  parsePractice,
  extractJson,
  MODELS,
  DEFAULT_MODEL,
  ANSWER_SCHEMA,
  MAX_COPIED_CHARS,
};
