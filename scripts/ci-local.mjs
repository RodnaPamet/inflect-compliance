#!/usr/bin/env node
/**
 * Local CI pipeline — cross-platform (Windows/macOS/Linux).
 *
 * Steps: docker up → lint → typecheck → prisma generate → migrate → jest → build
 *
 * Usage:
 *   node scripts/ci-local.mjs              # full pipeline
 *   node scripts/ci-local.mjs --skip-db    # skip docker (DB already running)
 *   node scripts/ci-local.mjs --no-build   # skip next build step
 */
import { execSync } from 'child_process';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const SKIP_DB = args.includes('--skip-db');
const NO_BUILD = args.includes('--no-build');

// ── Load .env.test if present ──
const envFile = join(ROOT, '.env.test');
const envVars = {};
if (existsSync(envFile)) {
    const lines = readFileSync(envFile, 'utf8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
            envVars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
        }
    }
}

const TEST_DB_URL = envVars.DATABASE_URL_TEST
    || process.env.DATABASE_URL_TEST
    || 'postgresql://test:test@localhost:5434/inflect_test?schema=public';

const env = {
    ...process.env,
    ...envVars,
    DATABASE_URL: TEST_DB_URL,
    DATABASE_URL_TEST: TEST_DB_URL,
    // THE LOAD-BEARING LINE (#5641). `prisma migrate reset` below resolves its
    // URL through `prisma.config.ts`, which reads
    // `DIRECT_DATABASE_URL ?? DATABASE_URL` — so without this it targets
    // whatever the developer has exported, and `.env.example` ships one
    // pointing at the DEV database. `--force` suppresses the confirmation that
    // would have saved them. `e2e-local.mjs` has had this line all along; the
    // two scripts reset the same database and disagreed about which.
    DIRECT_DATABASE_URL: TEST_DB_URL,
    SKIP_ENV_VALIDATION: '1',
    NODE_ENV: 'test',
};

// Ensure upload dir exists
const uploadDir = env.FILE_STORAGE_ROOT || env.UPLOAD_DIR || join(ROOT, 'tmp', 'test-uploads');
mkdirSync(uploadDir, { recursive: true });

function run(cmd, label, extraEnv = {}) {
    const stepEnv = { ...env, ...extraEnv };
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  ${label}`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`  → ${cmd}\n`);
    try {
        execSync(cmd, { cwd: ROOT, env: stepEnv, stdio: 'inherit', timeout: 300_000 });
    } catch (err) {
        console.error(`\n❌ FAILED: ${label}`);
        process.exit(1);
    }
}

const startTime = Date.now();
console.log('\n🚀 Local CI Pipeline\n');

// ── 1. Start test DB ──
if (!SKIP_DB) {
    run('docker compose -f docker-compose.test.yml up -d --wait', '1/7  Start test database');
} else {
    console.log('\n⏭  Skipping DB start (--skip-db)\n');
}

// ── 2. Install ──
run('npm ci --ignore-scripts=false', '2/7  Install dependencies');

// ── 3. Prisma generate ──
run('npx prisma generate', '3/7  Generate Prisma client');

// ── 4. Lint ──
run('npm run lint', '4/7  Lint (next lint)');

// ── 5. Typecheck ──
run('npm run typecheck', '5/7  Typecheck (tsc --noEmit)');

// ── 6. Migrate + Test ──
// The flag below was `--force --skip-seed`. `--skip-seed` was removed in
// Prisma 7 (installed: 7.10.1, whose `migrate reset --help` lists only
// `-f, --force`), so this step died on an unknown option and
// `npm run ci:local` could never pass. Dropping it changes nothing: there is
// no `prisma.seed` in package.json and no `migrations.seed` in
// prisma.config.ts, so reset has no seed to skip.
//
// Note the ORDER this was fixed in: the broken flag was MASKING #5641's other
// half, because the step died before Prisma connected to anything. Removing it
// without the DIRECT_DATABASE_URL line above makes this command work — against
// the developer's own database.
run('npx prisma migrate reset --force', '6/7a Reset test database (migrate reset)');
run('npm run test:ci', '6/7b Run tests (Jest)');

// ── 7. Build ──
if (!NO_BUILD) {
    run('npx next build --webpack', '7/7  Production build', { NODE_ENV: 'production' });
} else {
    console.log('\n⏭  Skipping build (--no-build)\n');
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n${'═'.repeat(60)}`);
console.log(`  ✅ Local CI passed in ${elapsed}s`);
console.log(`${'═'.repeat(60)}\n`);
