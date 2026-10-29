'use strict';

const path = require('node:path');
const fs = require('node:fs');
const {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  screen,
  session,
  systemPreferences,
  Tray,
} = require('electron');
const { askClaude, generatePractice, MODELS, DEFAULT_MODEL, MAX_COPIED_CHARS } = require('./claude');
const { HistoryStore } = require('./history');
const { PracticeStore, computeStats } = require('./practice');
const {
  normalizeServerUrl,
  authenticate: serverAuthenticate,
  profile: serverProfile,
  logout: serverLogout,
} = require('./server-client');
const { VoiceController } = require('./voice');
const { spawn } = require('node:child_process');

const APP_TITLE = 'Lensa Belajar';
const SHORTCUT_SCREEN = 'CommandOrControl+Shift+A';
const SHORTCUT_REGION = 'CommandOrControl+Shift+S';
const MAX_IMAGE_SIDE = 1600;
const JPEG_QUALITY = 80;
const MIN_GAP_MS = 3000;

let win = null;
let tray = null;
let isQuitting = false;
let lensaPidFile = null;
let lensaQuitFile = null;
let topEnforcer = null;
let busy = false;
let lastCallAt = 0;
let history = null; // dibuat setelah app siap (butuh path userData)
let practice = null;
let voice = null; // perintah suara "baca" (Whisper lokal)

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Pengaturan (userData/settings.json) ----------

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return s;
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}

function currentModel() {
  const m = loadSettings().model;
  return MODELS[m] ? m : DEFAULT_MODEL;
}

// Rahasia (API key, token sesi server) disimpan terenkripsi lewat safeStorage di settings.json.
async function storeSecret(field, value) {
  const enc = await safeStorage.encryptStringAsync(value);
  saveSettings({ [field]: enc.toString('base64') });
}

async function readSecret(field) {
  const enc = loadSettings()[field];
  if (!enc || !(await safeStorage.isAsyncEncryptionAvailable())) return null;
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'));
    if (shouldReEncrypt) await storeSecret(field, result);
    return result;
  } catch {
    return null;
  }
}

async function apiKeySource() {
  if (process.env.ANTHROPIC_API_KEY) return 'env';
  return (await readSecret('encryptedApiKey')) ? 'stored' : null;
}

async function getApiKey() {
  return process.env.ANTHROPIC_API_KEY || (await readSecret('encryptedApiKey'));
}

/** Koneksi ke Claude: { apiKey } langsung, atau { serverUrl, token } lewat server Lensa. */
// Key mode gratis (Groq, OpenRouter), masing-masing disimpan terenkripsi.
const FREE_KEY_FIELDS = { groq: 'encryptedGroqKey', openrouter: 'encryptedOpenrouterKey' };
const FREE_KEY_PREFIX = { groq: 'gsk_', openrouter: 'sk-or-' };
const CONNECTIONS = ['direct', 'free', 'server'];

async function freeKeys() {
  const keys = {};
  for (const [provider, field] of Object.entries(FREE_KEY_FIELDS)) {
    const key = await readSecret(field);
    if (key) keys[provider] = key;
  }
  return keys;
}

async function getConnection() {
  const s = loadSettings();
  if (s.connection === 'free') {
    const keys = await freeKeys();
    if (!Object.keys(keys).length) throw new Error('Isi key Groq atau OpenRouter di Pengaturan.');
    return { free: keys };
  }
  if (s.connection === 'server') {
    const token = await readSecret('encryptedServerToken');
    if (!s.serverUrl || !token) throw new Error('Belum masuk ke server Lensa. Buka Pengaturan untuk masuk.');
    return { serverUrl: s.serverUrl, token };
  }
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('API key belum diatur. Buka Pengaturan untuk memasukkan API key.');
  return { apiKey };
}

function forgetServerSession() {
  saveSettings({ encryptedServerToken: null, serverUser: null });
}

