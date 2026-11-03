export interface CommandInfo {
  command: string;
  description: string;
  /** Milestone where the command becomes functional; `null` = available now. */
  plannedMilestone: number | null;
}

/** All commands from PRD §11.1, with their rollout milestone. */
export const COMMANDS: readonly CommandInfo[] = [
  { command: 'start', description: 'Mulai bot', plannedMilestone: null },
  { command: 'scan', description: 'Scan watchlist + kandidat utama', plannedMilestone: null },
  { command: 'status', description: 'Status sistem', plannedMilestone: null },
  { command: 'watchlist', description: 'Watchlist + data pasar terkini', plannedMilestone: null },
  { command: 'addcoin', description: 'Tambah pair ke watchlist', plannedMilestone: null },
  { command: 'removecoin', description: 'Hapus pair dari watchlist', plannedMilestone: null },
  { command: 'analyze', description: 'Analisis teknikal detail satu koin', plannedMilestone: null },
  { command: 'capital', description: 'Ubah modal analisis', plannedMilestone: 6 },
  { command: 'risk', description: 'Lihat konfigurasi & pemakaian risiko', plannedMilestone: null },
  { command: 'pause', description: 'Jeda scan strategi otomatis (data tetap dikumpulkan)', plannedMilestone: null },
  { command: 'resume', description: 'Lanjutkan scan strategi otomatis', plannedMilestone: null },
  { command: 'bought', description: 'Catat pembelian manual', plannedMilestone: 6 },
  { command: 'sold', description: 'Catat penjualan manual', plannedMilestone: 6 },
  { command: 'positions', description: 'Lihat posisi yang dicatat', plannedMilestone: 6 },
  { command: 'history', description: 'Riwayat trading', plannedMilestone: 6 },
  { command: 'report', description: 'Laporan performa', plannedMilestone: 6 },
  { command: 'help', description: 'Bantuan', plannedMilestone: null },
];
