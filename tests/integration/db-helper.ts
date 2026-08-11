/**
 * Integration test helper: synchronous DB availability check.
 * Used to conditionally skip integration test suites that require PostgreSQL.
 *
 * URL resolution order:
 *   1. DATABASE_URL_TEST env var (set by ci-local.mjs)
 *   2. .env.test file (DATABASE_URL_TEST or DATABASE_URL)
 *   3. .env file DATABASE_URL (dev database)
 *   4. Process env DATABASE_URL
 *   5. Hard-coded fallback
 */
import * as fs from 'fs';
import * as path from 'path';
import { getTestDatabaseUrl } from '../helpers/db';
import { assertDbAvailableOrSkipAllowed } from './db-availability';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Parse a key from an env file. Returns undefined if not found.
 */
function parseEnvKey(filePath: string, key: string): string | undefined {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const re = new RegExp(`^${key}=["']?([^"'\\n]*)["']?$`, 'm');
        return content.match(re)?.[1] || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Resolve the database URL for integration tests.
 *
 * Delegates to the single source of truth `getTestDatabaseUrl()` so this
 * resolver can NEVER diverge from the app's prisma client + the test
 * prisma client: under per-worker isolation all three resolve to THIS
 * worker's cloned DB; serial/CI resolves to the shared base DB. (A prior
 * independent resolver here hit the base DB while the app hit the worker
 * clone — the cross-DB data-race that broke parallel integration runs.)
 * `parseEnvKey` + the chain below remain only as a non-jest fallback.
 */
function resolveDbUrl(): string {
    const fromHelper = getTestDatabaseUrl();
    if (fromHelper) return fromHelper;

    // ── Fallback chain (non-jest contexts) ──
    // 1. Explicit test env var (highest priority — set by CI scripts)
    if (process.env.DATABASE_URL_TEST) return process.env.DATABASE_URL_TEST;

    // 2. .env.test file
    const envTestPath = path.join(ROOT, '.env.test');
    const fromEnvTest = parseEnvKey(envTestPath, 'DATABASE_URL_TEST')
        || parseEnvKey(envTestPath, 'DATABASE_URL');
    if (fromEnvTest) return fromEnvTest;

    // 3. Process env DATABASE_URL
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

    // 4. .env file (dev database — standard local dev, no jest.setup)
    const envPath = path.join(ROOT, '.env');
    const fromEnv = parseEnvKey(envPath, 'DATABASE_URL');
    if (fromEnv) return fromEnv;

    // 5. Hard-coded fallback
    return 'postgresql://user:password@localhost:5432/testdb';
}

/**
 * Synchronous DB availability check.
 *
 * Attempts a Prisma `$connect()` + `$queryRaw` against the given URL.
 * Runs synchronously via spawnSync so it can gate `describe` / `describe.skip`
 * at module scope.
 *
 * Uses spawnSync (no shell) with the URL passed via environment variable to
 * avoid shell-escaping issues with special characters like & in pgbouncer URLs.
 */
function checkDbAvailable(url: string | undefined): boolean {
    if (!url) return false;
    try {
        const { spawnSync } = require('child_process');
        // Prisma 7 dropped the `datasources` constructor option; URLs
        // now flow in through a driver adapter (`@prisma/adapter-pg`).
        // Mirrors the singleton wiring in `src/lib/prisma.ts`.
        const script = [
            "const{PrismaClient}=require('@prisma/client');",
            "const{PrismaPg}=require('@prisma/adapter-pg');",
            'const u=process.env.__DB_CHECK_URL;',
            'const adapter=new PrismaPg({connectionString:u});',
            'const p=new PrismaClient({adapter});',
            'p.$connect()',
            '.then(()=>p.$queryRawUnsafe("SELECT 1"))',
            '.then(()=>{p.$disconnect();process.exit(0)})',
            '.catch(()=>{p.$disconnect().catch(()=>{});process.exit(1)})',
        ].join('');
        const result = spawnSync('node', ['-e', script], {
            // 5s was too tight: a cold Prisma client + connect on a
            // loaded machine takes ~6s here, so the probe timed out and
            // EVERY integration suite silently skipped — tests appeared
            // to pass while never running. Erring long only ever runs
            // more tests; it cannot mask a failure.
            timeout: 30000,
            stdio: 'ignore',
            cwd: ROOT,
            env: { ...process.env, __DB_CHECK_URL: url },
        });
        return result.status === 0;
    } catch {
        return false;
    }
}

const dbUrl = resolveDbUrl();

const available = checkDbAvailable(dbUrl);

/**
 * FAIL CLOSED. An unavailable database is a test-infrastructure FAILURE, not a
 * reason to report success over 169 suites that never ran.
 *
 * `DB_AVAILABLE` gates 166 `describe`/`describe.skip` pairs across
 * tests/integration, tests/unit/jobs and tests/guardrails — including every
 * cross-tenant isolation suite, `rls-isolation`, `rls-coverage`,
 * `epic-b-encryption`, `audit-immutability`, `multi-tenant-jwt` and
 * `last-owner-guard`. When the probe returned `false`, all of them skipped and
 * the run was GREEN: the strongest behavioural evidence this repo has for
 * tenant isolation reported success without executing a line.
 *
 * That is not hypothetical. The comment on the probe's own timeout records it
 * happening — 5s was too tight, "EVERY integration suite silently skipped —
 * tests appeared to pass while never running". The response then was a longer
 * timeout, which makes the window narrower without closing it: any slow,
 * misconfigured or briefly-unreachable database still buys a green run.
 *
 * So the default is now to throw. Skipping is still available for local work
 * without Postgres, but it must be ASKED FOR — `ALLOW_DB_SKIP=1`, which CI
 * never sets. The asymmetry is deliberate: opting into weaker signal should
 * take an explicit act, and the default should be the safe one.
 */
assertDbAvailableOrSkipAllowed(available, process.env.ALLOW_DB_SKIP, dbUrl);

export const DB_URL = dbUrl;
export const DB_AVAILABLE = available;
