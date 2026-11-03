# Eksperimen lanjutan M4 (1–3) — desain

Status: **eksperimen saja**. Strategy Engine, parameter default, biaya produksi, watchlist, dan database tidak diubah. Folder ini berdiri sendiri; kode produksi hanya di-*import* (fungsi murni), tidak dimodifikasi.

```bash
pnpm exec tsx experiments/m4-followup/fetch.ts   # unduh candle 15m/1j/4j → experiments/m4-followup/data/ (git-ignored)
pnpm exec tsx experiments/m4-followup/run.ts     # simulasi bulan 1–9 → experiments/m4-followup/reports/
```

## Aturan umum

| Aturan | Implementasi |
|---|---|
| Data pengembangan saja | Periode = 12 blok yang sama persis dengan `pnpm backtest` (`planPeriods` atas 15m + 1j). Keputusan hanya untuk bulan 1–9. |
| Holdout terkunci | Semua candle (15m, 1j, 4j) yang **belum tutup** sebelum awal bulan 10 dihapus sebelum simulasi (`hideHoldout`, lebih ketat dari produksi yang memakai waktu buka), lalu diverifikasi `assertNoHoldout`. Holdout tidak pernah dijalankan; `holdout-lock.json` tidak disentuh. |
| Tanpa look-ahead | Keputusan pada `close + 90 dtk` hanya dari candle final (dicek `isFinalCandle`, error jika dilanggar). Zona resistance breakout dihitung dari jendela yang berakhir **satu candle sebelum** candle breakout. Order baru paling cepat terisi di candle 15m berikutnya. |
| Fill & exit | Selalu diselesaikan pada candle 15m (resolusi jalur harga lebih halus), untuk semua timeframe. Model fill produksi: SL dianggap lebih dulu bila SL & TP tersentuh di candle yang sama; gap di bawah SL keluar di open. |
| Risiko | Modal Rp5 jt, risiko 0,5%/trade, batas harian 1,5%, maks 3 sinyal/hari, 1 posisi, jam 09:00–22:00 WIB, risk ledger produksi (`computeRiskState`). |
| R/R | R/R bersih ≥ 1,5 setelah fee, pajak, slippage (G11), dihitung dengan `sizePosition` produksi. |
| Validasi simulator | Simulator eksperimen dijalankan dengan konfigurasi produksi (15m/1j, pullback, C0) dan harus **identik** dengan `src/backtest/simulator.ts` (jumlah sinyal, trade, total bersih). |

## Eksperimen 1 — timeframe 1j entry / 4j tren

- Strategi pullback produksi (G1–G12, regime, rencana trade) **tanpa perubahan aturan**, hanya inputnya: candle final 1j (entry) dan 4j (tren, Indodax `tf=240`, tidak diagregasi).
- ATR, EMA, RSI, volume, S/R dihitung ulang dari candle 1j aktual. Tidak ada asumsi "ATR 1j = 2× ATR 15m".
- Parameter berbasis **jumlah candle** tetap (periode indikator, slope 4 candle, fractal k=3, berlaku 2 candle, time stop 48 candle → 48 jam). Parameter berbasis **24 jam** disesuaikan: lookback HIGH_VOLATILITY 96×15m → 24×1j; volume IDR 24 jam = 24 candle 1j.
- Sensitivitas: 8 kombinasi grid produksi (ATR SL 1,5/2 × cap R 3/2,5 × volume 1,2/1,5), biaya C0.

## Eksperimen 2 — entry breakout

Diuji pada 1j/4j (utama) dan 15m/1j (untuk memisahkan efek breakout dari efek timeframe).

| Syarat | Aturan |
|---|---|
| G1 / reliabilitas | Data OK, indikator andal, tren tersedia |
| G2 | Regime BULLISH terkonfirmasi timeframe tren (fungsi regime produksi; candle shock > 3 ATR → HIGH_VOLATILITY → tidak entry) |
| B1 | Candle **final** tutup di atas puncak zona resistance yang sudah ada sebelumnya (close sebelumnya ≤ puncak zona). Beberapa zona tertembus → zona tertinggi. |
| B2 | Rasio volume candle breakout ≥ 1,2 |
| G7 / G10 | Spread ≤ 0,4% & ≤ 0,5 ATR · ATR% ≥ biaya bolak-balik |
| B3 | Jarak entry dari puncak zona ≤ 0,5 atau 1,0 ATR — dicek pada close keputusan **dan** pada harga isi aktual |
| G11 | SL/TP/sizing valid, R/R bersih ≥ 1,5 |
| G12 | Risk ledger, slot, jam aktif (simulator) |

Mode entry:
- **pasar** — beli market di open 15m berikutnya (+ setengah spread + slippage 0,15% ASUMSI).
- **konfirmasi** — tunggu satu candle final lagi yang juga tutup di atas zona, lalu beli market (filter false breakout).
- **retest** — limit di puncak zona, berlaku 2 candle (menunggu pullback ke level breakout).

SL & sizing: `stopLoss` produksi (yang lebih jauh dari dasar zona − 0,25 ATR dan entry − 1,5 ATR; min 1 ATR; maks 3 ATR → ditolak) dan `sizePosition` produksi. Untuk entry pasar, **SL, TP, jumlah koin, dan R/R dihitung ulang di harga isi aktual**; jika gagal (R/R < 1,5, stop > 3 ATR, jarak > B3, open sudah di bawah zona) order dibatalkan dan dicatat.

TP: **res** = resistance berikutnya − 0,1 ATR, dibatasi 3R (`takeProfit` produksi); **atr3** = entry + 3 ATR.

Diagnostik: false breakout (close kembali ≤ puncak zona dalam 4 candle), gap open vs close breakout, jarak isi dari zona, pembatalan karena gap/jarak.

## Eksperimen 3 — biaya

| Skenario | Entry | Exit TP | Exit SL / time stop | Sizing & R/R |
|---|---|---|---|---|
| C0 produksi | 0,20% + pajak 0,11% | sama | sama | sama |
| C1 taker | taker | taker | taker | taker |
| C2 maker ideal | maker | maker | maker | maker — **batas atas optimistis, tidak realistis** |
| C3 campuran | maker **hanya** jika limit menunggu di bawah ask; limit di/atas ask & market = taker | maker (limit menunggu) | taker | taker (maker tidak dijamin) |

Fee taker 0,20% / maker 0,10% dari Indodax `/api/pairs`; pajak 0,11%/sisi; slippage SL 0,15% — **semuanya ASUMSI** sampai diverifikasi dengan bukti transaksi.

## Pair

DOGE & XRP = universe fokus. Universe 4 pair (+ QNT, LINK) dijalankan terpisah sebagai pembanding; QNT dan LINK ditandai ⚠ (QNT: mayoritas candle 15m volume 0; LINK: spread sampel > 0,4%).

## Yang tidak dilakukan

- Tidak memilih "parameter final" dan tidak menjalankan holdout.
- Tidak menyimpulkan profitable dari backtest.
- Tidak mengubah Strategy Engine — menunggu persetujuan.
