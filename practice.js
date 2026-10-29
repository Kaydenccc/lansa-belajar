'use strict';

// Hasil latihan + statistik kelemahan per topik (gabungan latihan dan ulasan ulang).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_ATTEMPTS = 2000;
const CATEGORIES = ['TWK', 'TIU', 'TKP'];
const WEAK_THRESHOLD = 0.7; // tingkat benar di bawah ini dianggap lemah
const WEAK_MIN_DATA = 2; // minimal jumlah jawaban sebelum sebuah topik dinilai

const topicKey = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim();

function categoryOf(topik) {
  const prefix = String(topik).split('-')[0].trim().toUpperCase();
  return CATEGORIES.includes(prefix) ? prefix : 'Lainnya';
}

class PracticeStore {
  constructor(filePath, now = Date.now) {
    this.filePath = filePath;
    this.now = now;
    this.attempts = null;
  }

  load() {
    if (this.attempts) return this.attempts;
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.attempts = Array.isArray(data.attempts) ? data.attempts : [];
    } catch {
      this.attempts = [];
    }
    return this.attempts;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, attempts: this.attempts }));
    fs.renameSync(tmp, this.filePath);
  }

  record({ topik, benar, skor }) {
    const attempts = this.load();
    const attempt = { id: crypto.randomUUID(), at: this.now(), topik, kategori: categoryOf(topik), benar: !!benar, skor };
    attempts.push(attempt);
    if (attempts.length > MAX_ATTEMPTS) attempts.splice(0, attempts.length - MAX_ATTEMPTS);
    this.save();
    return attempt;
  }

  list() {
    return [...this.load()];
  }

  clear() {
    this.attempts = [];
    this.save();
  }
}

function emptyRow(topik) {
  return { topik, kategori: categoryOf(topik), latihan: 0, benar: 0, ulasan: 0, lupa: 0, tersimpan: 0 };
}

function finalize(row) {
  const total = row.latihan + row.ulasan;
  const salah = row.latihan - row.benar + row.lupa;
  return { ...row, total, salah, akurasi: total ? (total - salah) / total : null };
}

/**
 * Statistik per topik dan per kategori.
 * Latihan: benar/salah per jawaban. Ulasan ulang: setiap ulasan dihitung, "Lupa" dihitung salah.
 */
function computeStats(historyItems, attempts) {
  const rows = new Map();
  const row = (topik) => {
    const key = topicKey(topik || 'Tanpa topik');
    if (!rows.has(key)) rows.set(key, emptyRow(topik || 'Tanpa topik'));
    return rows.get(key);
  };
  for (const a of attempts) {
    const r = row(a.topik);
    r.latihan += 1;
    if (a.benar) r.benar += 1;
  }
  for (const h of historyItems) {
    const r = row(h.topik);
    r.tersimpan += 1;
    r.ulasan += h.reviews || 0;
    r.lupa += h.lapses || 0;
  }

  const topics = [...rows.values()].map(finalize).sort((a, b) => {
    if (a.akurasi === null || b.akurasi === null) return (a.akurasi === null) - (b.akurasi === null);
    return a.akurasi - b.akurasi || b.total - a.total;
  });

  const categories = [...CATEGORIES, 'Lainnya']
    .map((kategori) => {
      const sum = emptyRow(kategori);
      sum.kategori = kategori;
      for (const t of topics.filter((x) => x.kategori === kategori)) {
        for (const f of ['latihan', 'benar', 'ulasan', 'lupa', 'tersimpan']) sum[f] += t[f];
      }
      return finalize(sum);
    })
    .filter((c) => c.total > 0 || c.tersimpan > 0);

  const weak = topics.filter((t) => t.total >= WEAK_MIN_DATA && t.akurasi < WEAK_THRESHOLD).slice(0, 3);
  return { topics, categories, weak };
}

module.exports = { PracticeStore, computeStats, categoryOf, WEAK_THRESHOLD };
