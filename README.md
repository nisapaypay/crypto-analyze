# Crypto Analyst — Indodax

Analis pasar kripto pribadi berbasis Telegram untuk Indodax. Spesifikasi lengkap ada di [docs/PRD.md](docs/PRD.md).

> **Analisis saja.** Aplikasi ini tidak mengeksekusi order, tidak membatalkan order, dan tidak memindahkan dana.
> Hanya memakai Indodax **Public API**; `INDODAX_API_KEY` dan `INDODAX_SECRET_KEY` tidak dipakai dan harus dibiarkan kosong.
> Semua transaksi dilakukan manual oleh pengguna di aplikasi Indodax.

## Status

| Milestone | Cakupan | Status |
|---|---|---|
| 1 — Foundation | TypeScript, Telegram bot, PostgreSQL/Prisma, validasi env, audit log | ✅ |
| 2 — Market Data | Indodax Public REST, watchlist, candle, order book, deteksi data basi (WebSocket ditunda setelah M5) | ✅ |
| 3 — Technical Analysis | EMA, RSI, ATR, volume ratio, imbalance, support/resistance (15m + konfirmasi 1j) | ✅ |
| 4 — Strategy & Risk | BUY / EARLY WARNING / WAIT / NO TRADE, regime, sizing, SL/TP, biaya, risk ledger, backtest | ✅ (menunggu review) |
| 5 — Agent & Scheduler | Claude, BullMQ, scan dinamis, notifikasi | ⏳ |
| 6 — Trading Journal | `/bought`, `/sold`, `/positions`, `/history`, `/report` | ⏳ |
| 7 — Paper Trading | Evaluasi performa sinyal | ⏳ |

## Prasyarat

Aplikasi berjalan **lokal di Mac** (Apple Silicon). Tidak butuh VPS, domain, SSL, atau webhook: bot memakai Telegram **long polling** (koneksi keluar saja).

