'use strict';

/**
 * Perintah suara pemicu pembacaan layar: ucapan pendek (maks. 3 kata) yang mengandung kata "baca"
 * atau "bacakan", mis. "baca", "baca soal", "tolong baca". Kalimat percakapan yang kebetulan
 * mengandung "baca" (mis. "aku baca buku dulu ya") sengaja diabaikan supaya kuota tidak terbuang.
 * Aturan sama dengan versi Android (VoiceCommand.kt).
 */
const MAX_WORDS = 3;
const TRIGGERS = new Set(['baca', 'bacakan']);

function matchesCommand(text) {
  const words = String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return words.length >= 1 && words.length <= MAX_WORDS && words.some((w) => TRIGGERS.has(w));
}

module.exports = { matchesCommand };
