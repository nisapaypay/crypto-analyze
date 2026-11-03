import 'dotenv/config';
import { loadConfig } from '../src/app/config/env.js';
import { createPrismaClient } from '../src/app/database/prisma.js';
import { seedDefaults } from '../src/app/database/seed-defaults.js';

const config = loadConfig();
const prisma = createPrismaClient(config.databaseUrl);

try {
  const { userId } = await seedDefaults(prisma, config.telegram.allowedUserId);
  console.log(`Seed selesai (user id ${userId}).`);
} finally {
  await prisma.$disconnect();
}
