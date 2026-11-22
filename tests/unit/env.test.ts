/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
import { execSync } from 'child_process';
import path from 'path';

describe('Environment Variable Validation', () => {
    const scriptPath = path.resolve(__dirname, '../../scripts/print-env-ok.ts');

    const validEnv = {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://user:password@localhost:5432/db',
        NEXTAUTH_URL: 'http://localhost:3000',
        AUTH_URL: 'http://localhost:3000',
        AUTH_SECRET: 'supersecretstringthatis16charplus', // pragma: allowlist secret — test fixture (mirrors REPO_BASELINE in tests/guardrails/no-secrets.test.ts)
        JWT_SECRET: 'supersecretstringthatis16charplus', // pragma: allowlist secret — test fixture (mirrors REPO_BASELINE)
        GOOGLE_CLIENT_ID: 'google-client-id',
        GOOGLE_CLIENT_SECRET: 'google-secret',
        MICROSOFT_CLIENT_ID: 'ms-client-id',
        MICROSOFT_CLIENT_SECRET: 'ms-secret',
        UPLOAD_DIR: '/tmp/uploads',
    };

    function runEnvScript(envOverrides: Record<string, string | undefined>) {
        const testEnv: any = { ...process.env, ...validEnv, ...envOverrides, SKIP_ENV_VALIDATION: '' };

        // Remove undefined explicitly
        Object.keys(testEnv).forEach(key => {
            if (testEnv[key] === undefined) delete testEnv[key];
        });

        // Use ts-node (tsx) to run the script since it imports TS files
        try {
            const output = execSync(`npx tsx ${scriptPath}`, {
                env: testEnv,
                encoding: 'utf-8',
                stdio: 'pipe',
            });
            return { success: true, output };
        } catch (error: any) {
            return {
                success: false,
                output: error.stdout,
                error: error.stderr || error.message
            };
        }
    }

    it('should pass and print OK when all required vars are present', () => {
        const result = runEnvScript({});
        expect(result.success).toBe(true);
        expect(result.output).toContain('OK');
    });

    it('should fail when AUTH_SECRET is missing', () => {
        const result = runEnvScript({ AUTH_SECRET: undefined });
        expect(result.success).toBe(false);
        expect(result.error).toContain('AUTH_SECRET');
        expect(result.error).toContain('expected string'); // Zod error indicator
    });

    it('should fail when AUTH_SECRET is too short', () => {
        const result = runEnvScript({ AUTH_SECRET: 'short' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('AUTH_SECRET');
        expect(result.error).toContain('must be at least 16 characters');
    });

    it('should fail when DATABASE_URL is not a valid URL', () => {
        const result = runEnvScript({ DATABASE_URL: 'not-a-db-url' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('DATABASE_URL');
        expect(result.error).toContain('Invalid URL');
    });

    it('should pass validation even if NEXTAUTH_URL & AUTH_URL omitted entirely, relying on Vercel URL mapping if theoretically present', () => {
        const result = runEnvScript({ NEXTAUTH_URL: undefined, AUTH_URL: undefined, VERCEL: '1', VERCEL_URL: 'https://myapp.vercel.app' });
        if (!result.success) {
            console.error(result.error);
        }
        expect(result.success).toBe(true);
    });

    // ─── GAP-03: DATA_ENCRYPTION_KEY production enforcement ──────────
    //
    // The schema-level superRefine on DATA_ENCRYPTION_KEY enforces the
    // production-required + not-equal-to-dev-fallback contract. These
    // tests run the env loader in a child process under
    // NODE_ENV=production and assert the failure modes the audit
    // identified as GAP-03.

    it('rejects NODE_ENV=production when DATA_ENCRYPTION_KEY is unset', () => {
        const result = runEnvScript({
            NODE_ENV: 'production',
            DATA_ENCRYPTION_KEY: undefined,
            // Provide REDIS_URL so we isolate the encryption-key path
            // (GAP-13 makes REDIS_URL prod-required too).
            REDIS_URL: 'redis://:devpass@localhost:6379',
            // Provide everything else so we isolate the encryption-key path.
            STORAGE_PROVIDER: 'local',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('DATA_ENCRYPTION_KEY');
        expect(result.error).toContain('REQUIRED in production');
        // Regression: a refactor that makes the field optional in
        // production again would silently undo GAP-03. The audit
        // flagged this exact regression class.
    });

    it('rejects NODE_ENV=production when DATA_ENCRYPTION_KEY equals the documented dev fallback', () => {
        const result = runEnvScript({
            NODE_ENV: 'production',
            // Keep this string in sync with `encryption-constants.ts`.
            // We hard-code it here (rather than import) because runEnvScript
            // spawns a child process — the constant isn't available in
            // shell env at that point.
            DATA_ENCRYPTION_KEY: 'inflect-dev-encryption-key-not-for-production-use!!',
            REDIS_URL: 'redis://:devpass@localhost:6379',
            STORAGE_PROVIDER: 'local',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('DATA_ENCRYPTION_KEY');
        expect(result.error).toContain('dev fallback');
        // Regression: a misconfigured prod deploy with NODE_ENV=production
        // but DATA_ENCRYPTION_KEY accidentally set to the well-known dev
        // string would silently encrypt customer data with a key that
        // is committed in this repo. Refusing to boot is the only safe
        // outcome.
    });

    it('rejects NODE_ENV=production when DATA_ENCRYPTION_KEY is shorter than 32 chars', () => {
        const result = runEnvScript({
            NODE_ENV: 'production',
            DATA_ENCRYPTION_KEY: 'too-short',
            REDIS_URL: 'redis://:devpass@localhost:6379',
            STORAGE_PROVIDER: 'local',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('DATA_ENCRYPTION_KEY');
        expect(result.error).toContain('at least 32 characters');
    });

    it('passes when DATA_ENCRYPTION_KEY is unset under NODE_ENV=test (dev/test ergonomics preserved)', () => {
        const result = runEnvScript({
            NODE_ENV: 'test',
            DATA_ENCRYPTION_KEY: undefined,
        });
        // The dev fallback in the encryption module + the optional()
        // schema mean test/dev environments must continue to boot
        // without a key. A regression here would force every contributor
        // and every test runner to set DATA_ENCRYPTION_KEY.
        expect(result.success).toBe(true);
    });

    it('passes when DATA_ENCRYPTION_KEY is unset under NODE_ENV=development', () => {
        const result = runEnvScript({
            NODE_ENV: 'development',
            DATA_ENCRYPTION_KEY: undefined,
        });
        expect(result.success).toBe(true);
    });

    it('passes when production has a real ≥32-char key (happy path)', () => {
        const result = runEnvScript({
            NODE_ENV: 'production',
            DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
            REDIS_URL: 'redis://:devpass@localhost:6379',
            STORAGE_PROVIDER: 'local',
        });
        if (!result.success) {
            console.error(result.error);
        }
        expect(result.success).toBe(true);
    });

    // ─── GAP-13: REDIS_URL production enforcement ──────────────────
    //
    // The schema-level superRefine on REDIS_URL enforces the
    // production-required contract. These tests run the env loader
    // in a child process under NODE_ENV=production and assert the
    // failure modes that GAP-13 closed.

    it('rejects NODE_ENV=production when REDIS_URL is unset', () => {
        const result = runEnvScript({
            NODE_ENV: 'production',
            // Isolate the REDIS_URL path — supply everything else.
            DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
            STORAGE_PROVIDER: 'local',
            REDIS_URL: undefined,
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('REDIS_URL');
        expect(result.error).toContain('REQUIRED in production');
        // Regression: a refactor that drops the superRefine and makes
        // the field optional in production again would silently strip
        // rate-limit + queue + session-coordination guarantees.
    });

    it('passes when REDIS_URL is unset under NODE_ENV=test (dev/test ergonomics preserved)', () => {
        const result = runEnvScript({
            NODE_ENV: 'test',
            REDIS_URL: undefined,
        });
        // Without this, every contributor and every test runner would
        // need a local Redis to validate env. The graceful fallback
        // (in-memory rate-limit, no BullMQ jobs) is intentional in
        // dev/test only.
        expect(result.success).toBe(true);
    });

    it('passes when REDIS_URL is unset under NODE_ENV=development', () => {
        const result = runEnvScript({
            NODE_ENV: 'development',
            REDIS_URL: undefined,
        });
        expect(result.success).toBe(true);
    });

    it('passes when production has a real REDIS_URL (happy path)', () => {
        const result = runEnvScript({
            NODE_ENV: 'production',
            DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
            REDIS_URL: 'redis://user:pass@redis.example.internal:6379',
            STORAGE_PROVIDER: 'local',
        });
        if (!result.success) {
            console.error(result.error);
        }
        expect(result.success).toBe(true);
    });

    // ─── Redis production-auth enforcement ─────────────────────────
    //
    // The GAP-13 superRefine on REDIS_URL was strengthened: in
    // production the URL must not only be PRESENT, it must be
    // AUTHENTICATED — it must parse and carry a non-empty password in
    // its userinfo. A bare `redis://host:6379` is rejected. An
    // unauthenticated Redis that is network-reachable is wide open;
    // sessions, rate-limit counters, and the job queue all live
    // there. The rule is production-only — dev/test keep ergonomic
    // passwordless Redis.

    describe('Redis production-auth rule', () => {
        it('rejects NODE_ENV=production when REDIS_URL is unauthenticated (no password)', () => {
            const result = runEnvScript({
                NODE_ENV: 'production',
                DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
                REDIS_URL: 'redis://redis:6379',
                STORAGE_PROVIDER: 'local',
            });
            expect(result.success).toBe(false);
            expect(result.error).toContain('REDIS_URL');
            expect(result.error).toContain('AUTHENTICATED in production');
            // Regression: a bare redis://host:6379 leaves Redis open to
            // anyone who can reach the port. Refusing to boot is the
            // only safe outcome for a production-like deployment.
        });

        it('passes NODE_ENV=production when REDIS_URL carries a password (redis://:pw@host)', () => {
            const result = runEnvScript({
                NODE_ENV: 'production',
                DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
                REDIS_URL: 'redis://:supersecret@redis:6379',
                STORAGE_PROVIDER: 'local',
            });
            if (!result.success) {
                console.error(result.error);
            }
            expect(result.success).toBe(true);
        });

        it('passes NODE_ENV=production when REDIS_URL is a TLS auth-token URL (rediss://:token@host)', () => {
            const result = runEnvScript({
                NODE_ENV: 'production',
                DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
                REDIS_URL: 'rediss://:managed-auth-token@redis.example.internal:6379',
                STORAGE_PROVIDER: 'local',
            });
            if (!result.success) {
                console.error(result.error);
            }
            expect(result.success).toBe(true);
        });

        it('passes when REDIS_URL is unauthenticated under NODE_ENV=test (rule is production-only)', () => {
            const result = runEnvScript({
                NODE_ENV: 'test',
                REDIS_URL: 'redis://redis:6379',
            });
            // Dev/test keep passwordless Redis for ergonomics — the
            // auth rule must not fire outside production.
            expect(result.success).toBe(true);
        });

        it('still rejects NODE_ENV=production when REDIS_URL is missing entirely', () => {
            const result = runEnvScript({
                NODE_ENV: 'production',
                DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
                STORAGE_PROVIDER: 'local',
                REDIS_URL: undefined,
            });
            expect(result.success).toBe(false);
            expect(result.error).toContain('REDIS_URL');
            expect(result.error).toContain('REQUIRED in production');
            // The pre-existing present-check must survive alongside the
            // new password check — the not-present branch returns early.
        });
    });

    // ─── Web Bot Auth deployment signing seed (web-bot-auth Phase 1) ───
    //
    // Optional; when present it must be a 32-byte Ed25519 seed that is
    // not another purpose's secret, and in production not a published
    // test seed. The value never appears in the refusal.
    describe('WEB_BOT_AUTH_SIGNING_KEY refusals', () => {
        const PROD = {
            NODE_ENV: 'production',
            DATA_ENCRYPTION_KEY: 'a-real-production-key-at-least-32-chars-long-deterministic',
            REDIS_URL: 'redis://user:pass@redis.example.internal:6379',
            STORAGE_PROVIDER: 'local',
        };
        // A fixture seed, not a credential — the refusal tests need a well-formed value.
        const WELL_FORMED_SEED = '4f3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e'; // pragma: allowlist secret

        it('boots production with a well-formed seed', () => {
            const result = runEnvScript({ ...PROD, WEB_BOT_AUTH_SIGNING_KEY: WELL_FORMED_SEED });
            if (!result.success) console.error(result.error);
            expect(result.success).toBe(true);
        });

        it('refuses a malformed seed without echoing it', () => {
            const result = runEnvScript({ ...PROD, WEB_BOT_AUTH_SIGNING_KEY: 'not-a-seed-value-xyzzy' });
            expect(result.success).toBe(false);
            expect(result.error).toContain('WEB_BOT_AUTH_SIGNING_KEY is not a 32-byte Ed25519 seed');
            expect(result.error).not.toContain('not-a-seed-value-xyzzy');
        });

        it('refuses a seed that is also the DATA_ENCRYPTION_KEY', () => {
            const result = runEnvScript({
                ...PROD,
                DATA_ENCRYPTION_KEY: WELL_FORMED_SEED,
                WEB_BOT_AUTH_SIGNING_KEY: WELL_FORMED_SEED,
            });
            expect(result.success).toBe(false);
            expect(result.error).toContain('WEB_BOT_AUTH_SIGNING_KEY equals DATA_ENCRYPTION_KEY');
        });

        it('refuses a published test seed in production', () => {
            const result = runEnvScript({
                ...PROD,
                WEB_BOT_AUTH_SIGNING_KEY: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
            });
            expect(result.success).toBe(false);
            expect(result.error).toContain('WEB_BOT_AUTH_SIGNING_KEY is a published test seed');
        });
    });
});
