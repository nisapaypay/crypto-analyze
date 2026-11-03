# Eksperimen riwayat panjang (≈3 tahun) — desain

Status: **eksperimen saja**. Strategy Engine, parameter default, watchlist, modal, risk management, biaya produksi, dan database tidak diubah. Logika simulasi memakai ulang `experiments/m4-followup/lib/` (simulator yang sudah dicek identik dengan `src/backtest/simulator.ts`).

```bash
pnpm exec tsx experiments/long-history/fetch.ts                         # dataset pengembangan → data/dev/ (git-ignored) + manifest.json
pnpm exec tsx experiments/long-history/run.ts --universe fokus --tf 15  # fokus|semua × 15|60 (bisa paralel)
pnpm exec tsx experiments/long-history/report.ts                        # walk-forward + laporan → reports/
```

## Periode (UTC, konstanta di `config.ts`)

| Bagian | Rentang | Catatan |
|---|---|---|
| Pemanasan | 2023-11-01 → 2023-12-31 | ≥ 300 candle 4j sebelum keputusan pertama |
| Pengembangan | 2024-01-01 → 2026-08-02 | 31 bulan kalender; mencakup fase naik, sideways, dan turun (diukur, lihat laporan bagian 3) |
| Holdout | 2026-08-02 → data terbaru | ≈3 bulan; batas sama persis dengan eksperimen `m4-followup` |

Walk-forward: latih 12 bulan → uji 3 bulan, geser 3 bulan → 7 fold (uji 2025-01 … 2026-07). Di tiap fold, tiap keluarga strategi memilih parameter dari data latih saja (expectancy R tertinggi dengan ≥ 30 trade, selain itu default). Tiap skenario biaya dipilih terpisah.

## Isolasi holdout

1. `fetch.ts` hanya meminta candle yang **tutup** sebelum `HOLDOUT_START`; candle holdout tidak pernah diunduh atau disimpan. Candle yang tetap dikembalikan API di/after batas dibuang di memori dan dihitung (`droppedAtBoundary`).
2. `loadDevSeries` menolak dataset bila batas di manifest berbeda, hash file tidak cocok, atau ada candle yang tutup setelah batas.
3. `report.ts` menolak trade yang keputusan/exit-nya di luar periode pengembangan.
4. Tidak ada jalur kode holdout; tidak ada file lock; `data/backtest/` tidak disentuh. Dataset `m4-followup/data/` (yang berisi candle holdout) tidak dibaca.

## Kualitas data

`manifest.json` mencatat per pair × timeframe: awal/akhir aktual, jumlah vs diharapkan, gap, duplikat dari API, candle tidak sejajar, OHLC invalid, % volume 0, rentetan volume 0 terpanjang, hash. Tidak ada pengisian data.

## Strategi yang dibandingkan

| Keluarga | Timeframe | Grid parameter (default tebal) |
|---|---|---|
| Baseline produksi (pullback) | 15m / 1j | ATR SL 1,5/2 × cap 3R/2,5R × volume 1,2/1,5 — **atr1.5_rr3_vol1.2** |
| Pullback | 1j / 4j | grid sama — **atr1.5_rr3_vol1.2** |
| Breakout + konfirmasi | 1j / 4j | TP resistance/3 ATR × jarak maks 0,5/1,0 ATR — **res-ext0.5** |
| Breakout + retest | 1j / 4j | grid sama — **res-ext0.5** |

Aturan rinci breakout, penyesuaian timeframe, dan skenario biaya C0–C3: lihat `experiments/m4-followup/README.md`.

## Pembagian kondisi pasar

Fase bulanan per pair dari return bulanan pair itu sendiri: ≥ +10% bullish, ≤ −10% bearish, lainnya sideways. Regime engine saat keputusan tidak dipakai untuk pembagian karena setiap trade sudah wajib BULLISH (G2).