async function publicState() {
  const s = loadSettings();
  return {
    keySource: await apiKeySource(),
    connection: CONNECTIONS.includes(s.connection) ? s.connection : 'direct',
    freeKeys: Object.fromEntries(Object.keys(FREE_KEY_FIELDS).map((p) => [p, !!s[FREE_KEY_FIELDS[p]]])),
    serverUrl: s.serverUrl || '',
    serverUser: s.serverUser || null,
    encryptionAvailable: await safeStorage.isAsyncEncryptionAvailable(),
    model: currentModel(),
    models: MODELS,
    alwaysOnTop: !!s.alwaysOnTop,
    hintMode: !!s.hintMode,
    saveHistory: s.saveHistory !== false,
    shortAnswers: s.shortAnswers !== false,
    clipboardWatch: !!s.clipboardWatch,
    voiceCommand: !!s.voiceCommand,
    busy,
  };
}

// ---------- Status & hasil ke renderer ----------

function sendStatus(state, message = '') {
  if (win && !win.isDestroyed()) win.webContents.send('status', { state, message });
}

function sendHistoryChanged() {
  if (win && !win.isDestroyed()) win.webContents.send('history-changed');
}

function sendResult(result) {
  if (win && !win.isDestroyed()) win.webContents.send('result', result);
}


// ---------- Tangkapan layar ----------

function displayUnderCursor() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

/**
 * Menangkap layar sebuah display; region (opsional) = { x, y, width, height } dalam koordinat DIP display itu.
 * Area dipotong dari tangkapan resolusi penuh supaya teks kecil tetap terbaca, lalu sisi terpanjang
 * diperkecil hingga maks. 1600 px dan dikompres JPEG.
 */
async function captureJpeg(display, region) {
  const fullW = Math.round(display.size.width * display.scaleFactor);
  const fullH = Math.round(display.size.height * display.scaleFactor);
  const scale = region ? 1 : Math.min(1, MAX_IMAGE_SIDE / Math.max(fullW, fullH));
  const thumbnailSize = { width: Math.round(fullW * scale), height: Math.round(fullH * scale) };

  // Jendela dibuat transparan sesaat supaya panel jawaban tidak ikut terfoto
  // dan tidak menutupi soal. Jendela tetap terlihat normal di luar momen ini.
  const fade = win && win.isVisible() && !win.isMinimized();
  if (fade) {
    win.setOpacity(0);
    await delay(150);
  }
  let sources;
  try {
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  } finally {
    if (fade && win && !win.isDestroyed()) win.setOpacity(1);
  }

  const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error(
      process.platform === 'darwin'
        ? 'Layar tidak bisa ditangkap. Beri izin Screen Recording di System Settings > Privacy & Security, lalu buka ulang aplikasi.'
        : 'Layar tidak bisa ditangkap.'
    );
  }
  let image = source.thumbnail;
  if (region) {
    const size = image.getSize();
    const sx = size.width / display.size.width;
    const sy = size.height / display.size.height;
    const x = Math.max(0, Math.round(region.x * sx));
    const y = Math.max(0, Math.round(region.y * sy));
    const crop = {
      x,
      y,
      width: Math.max(1, Math.min(size.width - x, Math.round(region.width * sx))),
      height: Math.max(1, Math.min(size.height - y, Math.round(region.height * sy))),
    };
    image = image.crop(crop);
    const longest = Math.max(crop.width, crop.height);
    if (longest > MAX_IMAGE_SIDE) {
      const k = MAX_IMAGE_SIDE / longest;
      image = image.resize({ width: Math.round(crop.width * k), height: Math.round(crop.height * k), quality: 'good' });
    }
  }
  return image.toJPEG(JPEG_QUALITY);
}

// ---------- Pilih area (seperti snipping tool) ----------

let snip = null; // { win, resolve }

