/**
 * Show or change the cost assumptions (fees, taxes, slippage) of the bot owner.
 * Only the cost columns are touched — never capital, risk per trade or limits.
 *
 *   pnpm settings:costs                                   # show current values
 *   pnpm settings:costs --buy-tax 0.11 --sell-tax 0.11    # change (percent)
 *   pnpm settings:costs --verified                        # mark as checked against a real receipt
 *   pnpm settings:costs --unverified | --reset            # back to unverified / code defaults
 */
import 'dotenv/config';
import { PrismaAuditLog } from '../src/app/audit/audit-log.js';
import { createPrismaClient } from '../src/app/database/prisma.js';
import { Dec } from '../src/app/decimal.js';
import { createLogger } from '../src/app/logger/logger.js';
import { costLine } from '../src/bot/messages/strategy.js';
import { PrismaStrategySettings } from '../src/strategy/settings.js';

const FLAGS = {
  '--buy-fee': 'buyFeePct',
  '--sell-fee': 'sellFeePct',
  '--buy-tax': 'buyTaxPct',
  '--sell-tax': 'sellTaxPct',
  '--entry-slippage': 'entrySlippagePct',
  '--stop-slippage': 'stopSlippagePct',
  '--tp-slippage': 'tpSlippagePct',
} as const;

const args = process.argv.slice(2);
const ownerId = Number(process.env.TELEGRAM_ALLOWED_USER_ID);
if (!process.env.DATABASE_URL || !Number.isInteger(ownerId)) {
  console.error('DATABASE_URL dan TELEGRAM_ALLOWED_USER_ID harus diisi di .env.');
  process.exit(1);
}

const data: Record<string, string | boolean | null> = {};
for (const [flag, column] of Object.entries(FLAGS)) {
  const i = args.indexOf(flag);
  if (i < 0) continue;
  const raw = args[i + 1];
  let value: Dec;
  try {
    value = new Dec(raw ?? '');
  } catch {
    console.error(`${flag} butuh angka persen, contoh: ${flag} 0.11`);
    process.exit(1);
  }
  if (value.lt(0) || value.gt(5)) {
    console.error(`${flag} harus antara 0 dan 5 (persen).`);
    process.exit(1);
  }
  data[column] = value.toFixed();
}
if (args.includes('--reset')) {
  for (const column of Object.values(FLAGS)) data[column] = null;
  data.costsVerified = false;
}
if (args.includes('--verified')) data.costsVerified = true;
if (args.includes('--unverified')) data.costsVerified = false;

const prisma = createPrismaClient(process.env.DATABASE_URL);
try {
  const provider = new PrismaStrategySettings(prisma, ownerId);
  const before = await provider.load();
  console.log(`Sebelum: ${costLine(before.costs)}`);
  if (Object.keys(data).length === 0) {
    console.log('Tidak ada perubahan. Lihat opsi di bagian atas scripts/settings-costs.ts.');
  } else {
    await prisma.userSettings.updateMany({ where: { user: { telegramUserId: BigInt(ownerId) } }, data });
    await new PrismaAuditLog(prisma, createLogger({ level: 'silent' })).record({
      action: 'settings.costs',
      telegramUserId: ownerId,
      details: data as Record<string, unknown>,
    });
    console.log(`Sesudah: ${costLine((await provider.load()).costs)}`);
  }
} finally {
  await prisma.$disconnect();
}
