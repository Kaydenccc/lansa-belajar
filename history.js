'use strict';

// Riwayat soal + ulasan ulang (sistem kotak Leitner). Hanya teks yang disimpan, tidak ada gambar.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DAY_MS = 24 * 60 * 60 * 1000;
const RELEARN_MS = 10 * 60 * 1000; // "Lupa": muncul lagi 10 menit kemudian
const INTERVAL_DAYS = [1, 2, 4, 8, 16, 32]; // jarak ulasan per kotak
const MAX_ITEMS = 500;
const RATINGS = ['lupa', 'ragu', 'ingat'];

const normalize = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

// Jadwal berikutnya untuk sebuah penilaian, tanpa mengubah item.
function schedule(item, rating, now) {
  if (!RATINGS.includes(rating)) throw new Error(`Penilaian tidak dikenal: ${rating}`);
  if (rating === 'lupa') return { box: 0, due: now + RELEARN_MS, lapses: item.lapses + 1 };
  const box = rating === 'ingat' ? Math.min(item.box + 1, INTERVAL_DAYS.length - 1) : item.box;
  return { box, due: now + INTERVAL_DAYS[box] * DAY_MS, lapses: item.lapses };
}

function intervalLabel(ms) {
  if (ms < DAY_MS) return `${Math.round(ms / 60000)} menit`;
  return `${Math.round(ms / DAY_MS)} hari`;
}

// Label jarak tiap tombol penilaian, mis. { lupa: '10 menit', ragu: '1 hari', ingat: '2 hari' }.
function previewLabels(item, now) {
  return Object.fromEntries(RATINGS.map((r) => [r, intervalLabel(schedule(item, r, now).due - now)]));
}

class HistoryStore {
  constructor(filePath, now = Date.now) {
    this.filePath = filePath;
    this.now = now;
    this.items = null;
  }

  load() {
    if (this.items) return this.items;
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.items = Array.isArray(data.items) ? data.items : [];
    } catch {
      this.items = [];
    }
    return this.items;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: this.items }, null, 1));
    fs.renameSync(tmp, this.filePath);
  }

  // Soal yang sama (setelah normalisasi spasi/huruf) memperbarui item lama tanpa mengubah jadwalnya.
  add({ soal, topik, jawaban, model }) {
    const items = this.load();
    const now = this.now();
    const key = normalize(soal);
    let item = items.find((it) => normalize(it.soal) === key);
    if (item) {
      Object.assign(item, { topik, jawaban, model, updatedAt: now });
    } else {
      item = {
        id: crypto.randomUUID(),
        soal,
        topik,
        jawaban,
        model,
        createdAt: now,
        updatedAt: now,
        box: 0,
        due: now + INTERVAL_DAYS[0] * DAY_MS,
        reviews: 0,
        lapses: 0,
        lastReviewed: null,
      };
      items.push(item);
      if (items.length > MAX_ITEMS) {
        items.sort((a, b) => a.createdAt - b.createdAt);
        items.splice(0, items.length - MAX_ITEMS);
      }
    }
    this.save();
    return item;
  }

  list() {
    return [...this.load()].sort((a, b) => b.createdAt - a.createdAt);
  }

  due() {
    const now = this.now();
    return this.load()
      .filter((it) => it.due <= now)
      .sort((a, b) => a.due - b.due)
      .map((it) => ({ ...it, preview: previewLabels(it, now) }));
  }

  // Waktu ulasan terdekat yang belum jatuh tempo (null jika tidak ada).
  nextDueAt() {
    const now = this.now();
    const upcoming = this.load().filter((it) => it.due > now).map((it) => it.due);
    return upcoming.length ? Math.min(...upcoming) : null;
  }

  review(id, rating) {
    const item = this.load().find((it) => it.id === id);
    if (!item) throw new Error('Soal tidak ditemukan di riwayat');
    const now = this.now();
    Object.assign(item, schedule(item, rating, now), { reviews: item.reviews + 1, lastReviewed: now });
    this.save();
    return item;
  }

  remove(id) {
    this.items = this.load().filter((it) => it.id !== id);
    this.save();
  }

  clear() {
    this.items = [];
    this.save();
  }
}

module.exports = { HistoryStore, schedule, previewLabels, intervalLabel, INTERVAL_DAYS, DAY_MS, RELEARN_MS };
