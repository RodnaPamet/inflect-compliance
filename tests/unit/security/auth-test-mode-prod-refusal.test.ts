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
const codeOnly = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

    it('exempts `next start` under test, or it kills the E2E webserver', () => {
        // The case that actually broke, and the reason it is worth its own
        // test rather than a comment. `next start` OVERWRITES
        // process.env.NODE_ENV to "production" regardless of what the
        // caller passed — playwright.config.ts says so explicitly, and the
        // Epic B encryption sentinel already had to account for it.
        //
        // So the E2E server, which legitimately sets AUTH_TEST_MODE=1,
        // presents to both checks as production. Without the exemption the
        // refusal exits 1, Playwright waits for a port that never opens,
        // and the job dies at its 40-minute timeout with NO failing test to
        // point at — a red run that names nothing.
        //
        // NEXT_TEST_MODE is set only by that webServer and
        // scripts/e2e-local.mjs, so it separates the two cases without
        // weakening the refusal.
        // COMMENT-STRIPPED, and that is the whole point. Both files
        // explain this exemption in prose immediately above the code that
        // implements it, so an assertion over raw source is satisfied by
        // the explanation — deleting the actual guard leaves it green.
        // Verified: without stripping, removing both guards still passed.
        const envSrc = codeOnly(read('src/env.ts'));
        const declAt = envSrc.indexOf('AUTH_TEST_MODE: z');
        expect(declAt).toBeGreaterThan(-1);
        expect(envSrc.slice(declAt, declAt + 700))
            .toMatch(/NEXT_TEST_MODE === '1'\)\s*return;/);

        const instrSrc = codeOnly(read('src/instrumentation.ts'));
        expect(instrSrc).toMatch(
            /NEXT_TEST_MODE !== '1'[\s\S]{0,120}AUTH_TEST_MODE === '1'/,
        );
        // …and the webServer really does set it, so the exemption fires.
        expect(read('playwright.config.ts')).toMatch(/NEXT_TEST_MODE=1/);
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
