'use strict';

const MAX_CARDS = 30;
const LETTERS = 'ABCDE';
const $ = (id) => document.getElementById(id);

const els = {
  analyze: $('btn-analyze'),
  region: $('btn-region'),
  status: $('status'),
  settingsBtn: $('btn-settings'),
  tabs: document.querySelectorAll('.tab'),
  views: document.querySelectorAll('.view'),
  dueBadge: $('due-badge'),
  cards: $('cards'),
  empty: $('empty'),
  ask: $('ask'),
  askText: $('ask-text'),
  reviewCard: $('review-card'),
  allQuestions: $('all-questions'),
  allSummary: $('all-summary'),
  historyList: $('history-list'),
  practice: $('practice-view'),
  stats: $('stats-view'),
  // Pengaturan
  connRadios: document.querySelectorAll('input[name=connection]'),
  directFields: $('direct-fields'),
  freeFields: $('free-fields'),
  freeInfo: $('free-info'),
  freeInputs: { groq: $('groq-key'), openrouter: $('openrouter-key') },
  apiKey: $('api-key'),
  clearKey: $('btn-clear-key'),
  keyInfo: $('key-info'),
  serverFields: $('server-fields'),
  serverSignedIn: $('server-signed-in'),
  serverSignedOut: $('server-signed-out'),
  serverUser: $('server-user'),
  serverUrl: $('server-url'),
  serverEmail: $('server-email'),
  serverPassword: $('server-password'),
  serverName: $('server-name'),
  serverTenant: $('server-tenant'),
  serverLogin: $('btn-server-login'),
  serverRegister: $('btn-server-register'),
  serverSiparakai: $('btn-server-siparakai'),
  serverLogout: $('btn-server-logout'),
  model: $('model'),
  hint: $('chk-hint'),
  short: $('chk-short'),
  clip: $('chk-clip'),
  voice: $('chk-voice'),
  mic: $('mic'),
  top: $('chk-top'),
  saveHistory: $('chk-save-history'),
  clearHistory: $('btn-clear-history'),
  clearPractice: $('btn-clear-practice'),
};

let currentView = 'answers';
let lastView = 'answers';
let connection = 'direct';
let statusTimer = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className, onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

// Pesan "idle" hilang sendiri; pesan sibuk dan error tetap sampai ada status baru.
function setStatus(state, message = '') {
  clearTimeout(statusTimer);
  els.status.className = `status ${state}`;
  els.status.textContent = message;
  els.analyze.disabled = state === 'busy';
  els.region.disabled = state === 'busy';
  if (state === 'idle' && message) statusTimer = setTimeout(() => (els.status.textContent = ''), 4000);
}