- Node.js ≥ 22.12 dan pnpm 9
- PostgreSQL 17 lokal (Homebrew atau Postgres.app)
- Bot Telegram (token dari [@BotFather](https://t.me/BotFather)) dan user ID Telegram Anda ([@userinfobot](https://t.me/userinfobot))

## Setup lokal

```bash
pnpm install
cp .env.example .env          # lalu isi TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID, DATABASE_URL
pnpm db:migrate               # buat/terapkan migrasi + generate Prisma Client (tidak menghapus data)
pnpm db:seed                  # user, pengaturan default, watchlist awal (QNT, DOGE, XRP, LINK)
```

## Menjalankan & menghentikan

```bash
pnpm dev                      # mode development: auto-reload saat file berubah
# atau
pnpm build && pnpm start      # mode produksi lokal
```

Hentikan dengan **Ctrl+C** di Terminal yang sama. Aplikasi berhenti polling, menutup koneksi database, lalu keluar. Jika ada koneksi yang macet, aplikasi keluar paksa setelah 10 detik.

Jalankan **hanya satu instance** per token bot. Dua proses polling dengan token yang sama membuat Telegram menolak salah satunya (error 409 Conflict). Cek proses yang masih berjalan dengan `pgrep -fl "src/main.ts|dist/main.js"`.

Pesan yang dikirim saat bot mati diabaikan ketika bot start kembali (`drop_pending_updates`), supaya perintah lama tidak dieksekusi tiba-tiba.

Lalu kirim `/start` dan `/status` ke bot Anda di Telegram.

## Perintah

| Perintah | Kegunaan |
|---|---|
| `pnpm dev` | Jalankan bot dengan auto-reload |
| `pnpm build` / `pnpm start` | Build dan jalankan versi produksi |
| `pnpm typecheck` | Pemeriksaan tipe TypeScript (strict) |
| `pnpm lint` | ESLint |
| `pnpm test` | Semua tes (unit + integration jika `TEST_DATABASE_URL` diisi) |
| `pnpm db:migrate` | Buat/terapkan migrasi (development) |
| `pnpm db:deploy` | Terapkan migrasi (produksi) |
| `pnpm db:seed` | Isi data default |
| `pnpm db:test:prepare` | Terapkan migrasi ke `TEST_DATABASE_URL` |
| `pnpm market:check` | Ambil & validasi data pasar sungguhan dari Indodax untuk watchlist default (simpan ke DB). Tambahkan nama koin (`pnpm market:check sol btc`) atau `--no-save` |
| `pnpm exec tsx scripts/record-fixtures.ts` | Rekam ulang response Indodax asli untuk fixture tes |
| `pnpm analysis:check` | Hitung indikator dari data Indodax sungguhan dan tampilkan persis seperti `/analyze` (`--no-save`, atau nama koin) |
| `pnpm exec tsx scripts/record-analysis-fixtures.ts` | Bekukan ulang 300 candle final 15m dan 1j (QNT, DOGE, XRP, LINK) untuk tes golden |
| `pnpm exec tsx scripts/update-golden.ts` | Regenerasi nilai golden setelah perubahan engine yang disengaja (naikkan `engineVersion`) |
| `pnpm strategy:check` | Jalankan strategi pada data Indodax sungguhan dan tampilkan persis seperti `/scan` + bagian STRATEGI. Default **tidak mencatat sinyal** (agar tidak memakai jatah 3 rekomendasi/hari); `--save-signals` untuk mencatat, `--no-db` tanpa database |
| `pnpm settings:costs` | Lihat/ubah asumsi biaya (`--buy-fee`, `--sell-fee`, `--buy-tax`, `--sell-tax`, `--stop-slippage`, `--verified`, `--reset`). Tidak bisa mengubah modal atau batas risiko |
| `pnpm backtest:fetch` | Unduh candle final 15m dan 1j (12 bulan + 20 hari pemanasan) ke `data/backtest/` (tidak menyentuh database) |
| `pnpm backtest` | Backtest walk-forward + holdout terkunci; `--skip-holdout` untuk tidak melihat holdout |

## Perintah Telegram

| Perintah | Kegunaan |
|---|---|
| `/start`, `/help`, `/status` | Info bot, daftar perintah, status sistem |
| `/watchlist` | Watchlist dengan harga, bid/ask, spread (Rp & %), imbalance ±1%/±2%, candle 15m, status data, dan ringkasan indikator |
| `/analyze <koin>` | Analisis teknikal detail (EMA, RSI, ATR, volume, order book, S/R) + pesan kedua **STRATEGI**: keputusan, regime, syarat G1–G12 ✅/❌, rencana trade bila BUY |
| `/scan` | Scan watchlist: keputusan per koin dan maksimal **satu** kandidat utama, ditambah pemakaian risiko hari ini dan asumsi biaya |
| `/risk` | Konfigurasi risiko (baca saja) dan tiga pembukuan harian: jumlah rekomendasi, risiko terencana, rugi terealisasi |
| `/addcoin <koin>` | Tambah pair IDR (contoh `/addcoin sol`, `/addcoin SOL/IDR`). Pair harus ada dan aktif di Indodax; maksimal 10 pair |
| `/removecoin <koin>` | Hapus pair dari watchlist (data candle tetap disimpan) |

## Market data & kualitas data

Data diambil saat diminta (`/watchlist`, `market:check`) dan di-cache 30 detik. Scan otomatis baru ada di Milestone 5.

Setiap pair diberi status kualitas data, yang menjadi gerbang analisis (`canProduceBuySignal`):

| Status | Arti |
|---|---|
| **OK** | Data valid |
| **DEGRADED** | Data valid dengan peringatan (likuiditas rendah, tidak ada trade terbaru, kedalaman order book terpotong) |
| **UNAVAILABLE** | Tidak boleh menghasilkan BUY: pair tidak ada / maintenance / suspend, ticker basi (> 90 dtk), order book basi (> 60 dtk) / kosong / crossed, candle final < 150, candle tertinggal, ada gap/duplikat, atau gagal fetch |

Aturan penting:
- Hanya candle **final** yang disimpan dan dipakai: candle dianggap final 90 detik setelah tutup, karena Cloudflare men-cache OHLC hingga 60 detik.
- Candle volume 0 (periode tanpa transaksi, diisi Indodax) tetap disimpan dan dihitung untuk peringatan likuiditas (> 30% dari 20 candle terakhir).
- Harga dan volume diparse lossless dari JSON dan dihitung dengan `decimal.js`. Nilai dengan lebih dari 12 desimal ditolak alih-alih dibulatkan diam-diam oleh PostgreSQL.
- Rate limit aplikasi: 120 request/menit, maksimal 2 request bersamaan, timeout 10 detik, retry 3× (1 s, 2 s, 4 s) hanya untuk 429/5xx/jaringan.

## Analisis teknikal (Milestone 3)

Indikator dihitung sendiri dengan `decimal.js` (presisi 50 digit), **hanya dari candle final**, pada 300 candle terakhir. Timeframe utama 15m; tren dikonfirmasi dengan candle final 1j (Indodax `tf=60`, tidak diagregasi dari 15m). Engine menolak candle yang belum final (`NonFinalCandleError`).

| Indikator | Rumus | Catatan candle volume 0 |
|---|---|---|
| EMA 9/20/50 | seed SMA, α = 2/(N+1) | Dipakai (harga terakhir yang dibawa); EMA tetap berbasis waktu |
| RSI 14 | Wilder; AL=0 → 100, tanpa pergerakan → null | Δ=0 tidak mengubah nilai RSI |
| ATR 14 | Wilder; TR candle pertama = H−L | TR=0 mengecilkan ATR → ada juga ATR candle bertransaksi |
| Volume MA20 & rasio | volume candle final terakhir / SMA 20 candle sebelumnya | Nol dihitung; rasio "kurang andal" bila > 30% volume 0 |
| Imbalance ±1%/±2% | (bid − ask)/(bid + ask) dalam IDR | Ambang ±0,20; dibandingkan dengan arus trade 60m |
| Support/resistance | pivot fractal k=3, zona toleransi 0,5 × ATR | Candle volume 0 tidak pernah menjadi pivot |

- Setiap indikator punya status keandalan sendiri (`andal` / `kurang_andal` / `tidak_tersedia`) beserta alasannya. Data OK tidak otomatis berarti semua indikator andal.
- Data UNAVAILABLE → indikator tidak dihitung. DEGRADED → dihitung dengan peringatan.
- Zona S/R menampilkan jumlah sentuhan, jarak (% dan ATR), waktu pivot terakhir, dan status "baru terkonfirmasi" (≤ 12 candle) atau "zona lama".
- Output hanya kondisi indikator — **tidak ada BUY/SELL/WAIT**. RSI 100 bukan sinyal beli; RSI rendah bukan otomatis kesempatan beli.
- Hasil disimpan di `indicator_snapshots` (satu baris per pair, timeframe, candle final terakhir, dan versi engine), tertaut ke `market_snapshots`.
- Pengujian: contoh hitung manual, oracle `technicalindicators` (dev dependency saja), golden file dari riwayat Indodax yang dibekukan, property test, tes candle volume 0, validasi candle final, gerbang kualitas, integrasi PostgreSQL, dan Telegram.

## Strategi & risiko (Milestone 4)

Engine deterministik (fungsi murni) yang hanya menghasilkan **rekomendasi**. Tidak ada eksekusi order, tidak ada Private API, spot saja tanpa leverage.

Urutan keputusan:
1. **DATA_UNAVAILABLE** — data UNAVAILABLE. Rencana trade bahkan tidak dihitung.
2. **NO_TRADE** — pair maintenance/suspend; batas 3 rekomendasi/hari; sisa risiko terencana harian < 50% risiko per trade; spread > 1%; atau setup lengkap tetapi gagal minimum order/likuiditas.
3. **BUY_CANDIDATE** — semua syarat G1–G12 lulus dan regime BULLISH terkonfirmasi 1j.
4. **EARLY_WARNING** — setup lengkap yang tertahan pembatasan, atau ≥ 2 sinyal awal (persilangan EMA, RSI pulih, volume naik, dekat zona). Bukan BUY.
5. **WAIT** — selain itu, dengan alasan syarat yang gagal.

| Syarat | Aturan default |
|---|---|
| G1 | Data OK. DEGRADED → maksimal EARLY_WARNING |
| G2 | Regime BULLISH terkonfirmasi 1j (SIDEWAYS → maks EARLY_WARNING; BEARISH/HIGH_VOLATILITY → WAIT) |
| G3–G5 | EMA9 > EMA20 dan close > EMA20 (15m) · kemiringan EMA20 ≥ 0 dan candle terakhir tidak turun > 1 ATR · RSI 50–70 |
| G6–G8 | Rasio volume ≥ 1,2 · spread ≤ 0,4% dan ≤ 0,5 ATR · imbalance ±1% > −0,20 dan beli trade 60m ≥ 40% |
| G9–G10 | ≤ 1,5 ATR di atas EMA20 · ATR% ≥ biaya bolak-balik (fee + pajak + slippage) |
| G11 | SL/TP/sizing valid, **R/R bersih ≥ 1,5** setelah fee, pajak, dan slippage |
| G12 | Tidak ada rekomendasi lain yang masih berlaku/mungkin terisi, batas harian, jam aktif 09:00–22:00 WIB |

Indikator yang kurang andal (EMA, RSI, rasio volume) atau tanpa konfirmasi 1j juga membatasi keputusan ke EARLY_WARNING.

**Rencana trade** (dibulatkan ke tick pair):
- Entry: `min(best ask, close + 0,25 ATR)` sampai `−0,25 ATR`. ATR efektif = `max(ATR14, ATR candle bertransaksi)`.
- SL: yang lebih jauh antara support − 0,25 ATR dan entry − 1,5 ATR. Minimum `max(1 ATR, 3× spread, 5 tick)`, maksimum 3 ATR.
- TP: `min(resistance − 0,1 ATR, entry + 3R)`.
- Jumlah koin: `floor(min(risk budget / rugi per koin, 50% modal, 50% kedalaman ask ±1%, 1% volume IDR 24j))`. Rugi per koin sudah termasuk fee, pajak, dan slippage, sehingga rugi bersih ≤ Rp25.000 **dalam kondisi normal**. Gap, likuiditas tipis, atau stop yang tidak terisi bisa membuat rugi aktual lebih besar.
- Berlaku 2 candle 15m.

**Biaya**: fee beli, fee jual, pajak beli, pajak jual, dan slippage (entry/SL/TP) adalah parameter terpisah di `user_settings`. Defaultnya 0,20% + 0,11% per sisi, dengan pajak **belum terverifikasi**. Asumsi biaya ditampilkan di setiap rekomendasi.

**Risk ledger** — tiga pembukuan terpisah:

| Pembukuan | M4 |
|---|---|
| Jumlah rekomendasi hari ini (dieksekusi atau tidak) | Ditegakkan (maks 3) |
| Risiko terencana (reservasi rugi bersih rekomendasi) | Ditegakkan (maks Rp75.000) |
| Rugi terealisasi | **Belum tersedia** (jurnal Milestone 6). Batas rugi aktual harian belum dapat ditegakkan |

- Sistem tidak pernah menganggap rekomendasi dieksekusi (`execution_status = UNKNOWN`).
- Siklus hidup rekomendasi dibaca dari data pasar: `ACTIVE` → `EXPIRED_UNFILLED` (reservasi dilepas) atau `POSSIBLY_FILLED` → `HYPO_CLOSED` (hasil hipotetis, bukan P/L Anda).
- Reservasi adalah sifat sinyal, sehingga tidak pernah dihitung dua kali saat status berubah.

**Backtest** (`pnpm backtest`):
- Memakai kode engine live yang sama, tanpa look-ahead.
- Bulan 1–9: walk-forward (latih 4 → uji 1) dengan grid kecil 8 kombinasi.
- Bulan 10–12: holdout yang secara fisik disembunyikan sampai parameter final dipilih, dan dikunci dengan `data/backtest/holdout-lock.json`.
- Fill bersifat estimasi. Order book dan spread historis tidak tersedia.
- Laporan tidak pernah menyimpulkan strategi profitable.

## Testing

```bash
pnpm test
```

Integration test (`tests/integration`) memakai PostgreSQL sungguhan dan otomatis dilewati jika `TEST_DATABASE_URL` kosong. Untuk menjalankannya:

```bash
createdb crypto_analyst_test
# isi TEST_DATABASE_URL di .env, contoh: postgresql://user@localhost:5432/crypto_analyst_test
pnpm db:test:prepare
pnpm test
```

`tests/security/no-trading.test.ts` gagal jika kode sumber memuat endpoint Private/Trade API, penandatanganan request (HMAC), fungsi order/withdraw, atau membaca kredensial Indodax.

## Docker Compose (opsional, belum diuji)

Tidak diperlukan untuk penggunaan lokal. `docker-compose.yml` dan `Dockerfile` disediakan sebagai alternatif bila Docker Desktop terpasang. File ini **belum diuji** karena Docker tidak tersedia di mesin development.

```bash
docker compose up -d postgres         # hanya PostgreSQL (port host 5433)
docker compose up -d --build          # atau sekaligus aplikasinya
```

## Struktur

```text
src/
├── app/
│   ├── audit/        Audit log terstruktur
│   ├── config/       Validasi env (Zod) & nilai default
│   ├── database/     Prisma client & seed
│   ├── health/       Health check komponen
│   └── logger/       Pino + penyaringan secret
├── bot/
│   ├── commands/     Daftar perintah
│   ├── messages/     Format pesan Telegram
│   ├── middleware/   Otorisasi user
│   └── bot.ts
├── exchange/indodax/ Adapter Public REST API (GET saja, path di-whitelist), rate limiter, parser JSON lossless
├── market/           Pair registry, candle, order book, aktivitas trade, validator kualitas data, repository, service
├── indicators/       Fungsi indikator murni (EMA, RSI, ATR, volume, support/resistance, tekanan order book)
├── analysis/         Engine analisis, interpretasi, keandalan, penyimpanan indicator snapshot
├── risk/             Biaya, tick, entry range, SL, TP, position sizing, slippage, P/L, risk ledger (Decimal saja)
├── strategy/         Regime, syarat G1–G12, early warning, rencana trade, engine keputusan, ranking, lifecycle, sinyal, service
├── backtest/         Dataset, pengambil riwayat, model fill, simulator, walk-forward + kunci holdout, metrik, pembanding, laporan
├── watchlist/        Repository watchlist
└── main.ts           Composition root
```

## Keamanan

- Bot hanya merespons `TELEGRAM_ALLOWED_USER_ID` di chat privat. Upaya akses lain diabaikan dan dicatat di `audit_logs` (tanpa isi pesan).
- Rate limit perintah: 5 perintah per 5 detik.
- Token dan password tidak pernah ditulis ke log. Nilainya disaring dari setiap baris log, termasuk dari pesan error.
- `.env` tidak boleh di-commit (sudah ada di `.gitignore`).

## Catatan teknis

- **Tanpa Redis (menyimpang dari PRD §5):** Redis/BullMQ di PRD hanya untuk scheduler (Milestone 5) dan tidak dipakai di Milestone 1, sehingga dihapus. Mekanisme penjadwalan (mis. berbasis PostgreSQL via tabel `scheduled_scans`, atau menambahkan Redis kembali) diputuskan di Milestone 5.
- **Timeframe:** API OHLC resmi Indodax tidak menyediakan candle 5 menit, sehingga timeframe utama dan entry default-nya 15 menit (dapat diubah per user di `user_settings`).
- **Perilaku Indodax Public API yang berbeda dari dokumentasi** (diverifikasi 2 Nov 2026):
  - `server_time` di `/api/server_time` dalam milidetik; ticker, trade, dan candle dalam detik.
  - Order book berisi string; OHLC berisi number; `quantity_increment` berupa number.
  - Pair tidak valid tetap HTTP 200 dengan body `{"error": "invalid_pair"}`; symbol OHLC tidak valid → array kosong.
  - OHLC maksimal ~865 candle per request; trade 500 terakhir; order book 150 level per sisi.
  - `tid` trade melebihi `Number.MAX_SAFE_INTEGER` → disimpan sebagai string.
  - `price_precision` sebenarnya adalah tick size (QNT = 1 IDR).
  - Cloudflare men-cache ticker/depth 30 dtk, OHLC/pairs 60 dtk, trade 3 dtk.
- **WebSocket** ditunda sampai setelah Milestone 5 (REST cukup untuk scan 15 menit).
