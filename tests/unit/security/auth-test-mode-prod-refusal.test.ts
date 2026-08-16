/**
 * A production process refuses to boot with AUTH_TEST_MODE=1.
 *
 * The name undersells the flag. It is not "enable the test login" — setting
 * it strips four production controls at once, in four different files, none
 * of which announces itself:
 *
 *   src/lib/auth/credentials.ts:209             credentials sign-in gate
 *   src/lib/auth/credential-rate-limit.ts:103   login brute-force throttle
 *                                               becomes a NO-OP (Epic A.3)
 *   src/lib/rate-limit/authRateLimit.ts:143     auth tier bypassed
 *   src/lib/rate-limit/apiReadRateLimit.ts:190  read tier bypassed
 *
 * So a production process with it set accepts username/password auth AND has
 * no brute-force protection AND no rate limiting on either tier.
 *
 * Why this exists — stated accurately, because the first version of this
 * file got it wrong. An audit reported `AUTH_TEST_MODE=1` sitting two dozen
 * lines below `NODE_ENV=production` in a "checked-in production env file".
 * It is NOT checked in: `deploy/.env.prod` is gitignored (.gitignore:19) and
 * untracked, so that was one machine's local config, not the repo's. The
 * tracked template `deploy/.env.prod.example` does not set the flag, and
 * neither does `.env.production.example` or `.env.staging.example`.
 *
 * Production is clean too — verified 2026-08-17 against the live VM: zero
 * occurrences in `/opt/inflect/.env.prod` and zero in the running
 * container's environment.
 *
 * So nothing was exposed and nothing needed removing. What remains worth
 * having is the guarantee: `docs/ci-local.md:122` promises "the production
 * app will never have this enabled unless explicitly set", and until now
 * nothing enforced that — a single explicit set, by anyone, at any point in
 * a deploy chain, silently strips four controls. These two checks turn the
 * promise into a refusal to boot.
 *
 * Hence two enforcement surfaces, mirroring GAP-03 / DATA_ENCRYPTION_KEY:
 * the env schema (module load) and the startup hook (which still fires when
 * SKIP_ENV_VALIDATION=1 leaks into a runtime container — the configuration
 * an image is MOST likely to carry, since the build sets it deliberately).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('AUTH_TEST_MODE is refused in production', () => {
    it('the env schema rejects "1" when NODE_ENV is production', () => {
        const src = read('src/env.ts');
        const at = src.indexOf('AUTH_TEST_MODE: z');
        expect(at).toBeGreaterThan(-1);
        const block = src.slice(at, at + 900);
        expect(block).toMatch(/superRefine/);
        expect(block).toMatch(/NODE_ENV !== 'production'/);
        expect(block).toMatch(/val === '1'/);
    });

    it('the startup hook exits 1 rather than booting weakened', () => {
        // The schema check does not fire under SKIP_ENV_VALIDATION=1, which
        // is precisely what a built container carries.
        const src = read('src/instrumentation.ts');
        expect(src).toMatch(
            /NODE_ENV === 'production'[\s\S]{0,120}AUTH_TEST_MODE === '1'/,
        );
        const at = src.indexOf("AUTH_TEST_MODE === '1'");
        expect(src.slice(at, at + 700)).toMatch(/process\.exit\(1\)/);
    });

    it('no TRACKED env template sets it', () => {
        // Deliberately scoped to tracked files. The earlier version of this
        // read `deploy/.env.prod` — which is gitignored, so it passed on the
        // machine that had one and FAILED in CI, where the file does not
        // exist. Asserting about an untracked file asserts about whoever
        // happens to be running the suite.
        for (const f of [
            'deploy/.env.prod.example',
            '.env.production.example',
            '.env.staging.example',
        ]) {
            expect(read(f)).not.toMatch(/^AUTH_TEST_MODE=/m);
        }
    });

    it('those templates are genuinely production ones, so the check above bites', () => {
        expect(read('deploy/.env.prod.example')).toMatch(/^NODE_ENV=production$/m);
    });

    it('the flag still works outside production — this is a prod refusal, not a removal', () => {
        // E2E depends on it. A change that made the flag inert everywhere
        // would break the suite in a way that reads as unrelated flake.
        const src = read('src/env.ts');
        const at = src.indexOf('AUTH_TEST_MODE: z');
        expect(src.slice(at, at + 900)).toMatch(/return;/); // the non-prod early return
        expect(read('.env.e2e.example')).toMatch(/AUTH_TEST_MODE/);
    });
});