/** Menampilkan lapisan transparan di atas display; mengembalikan area pilihan (DIP) atau null jika batal. */
function selectRegion(display) {
  return new Promise((resolve) => {
    const overlay = new BrowserWindow({
      ...display.bounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(__dirname, 'snip-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setBounds(display.bounds);
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    overlay.on('closed', () => finishSnip(null));
    snip = { win: overlay, resolve };
    overlay.loadFile(path.join(__dirname, 'snip.html'));
  });
}

function finishSnip(rect) {
  if (!snip) return;
  const { win: overlay, resolve } = snip;
  snip = null;
  if (!overlay.isDestroyed()) overlay.close();
  resolve(rect);
}

// ---------- Alur analisis ----------

/**
 * Layar hanya dibaca saat pengguna memintanya: tombol/Ctrl+Shift+A (layar penuh),
 * Ctrl+Shift+S (pilih area), atau teks yang disalin (jika diaktifkan). Tidak ada pembacaan otomatis.
 * getInput mengembalikan { jpegBase64 } atau { text }, atau null jika dibatalkan.
 * Mengembalikan false jika sedang sibuk dan permintaan tidak dijalankan.
 */
async function runAnalysis(busyText, getInput) {
  if (busy) return false;
  busy = true;
  try {
    let conn;
    try {
      conn = await getConnection();
    } catch (err) {
      sendStatus('error', err.message);
      return true;
    }

    const input = await getInput();
    if (!input) {
      sendStatus('idle', '');
      return true;
    }
    const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
    if (wait > 0) {
      sendStatus('busy', 'Sebentar...');
      await delay(wait);
    }

    sendStatus('busy', busyText);
    const s = loadSettings();
    const model = currentModel();
    lastCallAt = Date.now();
    const result = await askClaude({ conn, model, ...input, hintMode: !!s.hintMode, short: s.shortAnswers !== false });

    if (result.kind === 'none') {
      sendStatus('idle', 'Tidak ada soal.');
      return true;
    }
    let historyId = null;
    if (result.kind === 'answer' && result.soal && s.saveHistory !== false) {
      historyId = history.add({ soal: result.soal, topik: result.topik, jawaban: result.text, model }).id;
      sendHistoryChanged();
    }
    const source = input.text !== undefined ? 'salinan' : 'layar';
    sendResult({ ...result, historyId, model, source, time: new Date().toISOString() });
    sendStatus('idle', '');
  } catch (err) {
    sendStatus('error', err.message || String(err));
  } finally {
    busy = false;
  }
  return true;
}

function analyzeScreen() {
  return runAnalysis('Membaca layar...', async () => ({
    jpegBase64: (await captureJpeg(displayUnderCursor())).toString('base64'),
  }));
}

function analyzeRegion() {
  return runAnalysis('Membaca area...', async () => {
    const display = displayUnderCursor();
    const region = await selectRegion(display);
    if (!region) return null;
    await delay(120); // tunggu lapisan pilihan benar-benar hilang dari layar
    return { jpegBase64: (await captureJpeg(display, region)).toString('base64') };
  });
}

// ---------- Teks yang disalin ----------

let clipTimer = null;
let lastClip = '';
let pendingClip = null;

async function analyzeText(text) {
  const started = await runAnalysis('Membaca teks salinan...', async () => ({ text }));
  if (!started) {
    pendingClip = text; // sedang sibuk: proses salinan terakhir setelah selesai
    return;
  }
  if (pendingClip) {
    const next = pendingClip;
    pendingClip = null;
    analyzeText(next);
  }
}

/**
 * Memantau papan klip; hanya teks yang baru disalin (setelah mode aktif) yang ditanggapi.
 * API clipboard Electron bersifat async (Promise).
 */
async function setClipboardWatch(on) {
  clearInterval(clipTimer);
  clipTimer = null;
  pendingClip = null;
  if (!on) return;
  lastClip = await clipboard.readText();
  let reading = false;
  clipTimer = setInterval(async () => {
    if (reading) return;
    reading = true;
    try {
      const text = await clipboard.readText();
      if (text === lastClip) return;
      lastClip = text;
      const trimmed = text.trim();
      if (trimmed.length < 2) return;
      if (trimmed.length > MAX_COPIED_CHARS) {
        sendStatus('error', `Teks salinan terlalu panjang (maks. ${MAX_COPIED_CHARS} karakter).`);
        return;
      }
      analyzeText(trimmed);
    } catch {
      // Papan klip sedang dipakai aplikasi lain; coba lagi di putaran berikutnya.
    } finally {
      reading = false;
    }
  }, 700);
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('get-state', () => publicState());
  ipcMain.handle('analyze', () => analyzeScreen());
  ipcMain.handle('analyze-region', () => analyzeRegion());
  ipcMain.on('snip-done', (e, rect) => {
    if (snip && e.sender === snip.win.webContents) finishSnip(rect);
  });
  // Teks yang disalin lewat tombol "Salin" aplikasi sendiri tidak boleh memicu AI.
  ipcMain.handle('copy-text', (_e, text) => {
    lastClip = String(text);
    return clipboard.writeText(lastClip);
  });
  ipcMain.handle('set-short-answers', (_e, on) => {
    saveSettings({ shortAnswers: !!on });
    return !!on;
  });
  ipcMain.handle('set-voice-command', (_e, on) => {
    saveSettings({ voiceCommand: !!on });
    if (on) voice.start();
    else {
      voice.stop();
      sendStatus('idle', '');
    }
    return !!on;
  });
  // Potongan ucapan pendek dari jendela utama; ditranskripsi lokal oleh worker Whisper.
  ipcMain.on('voice-segment', (e, audio) => {
    if (win && e.sender === win.webContents && audio instanceof Float32Array) voice.transcribe(audio);
  });
  ipcMain.handle('set-clipboard-watch', (_e, on) => {
    saveSettings({ clipboardWatch: !!on });
    setClipboardWatch(!!on);
    return !!on;
  });

  ipcMain.handle('set-always-on-top', (_e, on) => {
    setAlwaysOnTopEnforced(!!on);
    saveSettings({ alwaysOnTop: !!on });
    return !!on;
  });

  ipcMain.handle('set-save-history', (_e, on) => {
    saveSettings({ saveHistory: !!on });
    return !!on;
  });

  ipcMain.handle('history-list', () => history.list());
  ipcMain.handle('history-due', () => ({ items: history.due(), nextDueAt: history.nextDueAt() }));
  ipcMain.handle('history-review', (_e, id, rating) => {
    history.review(id, rating);
    sendHistoryChanged();
  });
  ipcMain.handle('history-delete', (_e, id) => {
    history.remove(id);
    sendHistoryChanged();
  });
  // Soal yang diketik/ditempel langsung di kotak Tanya. false = masih sibuk dengan permintaan lain.
  ipcMain.handle('ask-text', (_e, text) => {
    const trimmed = String(text || '').trim();
    if (!trimmed) return true;
    if (trimmed.length > MAX_COPIED_CHARS) throw new Error(`Teks terlalu panjang (maks. ${MAX_COPIED_CHARS} karakter).`);
    return runAnalysis('Membaca soal...', async () => ({ text: trimmed }));
  });

  ipcMain.handle('practice-generate', async (_e, { kategori, focusTopics }) => {
    const model = currentModel();
    try {
      const conn = await getConnection();
      sendStatus('busy', 'Membuat soal...');
      const questions = await generatePractice({ conn, model, kategori, focusTopics });
      sendStatus('idle', '');
      return questions;
    } catch (err) {
      sendStatus('error', err.message);
      throw err;
    }
  });

  // Jawaban latihan dicatat per soal; jawaban yang kurang tepat masuk riwayat untuk diulas ulang.
  ipcMain.handle('practice-record', (_e, { question, chosen }) => {
    const benar = question.skor[chosen] === Math.max(...question.skor);
    practice.record({ topik: question.topik, benar, skor: question.skor[chosen] });
    if (!benar && loadSettings().saveHistory !== false) {
      const LETTERS = 'ABCDE';
      const soal = [question.soal, ...question.pilihan.map((p, i) => `${LETTERS[i]}. ${p}`)].join('\n');
      const best = question.terbaik;
      const jawaban = `Jawaban: ${LETTERS[best]}. ${question.pilihan[best]}\nPenjelasan: ${question.penjelasan}`;
      history.add({ soal, topik: question.topik, jawaban, model: currentModel() });
      sendHistoryChanged();
    }
    return benar;
  });

  ipcMain.handle('stats-get', () => computeStats(history.list(), practice.list()));
  ipcMain.handle('practice-clear', () => practice.clear());

  ipcMain.handle('history-clear', () => {
    history.clear();
    sendHistoryChanged();
  });

  ipcMain.handle('set-hint-mode', (_e, on) => {
    saveSettings({ hintMode: !!on });
    return !!on;
  });

  ipcMain.handle('set-model', (_e, model) => {
    if (!MODELS[model]) throw new Error('Model tidak dikenal');
    saveSettings({ model });
    return model;
  });

  ipcMain.handle('save-api-key', async (_e, key) => {
    const trimmed = String(key || '').trim();
    if (!trimmed) throw new Error('API key kosong');
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error('Enkripsi sistem tidak tersedia. Gunakan variabel lingkungan ANTHROPIC_API_KEY.');
    }
    await storeSecret('encryptedApiKey', trimmed);
    return publicState();
  });

  ipcMain.handle('save-free-key', async (_e, provider, key) => {
    const field = FREE_KEY_FIELDS[provider];
    const trimmed = String(key || '').trim();
    if (!field) throw new Error('Penyedia tidak dikenal');
    if (!trimmed) throw new Error('Key kosong');
    const prefix = FREE_KEY_PREFIX[provider];
    if (!trimmed.startsWith(prefix)) throw new Error(`Key ${provider === 'groq' ? 'Groq' : 'OpenRouter'} selalu diawali "${prefix}". Periksa lagi key yang ditempel.`);
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Enkripsi sistem tidak tersedia.');
    await storeSecret(field, trimmed);
    return publicState();
  });

  ipcMain.handle('clear-free-key', (_e, provider) => {
    if (FREE_KEY_FIELDS[provider]) saveSettings({ [FREE_KEY_FIELDS[provider]]: null });
    return publicState();
  });

  ipcMain.handle('clear-api-key', () => {
    saveSettings({ encryptedApiKey: null });
    return publicState();
  });

  // ---------- Server Lensa (butir 4) ----------

  ipcMain.handle('set-connection', (_e, mode) => {
    saveSettings({ connection: CONNECTIONS.includes(mode) ? mode : 'direct' });
    return publicState();
  });

  // method: 'login' | 'register' | 'siparakai'
  ipcMain.handle('server-auth', async (_e, { method, serverUrl, email, password, name, tenant }) => {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error('Enkripsi sistem tidak tersedia, token sesi tidak bisa disimpan dengan aman.');
    }
    const url = normalizeServerUrl(serverUrl);
    const fields = method === 'siparakai' ? { tenant, email, password } : { email, password, name };
    const data = await serverAuthenticate(url, method, fields);
    await storeSecret('encryptedServerToken', data.token);
    saveSettings({ serverUrl: url, serverUser: data.user, connection: 'server' });
    return { state: await publicState(), quota: data.quota };
  });

  // Profil + sisa kuota; sesi yang sudah tidak berlaku dilupakan.
  ipcMain.handle('server-profile', async () => {
    const { serverUrl } = loadSettings();
    const token = await readSecret('encryptedServerToken');
    if (!serverUrl || !token) return null;
    try {
      return await serverProfile(serverUrl, token);
    } catch (err) {
      if (err.status === 401) forgetServerSession();
      throw err;
    }
  });

  ipcMain.handle('server-logout', async () => {
    const { serverUrl } = loadSettings();
    const token = await readSecret('encryptedServerToken');
    if (serverUrl && token) await serverLogout(serverUrl, token);
    forgetServerSession();
    return publicState();
  });
}

// ---------- Jendela ----------

function setAlwaysOnTopEnforced(on) {
  if (topEnforcer) { clearInterval(topEnforcer); topEnforcer = null; }
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(!!on, 'screen-saver');
  if (!on) return;
  // Penegasan lembut: sebagian app menimpa status topmost. Pasang ulang tiap detik,
  // tapi hormati minimize pengguna (tidak memaksa tampil/restore).
  topEnforcer = setInterval(() => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver');
  }, 1000);
}