// Electron membungkus error IPC: "Error invoking remote method 'x': Error: pesan".
function cleanIpcError(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ms) {
  return new Date(ms).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ---------- Navigasi ----------

function showView(name) {
  if (name !== 'settings') lastView = name;
  currentView = name;
  for (const tab of els.tabs) tab.classList.toggle('active', tab.dataset.view === name);
  for (const view of els.views) view.hidden = view.dataset.view !== name;
  els.settingsBtn.classList.toggle('active', name === 'settings');
  if (name === 'review') renderReview();
  if (name === 'practice' && !practice.questions) renderPracticeStart();
  if (name === 'stats') renderStats();
}

// ---------- Jawaban ----------

// Semua teks dari AI ditampilkan lewat textContent, tidak pernah sebagai HTML.
function addCard(result) {
  els.empty.hidden = true;
  const card = el('article', `card ${result.kind}`);
  const body = el('div', 'card-body');
  const copy = button('Salin', '', async () => {
    try {
      await window.lensa.copyText(body.textContent);
      copy.textContent = 'Tersalin';
    } catch {
      copy.textContent = 'Gagal';
    }
    setTimeout(() => (copy.textContent = 'Salin'), 1500);
  });
  const head = el('div', 'card-head');
  const topic = result.topik || (result.source === 'salinan' ? 'Teks salinan' : '');
  // Mode gratis: tampilkan model yang menjawab, mis. "Groq qwen3.8-27b".
  const via = result.servedBy ? ` · ${result.servedBy.replace(/ \S*\//, ' ').replace(':free', '')}` : '';
  head.append(el('span', 'topic', topic), el('span', 'meta', formatTime(result.time) + via), copy);
  card.append(head, body);
  if (result.hints?.length) setupHints(card, body, result);
  else body.textContent = result.text;

  els.cards.insertBefore(card, els.empty.nextSibling);
  const cards = els.cards.querySelectorAll('.card');
  for (let i = MAX_CARDS; i < cards.length; i++) cards[i].remove();
}

// "Petunjuk dulu": petunjuk dibuka satu per satu, jawaban lengkap paling akhir.
function setupHints(card, body, result) {
  const { hints } = result;
  let stage = 1; // jumlah petunjuk yang terbuka; melebihi hints.length berarti jawaban juga terbuka
  const next = button('', 'reveal', () => {
    stage++;
    render();
  });
  card.append(next);
  const render = () => {
    const parts = hints.slice(0, stage).map((h, i) => `Petunjuk ${i + 1}: ${h}`);
    if (stage > hints.length) parts.push(result.text);
    body.textContent = parts.join('\n\n');
    if (stage < hints.length) next.textContent = `Petunjuk ${stage + 1}`;
    else if (stage === hints.length) next.textContent = 'Lihat jawaban';
    else next.remove();
  };
  render();
}

// ---------- Ulas (+ semua soal tersimpan) ----------

async function refreshDueBadge() {
  const { items } = await window.lensa.historyDue();
  els.dueBadge.hidden = items.length === 0;
  els.dueBadge.textContent = String(items.length);
}

async function renderReview() {
  const { items, nextDueAt } = await window.lensa.historyDue();
  els.reviewCard.replaceChildren();
  if (!items.length) {
    const msg = nextDueAt ? `Tidak ada yang perlu diulas. Berikutnya ${formatDate(nextDueAt)}.` : 'Belum ada soal tersimpan.';
    els.reviewCard.append(el('p', 'empty', msg));
  } else {
    const item = items[0];
    const card = el('article', 'card');
    const head = el('div', 'card-head');
    head.append(el('span', 'topic', item.topik || 'Tanpa topik'), el('span', 'meta', `${items.length} tersisa`));
    const answer = el('div', 'answer', item.jawaban);
    answer.hidden = true;
    const rating = el('div', 'rating');
    rating.hidden = true;
    for (const [key, label] of [
      ['lupa', 'Lupa'],
      ['ragu', 'Ragu'],
      ['ingat', 'Ingat'],
    ]) {
      const b = button('', key, async () => {
        await window.lensa.historyReview(item.id, key);
        renderReview();
      });
      b.append(document.createTextNode(label), el('small', '', item.preview[key]));
      rating.append(b);
    }
    const reveal = button('Lihat jawaban', 'reveal', () => {
      answer.hidden = false;
      rating.hidden = false;
      reveal.remove();
    });
    card.append(head, el('div', 'card-body', item.soal), answer, reveal, rating);
    els.reviewCard.append(card);
  }
  renderAllQuestions();
}

async function renderAllQuestions() {
  const items = await window.lensa.historyList();
  els.allQuestions.hidden = items.length === 0;
  els.allSummary.textContent = `Semua soal (${items.length})`;
  els.historyList.replaceChildren();
  for (const item of items) {
    const card = el('article', 'card');
    const answer = el('div', 'answer', item.jawaban);
    answer.hidden = true;
    const del = button('Hapus', '', async (e) => {
      e.stopPropagation();
      await window.lensa.historyDelete(item.id);
    });
    const head = el('div', 'card-head');
    head.append(el('span', 'topic', item.topik || 'Tanpa topik'), el('span', 'meta', formatDate(item.createdAt)), del);
    card.append(head, el('div', 'card-body', item.soal), answer);
    card.addEventListener('click', () => {
      card.classList.toggle('open');
      answer.hidden = !card.classList.contains('open');
    });
    els.historyList.append(card);
  }
}

// ---------- Latihan ----------

const practice = { questions: null, index: 0, correct: 0, label: '' };

async function renderPracticeStart() {
  practice.questions = null;
  const { weak } = await window.lensa.statsGet();
  const choices = el('div', 'choices');
  for (const k of ['TWK', 'TIU', 'TKP']) choices.append(button(k, '', () => startPractice({ kategori: k }, k)));
  if (weak.length) {
    const topics = weak.map((w) => w.topik);
    const b = button('Topik terlemah', 'wide', () => startPractice({ focusTopics: topics }, 'Topik terlemah'));
    b.title = topics.join(', ');
    choices.append(b);
  }
  els.practice.replaceChildren(choices);
}

async function startPractice({ kategori, focusTopics = [] }, label) {
  els.practice.replaceChildren(el('p', 'empty', 'Membuat soal...'));
  try {
    practice.questions = await window.lensa.practiceGenerate(kategori, focusTopics);
    Object.assign(practice, { index: 0, correct: 0, label });
    renderQuestion();
  } catch (err) {
    els.practice.replaceChildren(el('p', 'empty', cleanIpcError(err)), button('Kembali', '', renderPracticeStart));
  }
}

function renderQuestion() {
  const q = practice.questions[practice.index];
  const total = practice.questions.length;
  const card = el('article', 'card');
  const head = el('div', 'card-head');
  head.append(el('span', 'topic', q.topik), el('span', 'meta', `${practice.index + 1}/${total}`));
  const options = el('div', 'options');
  const buttons = q.pilihan.map((p, i) => button(`${LETTERS[i]}. ${p}`, '', () => answer(i)));
  options.append(...buttons);
  card.append(head, el('div', 'card-body', q.soal), options);

  const answer = async (chosen) => {
    for (const b of buttons) b.disabled = true;
    const benar = await window.lensa.practiceRecord(q, chosen);
    if (benar) practice.correct++;
    buttons[q.terbaik].classList.add('best');
    if (!benar) buttons[chosen].classList.add('wrong');
    let verdict;
    if (benar) verdict = 'Tepat!';
    else if (q.kategori === 'TKP') verdict = `Skor ${q.skor[chosen]}/5 · terbaik ${LETTERS[q.terbaik]}`;
    else verdict = `Jawaban: ${LETTERS[q.terbaik]}`;
    const last = practice.index === total - 1;
    const next = button(last ? 'Selesai' : 'Lanjut', 'reveal', () => {
      if (last) return renderSummary();
      practice.index++;
      renderQuestion();
    });
    card.append(el('div', `verdict ${benar ? 'ok' : 'bad'}`, verdict), el('div', 'answer', q.penjelasan), next);
    next.scrollIntoView({ block: 'nearest' });
  };

  els.practice.replaceChildren(card);
}

function renderSummary() {
  const card = el('article', 'card');
  card.append(
    el('div', 'topic', practice.label),
    el('div', 'card-body', `${practice.correct} dari ${practice.questions.length} tepat`),
    button('Latihan lagi', 'reveal', renderPracticeStart)
  );
  els.practice.replaceChildren(card);
}

// ---------- Statistik ----------

function statRow(row, name, { weak = false, onTrain } = {}) {
  const wrap = el('div', 'stat-row');
  const a = row.akurasi;
  wrap.append(el('span', `topic${weak ? ' weak' : ''}`, name), el('span', '', a === null ? '–' : `${Math.round(a * 100)}%`));
  const bar = el('div', `bar ${a === null ? '' : a < 0.5 ? 'low' : a < 0.7 ? 'mid' : ''}`);
  const fill = el('span');
  fill.style.width = `${Math.round((a ?? 0) * 100)}%`;
  bar.append(fill);
  const detail = [];
  if (row.latihan) detail.push(`latihan ${row.benar}/${row.latihan}`);
  if (row.ulasan) detail.push(`ulasan ${row.ulasan - row.lupa}/${row.ulasan}`);
  wrap.append(bar, el('span', 'meta', detail.join(' · ') || 'belum ada data'));
  if (onTrain) wrap.append(button('Latih', '', onTrain));
  return wrap;
}

async function renderStats() {
  const { topics, categories, weak } = await window.lensa.statsGet();
  if (!topics.length) {
    els.stats.replaceChildren(el('p', 'empty', 'Belum ada data.'));
    return;
  }
  const weakKeys = new Set(weak.map((w) => w.topik));
  const section = (title, rows) => {
    const card = el('article', 'card');
    const stack = el('div', 'stack');
    stack.append(...rows);
    card.append(el('div', 'meta', title), stack);
    return card;
  };
  els.stats.replaceChildren(
    section('Kategori', categories.map((c) => statRow(c, c.kategori))),
    section(
      'Topik',
      topics.map((t) =>
        statRow(t, t.topik, {
          weak: weakKeys.has(t.topik),
          onTrain:
            t.kategori === 'Lainnya'
              ? null
              : () => {
                  showView('practice');
                  startPractice({ focusTopics: [t.topik] }, t.topik);
                },
        })
      )
    )
  );
}

// ---------- Pengaturan ----------

function renderKeyInfo(state) {
  const info = { env: 'Memakai ANTHROPIC_API_KEY.', stored: 'Tersimpan terenkripsi.' };
  let text = info[state.keySource] || 'Belum ada API key.';
  if (!state.encryptionAvailable) text += ' Enkripsi sistem tidak tersedia; gunakan ANTHROPIC_API_KEY.';
  els.keyInfo.textContent = text;
  els.clearKey.disabled = state.keySource !== 'stored';
}

function renderConnection(state) {
  connection = state.connection;
  for (const r of els.connRadios) r.checked = r.value === state.connection;
  els.directFields.hidden = state.connection !== 'direct';
  els.freeFields.hidden = state.connection !== 'free';
  // Mode gratis memakai rantai model tetap, jadi pilihan model Claude disembunyikan.
  els.model.hidden = state.connection === 'free';
  const mark = (on) => (on ? 'tersimpan ✓' : 'belum ada');
  els.freeInfo.textContent = `Groq: ${mark(state.freeKeys.groq)} · OpenRouter: ${mark(state.freeKeys.openrouter)}. Jika kuota satu model habis, model berikutnya dipakai otomatis.`;
  els.serverFields.hidden = state.connection !== 'server';
  const user = state.serverUser;
  els.serverSignedIn.hidden = !user;
  els.serverSignedOut.hidden = !!user;
  if (!els.serverUrl.value) els.serverUrl.value = state.serverUrl;
  if (user) {
    els.serverUser.textContent = user.name || user.email;
    refreshQuota();
  }
}

async function refreshQuota() {
  if (connection !== 'server' || els.serverSignedIn.hidden) return;
  const base = els.serverUser.textContent.split(' · ')[0];
  try {
    const profile = await window.lensa.serverProfile();
    if (profile) els.serverUser.textContent = `${base} · kuota ${profile.quota.remaining}/${profile.quota.limit}`;
  } catch (err) {
    setStatus('error', cleanIpcError(err));
    // Sesi yang berakhir sudah dilupakan oleh proses utama; tampilkan form masuk lagi.
    renderConnection(await window.lensa.getState());
  }
}

async function serverAuth(method) {
  setStatus('busy', 'Menghubungi server...');
  try {
    const { state } = await window.lensa.serverAuth({
      method,
      serverUrl: els.serverUrl.value,
      email: els.serverEmail.value,
      password: els.serverPassword.value,
      name: els.serverName.value,
      tenant: els.serverTenant.value,
    });
    els.serverPassword.value = '';
    renderConnection(state);
    setStatus('idle', 'Berhasil masuk.');
  } catch (err) {
    setStatus('error', cleanIpcError(err));
  }
}

// Key langsung disimpan saat ditempel, atau saat kolom ditinggalkan / Enter setelah diketik manual.
function saveOnPaste(input, save) {
  const run = async () => {
    const value = input.value.trim();
    if (!value) return;
    try {
      await save(value);
      input.value = '';
      setStatus('idle', 'Key tersimpan.');
    } catch (err) {
      setStatus('error', cleanIpcError(err));
    }
  };
  input.addEventListener('paste', () => setTimeout(run, 0));
  input.addEventListener('change', run);
}

function confirmThen(question, action) {
  return async () => {
    if (confirm(question)) await action();
  };
}

// ---------- Inisialisasi ----------

async function init() {
  const state = await window.lensa.getState();
  for (const [id, label] of Object.entries(state.models)) {
    const opt = el('option', '', label);
    opt.value = id;
    els.model.append(opt);
  }
  els.model.value = state.model;
  els.top.checked = state.alwaysOnTop;
  els.hint.checked = state.hintMode;
  els.short.checked = state.shortAnswers;
  els.clip.checked = state.clipboardWatch;
  els.voice.checked = state.voiceCommand;
  els.saveHistory.checked = state.saveHistory;
  renderKeyInfo(state);
  renderConnection(state);
  const ready =
    state.connection === 'server'
      ? !!state.serverUser
      : state.connection === 'free'
        ? state.freeKeys.groq || state.freeKeys.openrouter
        : !!state.keySource;
  if (!ready) showView('settings');

  window.lensa.onStatus((s) => setStatus(s.state, s.message));
  window.lensa.onResult((r) => {
    addCard(r);
    refreshQuota();
    // Jangan memutus ulasan atau latihan yang sedang berjalan.
    if (currentView === 'stats' || currentView === 'settings') showView('answers');
  });
  window.lensa.onHistoryChanged(() => {
    refreshDueBadge();
    if (currentView === 'review') renderAllQuestions();
  });
  refreshDueBadge();
  setInterval(refreshDueBadge, 60_000);

  for (const tab of els.tabs) tab.addEventListener('click', () => showView(tab.dataset.view));
  els.settingsBtn.addEventListener('click', () => showView(currentView === 'settings' ? lastView : 'settings'));
  els.analyze.addEventListener('click', () => window.lensa.analyze());
  els.ask.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (await window.lensa.askText(els.askText.value)) els.askText.value = '';
      else setStatus('error', 'Masih membaca, coba lagi sebentar.');
    } catch (err) {
      setStatus('error', cleanIpcError(err));
    }
  });
  // Enter = tanya, Shift+Enter = baris baru.
  els.askText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      els.ask.requestSubmit();
    }
  });
  els.region.addEventListener('click', () => window.lensa.analyzeRegion());

  for (const r of els.connRadios) {
    r.addEventListener('change', async () => renderConnection(await window.lensa.setConnection(r.value)));
  }
  for (const [provider, input] of Object.entries(els.freeInputs)) {
    saveOnPaste(input, async (value) => renderConnection(await window.lensa.saveFreeKey(provider, value)));
  }
  for (const b of document.querySelectorAll('[data-clear-free]')) {
    b.addEventListener('click', async () => renderConnection(await window.lensa.clearFreeKey(b.dataset.clearFree)));
  }
  els.serverLogin.addEventListener('click', () => serverAuth('login'));
  els.serverRegister.addEventListener('click', () => serverAuth('register'));
  els.serverSiparakai.addEventListener('click', () => serverAuth('siparakai'));
  els.serverLogout.addEventListener('click', async () => renderConnection(await window.lensa.serverLogout()));

  saveOnPaste(els.apiKey, async (value) => renderKeyInfo(await window.lensa.saveApiKey(value)));
  els.clearKey.addEventListener('click', async () => renderKeyInfo(await window.lensa.clearApiKey()));

  els.model.addEventListener('change', () => window.lensa.setModel(els.model.value));
  els.hint.addEventListener('change', async () => (els.hint.checked = await window.lensa.setHintMode(els.hint.checked)));
  els.short.addEventListener('change', async () => (els.short.checked = await window.lensa.setShortAnswers(els.short.checked)));
  els.clip.addEventListener('change', async () => (els.clip.checked = await window.lensa.setClipboardWatch(els.clip.checked)));
  els.voice.addEventListener('change', async () => (els.voice.checked = await window.lensa.setVoiceCommand(els.voice.checked)));

  // Perintah suara: proses utama meminta mikrofon dinyalakan setelah model Whisper siap.
  const capture = new VoiceCapture((segment) => window.lensa.voiceSegment(segment));
  window.lensa.onVoiceListen(async (on) => {
    if (!on) {
      capture.stop();
      els.mic.hidden = true;
      return;
    }
    try {
      await capture.start();
      els.mic.hidden = false;
    } catch (err) {
      setStatus('error', `Mikrofon tidak bisa dipakai: ${err.message}`);
      els.voice.checked = await window.lensa.setVoiceCommand(false);
    }
  });
  els.top.addEventListener('change', async () => (els.top.checked = await window.lensa.setAlwaysOnTop(els.top.checked)));
  els.saveHistory.addEventListener(
    'change',
    async () => (els.saveHistory.checked = await window.lensa.setSaveHistory(els.saveHistory.checked))
  );
  els.clearHistory.addEventListener(
    'click',
    confirmThen('Hapus semua riwayat soal dan jadwal ulasannya?', async () => {
      await window.lensa.historyClear();
      setStatus('idle', 'Riwayat dihapus.');
    })
  );
  els.clearPractice.addEventListener(
    'click',
    confirmThen('Hapus semua hasil latihan?', async () => {
      await window.lensa.practiceClear();
      setStatus('idle', 'Data latihan dihapus.');
    })
  );
}

init().catch((err) => setStatus('error', cleanIpcError(err)));
