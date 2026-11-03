/** Apply migrations to TEST_DATABASE_URL (used by tests/integration). */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error('TEST_DATABASE_URL belum diisi di .env');
  process.exit(1);
}

execFileSync('pnpm', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
});