function createWindow() {
  const s = loadSettings();
  win = new BrowserWindow({
    width: 460,
    height: 680,
    minWidth: 360,
    minHeight: 420,
    title: APP_TITLE,
    autoHideMenuBar: true,
    alwaysOnTop: !!s.alwaysOnTop ? 'screen-saver' : false,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  if (s.alwaysOnTop) win.once('ready-to-show', () => setAlwaysOnTopEnforced(true));
}

app.whenReady().then(() => {
  // Satu-satunya izin: mikrofon (audio saja) untuk jendela utama, dipakai perintah suara "baca".
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => {
    const audioOnly = Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every((t) => t === 'audio');
    cb(perm === 'media' && audioOnly && win !== null && wc === win.webContents && !!loadSettings().voiceCommand);
  });
  history = new HistoryStore(path.join(app.getPath('userData'), 'history.json'));
  practice = new PracticeStore(path.join(app.getPath('userData'), 'practice.json'));
  voice = new VoiceController({
    cacheDir: path.join(app.getPath('userData'), 'models'),
    onStatus: sendStatus,
    onListening: (on) => win && !win.isDestroyed() && win.webContents.send('voice-listen', on),
    onCommand: () => analyzeScreen(),
  });
  // Catat PID dan jalankan watchdog agar Lensa otomatis dibuka kembali jika dikill
  lensaPidFile  = path.join(app.getPath('userData'), 'lensa.pid');
  lensaQuitFile = path.join(app.getPath('userData'), 'lensa.quit');
  try { fs.unlinkSync(lensaQuitFile); } catch {}
  fs.writeFileSync(lensaPidFile, String(process.pid));
  const wdPidFile = path.join(app.getPath('userData'), 'watchdog.pid');
  let wdAlive = false;
  try {
    const wdPid = parseInt(fs.readFileSync(wdPidFile, 'utf8'), 10);
    try { process.kill(wdPid, 0); wdAlive = true; } catch {}
  } catch {}
  if (!wdAlive) {
    const wd = spawn(process.execPath, [path.join(__dirname, 'watchdog.js'), app.getPath('userData')], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    wd.unref();
    try { fs.writeFileSync(wdPidFile, String(wd.pid)); } catch {}
  }

  registerIpc();
  createWindow();

  // Tray: Lensa tetap hidup di background saat jendela ditutup paksa
  const iconPath = path.join(__dirname, 'tray-icon.png');
  const trayImg = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(trayImg);
  tray.setToolTip('Lensa Belajar — Ctrl+Shift+L');
  const showWin = () => {
    if (!win || win.isDestroyed()) createWindow();
    win.show();
    win.focus();
  };
  tray.on('click', showWin);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Buka Lensa', click: showWin },
    { type: 'separator' },
    { label: 'Keluar', click: () => { isQuitting = true; app.quit(); } },
  ]));

  if (loadSettings().voiceCommand) win.webContents.once('did-finish-load', () => voice.start());

  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    win.webContents.once('did-finish-load', () =>
      sendStatus('error', 'macOS: izinkan Screen Recording untuk aplikasi ini agar layar bisa dibaca.')
    );
  }

  // Ctrl+Shift+L: panggil / sembunyikan Lensa dari mana saja
  globalShortcut.register('Control+Shift+L', () => {
    if (!win || win.isDestroyed()) { createWindow(); return; }
    if (win.isVisible() && win.isFocused()) { win.hide(); } else { win.show(); win.focus(); }
  });

  const busyKeys = [
    [SHORTCUT_SCREEN, analyzeScreen, 'Ctrl+Shift+A'],
    [SHORTCUT_REGION, analyzeRegion, 'Ctrl+Shift+S'],
  ]
    .filter(([key, action]) => !globalShortcut.register(key, action))
    .map(([, , label]) => label);
  if (busyKeys.length) {
    win.webContents.once('did-finish-load', () =>
      sendStatus('error', `Tombol pintas ${busyKeys.join(' dan ')} dipakai aplikasi lain. Gunakan tombol di jendela.`)
    );
  }
  if (loadSettings().clipboardWatch) setClipboardWatch(true);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  if (lensaQuitFile) try { fs.writeFileSync(lensaQuitFile, '1'); } catch {}
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  voice?.stop();
});

// Jangan quit saat jendela ditutup — tray menjaga proses tetap hidup.
app.on('window-all-closed', () => { /* tray handles this */ });
