# Lensa Belajar

Aplikasi desktop Windows untuk membantu belajar: ambil tangkapan layar soal → AI jelaskan jawabannya. Dibangun dengan Electron.

---

## Fitur

| Fitur | Keterangan |
|---|---|
| **Baca layar penuh** | Tangkap seluruh layar, kirim ke AI untuk dijelaskan |
| **Pilih wilayah** | Seret area tertentu di layar yang ingin dianalisis |
| **Tanya teks** | Ketik atau tempel soal langsung di kotak tanya |
| **Pemantau clipboard** | Secara otomatis menganalisis teks yang disalin |
| **Perintah suara** | Ucapkan "baca" untuk memulai analisis (transkripsi lokal via Whisper) |
| **Mode latihan** | Generate soal latihan per kategori, rekam jawaban, lihat statistik |
| **Riwayat + SRS** | Jawaban tersimpan; soal yang salah dijadwalkan ulang (Spaced Repetition) |
| **Multi-model** | Claude (Anthropic), Groq, OpenRouter — bisa pakai akun gratis |
| **Server mode** | Sambungkan ke server Lensa bersama (tanpa API key sendiri) |
| **Selalu di atas** | Jendela tetap tampil di atas semua aplikasi lain |

---

## Cara Mulai

### 1. Jalankan langsung (tanpa build)

```
Mulai Lensa.bat
```

Atau via terminal:

```
node_modules\electron\dist\electron.exe .
```

### 2. Jalankan dari hasil build (`.exe` mandiri)

```
dist\win-unpacked\Lensa Belajar.exe
```

> File ini yang perlu didaftarkan di whitelist SEB (Safe Exam Browser) agar Lensa bisa dibuka bersamaan.

---

## Pintasan Keyboard

| Pintasan | Fungsi |
|---|---|
| `Ctrl+Shift+A` | Baca layar penuh → AI jelaskan |
| `Ctrl+Shift+S` | Pilih wilayah layar → AI jelaskan |
| `Ctrl+Shift+L` | Sembunyikan / tampilkan jendela Lensa |

---

## Pengaturan API Key

Lensa mendukung tiga sumber AI:

### Claude (Anthropic) — paling akurat
1. Buka **Pengaturan** di dalam app
2. Tempel API key dari [console.anthropic.com](https://console.anthropic.com)
3. Key tersimpan terenkripsi di perangkat (tidak dikirim ke mana pun selain Anthropic)

### Groq / OpenRouter — gratis
1. Buka **Pengaturan → Mode Gratis**
2. Masukkan key Groq (awalan `gsk_`) atau OpenRouter (awalan `sk-or-`)
3. Lensa mencoba model satu per satu secara otomatis jika kuota habis

### Server bersama
1. Buka **Pengaturan → Sambung Server**
2. Masukkan URL server dan akun — tidak perlu API key sendiri

---

## Build Mandiri

Untuk menghasilkan file `.exe` yang bisa dijalankan tanpa Node.js:

```bash
npm install
npm run build
```

Output: `dist\win-unpacked\Lensa Belajar.exe`

Syarat:
- Node.js 18+
- `npm install` sudah dijalankan

---

## Struktur File Penting

```
desktop/
├── main.js            # Proses utama Electron
├── renderer.js        # Logika UI
├── index.html         # Tampilan utama
├── preload.js         # Jembatan IPC aman
├── claude.js          # Integrasi Claude API
├── providers.js       # Groq / OpenRouter fallback
├── voice.js           # Perintah suara (Whisper lokal)
├── history.js         # Riwayat + Spaced Repetition
├── practice.js        # Soal latihan & statistik
├── server-client.js   # Koneksi server bersama
├── snip.js/html       # Tool pilih wilayah layar
├── Mulai Lensa.bat    # Launcher cepat
└── dist/win-unpacked/ # Hasil build .exe
```

---

## Catatan

- Tangkapan layar **tidak disimpan ke disk** — hanya dikirim ke AI lalu dibuang dari memori.
- API key disimpan terenkripsi menggunakan `safeStorage` bawaan Electron (enkripsi OS).
- Untuk penggunaan bersama SEB: daftarkan `dist\win-unpacked\Lensa Belajar.exe` di konfigurasi *Allowed Executables* SEB.
