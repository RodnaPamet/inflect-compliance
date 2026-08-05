/**
 * Playwright global setup: seed the database, then pre-warm the dev server.
 *
 * 1. **Database seeding** — The E2E credentials provider does a real DB lookup
 *    (bcrypt compare). If the database hasn't been seeded, *every* login attempt
 *    returns "Invalid credentials" and every test using `loginAndGetTenant` fails
 *    with a 60s timeout. Running `prisma db seed` here guarantees the test users
 *    exist before any test runs.
 *
 * 2. **Dev server pre-warming** — In dev mode, Next.js compiles pages JIT.
 *    The first navigation triggers compilation of middleware, layout, and the
 *    login page simultaneously (10-30s). This sends a request to `/login`
 *    BEFORE tests run so the pages are already compiled and cached.
 */
import type { FullConfig } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';

export default async function globalSetup(config: FullConfig) {
    const projectRoot = path.resolve(__dirname, '..', '..');

    // ── Phase 1: Ensure the database is seeded ──
    //
    // CI seeds explicitly in the workflow before Playwright starts, so
    // re-seeding here is pure duplicate work (a full `prisma/seed.ts`
    // run, ~30-60s). Locally it stays: `npx playwright test` against a
    // fresh database has to seed itself or every login fails.
    if (process.env.CI === 'true' || process.env.CI === '1') {
        console.log('[global-setup] CI: database already seeded by the workflow, skipping seed.');
    } else {
        console.log('[global-setup] Ensuring database is seeded...');
        try {
            execSync('npx tsx prisma/seed.ts', {
                cwd: projectRoot,
                stdio: 'pipe',
                timeout: 60_000,
                env: { ...process.env },
            });
            console.log('[global-setup] Database seed complete.');
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            // If seeding fails (e.g. DB not running), log but don't abort —
            // the tests will fail with a clearer "Invalid credentials" error.
            console.warn(`[global-setup] ⚠ Database seed failed: ${msg.slice(0, 200)}`);
            console.warn('[global-setup] Tests requiring login will likely fail.');
        }
    }

    // ── Phase 2: Pre-warm the dev server ──
    const baseURL = config.projects[0]?.use?.baseURL || 'http://127.0.0.1:3006';
    console.log(`[global-setup] Pre-warming dev server at ${baseURL}/login ...`);

    const maxRetries = 30;
    const retryDelay = 2000;

    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(`${baseURL}/login`, {
                signal: AbortSignal.timeout(30_000),
            });
            console.log(`[global-setup] Dev server responded: ${response.status} (attempt ${i + 1})`);

            if (response.ok || response.status === 302) {
                // Also warm up the dashboard route to pre-compile layout/middleware
                try {
                    await fetch(`${baseURL}/t/acme/dashboard`, {
                        signal: AbortSignal.timeout(30_000),
                    });
                } catch { /* best effort */ }

                console.log('[global-setup] Dev server is warm and ready.');
                return;
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            if (i < maxRetries - 1) {
                if (i % 5 === 0) {
                    console.log(`[global-setup] Waiting for dev server... (attempt ${i + 1}/${maxRetries}: ${msg.slice(0, 80)})`);
                }
                await new Promise(r => setTimeout(r, retryDelay));
                continue;
            }
            console.warn(`[global-setup] Could not pre-warm dev server after ${maxRetries} attempts. Tests may be slow on first navigation.`);
        }
    }
}
