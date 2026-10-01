/**
 * The Sentry privacy posture is PINNED in `init`, for whichever major is declared.
 *
 * ── The gap this closes ──────────────────────────────────────────────
 *
 * `sentry.ts` pins `sendDefaultPii: false`, and its comment says why: a major
 * bump is when an inherited default changes underneath you, silently and with
 * green CI. That instinct was right and the pin does not survive the bump it
 * was written about.
 *
 * In `@sentry/nextjs` v11 `sendDefaultPii` is **removed** — "not deprecated,
 * not honored, not present" — and an unset `dataCollection` collects
 * everything by default: `userInfo`, `cookies`, all `httpBodies`,
 * `databaseQueryData`, `genAI` inputs/outputs, `graphQL` document/variables.
 *
 * Measured on #2980, the live v11 bump: **`Typecheck` passes.** The removed
 * option is still type-accepted, so the compiler says nothing, the build is
 * green, and the diff touches no privacy code. Nothing in this repo would have
 * surfaced it. That is what this guard is for.
 *
 * ── Why the DECLARED version, not the installed one ──────────────────
 *
 * The major comes from `package.json`, not `node_modules`. An installed tree
 * drifts from the lockfile (this repo has been bitten by that), which would
 * make the guard's verdict depend on whoever ran `npm ci` last. Reading the
 * manifest makes the requirement flip in the SAME DIFF as the bump: raising the
 * dependency to `^11` turns this red until `dataCollection` is configured.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const SENTRY = path.join(ROOT, 'src/lib/observability/sentry.ts');

/**
 * Comments MASKED. The docblock above `sendDefaultPii` names `dataCollection`
 * and quotes the v11 option list, so an unmasked read would let prose satisfy
 * every assertion below — the failure mode `codeOf` exists for.
 */
const source = () => codeOf(fs.readFileSync(SENTRY, 'utf8'));

/** Declared major of `@sentry/nextjs`, from the manifest. */
function declaredMajor(): number {
    const pkg = JSON.parse(
        fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const range = pkg.dependencies?.['@sentry/nextjs'];
    if (!range) throw new Error('@sentry/nextjs is not a declared dependency');
    const m = /(\d+)\./.exec(range);
    if (!m) throw new Error(`cannot read a major from "${range}"`);
    return Number(m[1]);
}

describe('the Sentry privacy posture is pinned, not inherited', () => {
    it('has an init call to check (positive control)', () => {
        // Without this, a renamed file or a moved init would make the
        // assertions below vacuous — and two of them are negatives.
        const src = source();
        expect(src).toContain('Sentry.init(');
        expect(src.length).toBeGreaterThan(500);
    });

    it('declares a readable @sentry/nextjs major', () => {
        expect(declaredMajor()).toBeGreaterThanOrEqual(10);
    });

    it('pins the posture with the option its OWN major actually honours', () => {
        const src = source();
        const major = declaredMajor();

        if (major <= 10) {
            // v10: `sendDefaultPii` is the control and its default is
            // restrictive. Pinned anyway, so the posture is a decision.
            expect(src).toMatch(/sendDefaultPii:\s*false/);
            return;
        }

        // v11+: `sendDefaultPii` is gone and an unset `dataCollection`
        // collects everything. The two axes `beforeSend` cannot reach are
        // asserted by name, because those are the ones that would ship
        // silently — `userInfo` carries identity beyond the `ip_address` that
        // `beforeSend` deletes, and nothing anywhere scrubs query data.
        expect(src).toMatch(/dataCollection:\s*\{/);
        expect(src).toMatch(/userInfo:\s*false/);
        expect(src).toMatch(/databaseQueryData:\s*false/);
        expect(src).toMatch(/cookies:\s*false/);
    });

    it('does NOT rely on a removed option once the major has moved past it', () => {
        // The inert-control case, stated directly: `sendDefaultPii: false`
        // still typechecks under v11 and does nothing. Leaving it there reads
        // as a privacy control to every future reader of this file.
        if (declaredMajor() <= 10) return;
        expect(source()).not.toMatch(/sendDefaultPii:/);
    });

    it('keeps the identity scrubber in beforeSend regardless of major', () => {
        // Belt-and-braces, and independent of which option governs: an
        // `ip_address` is personal data under GDPR Art 4(1) and this is a
        // compliance product.
        expect(source()).toMatch(/delete event\.user\.ip_address/);
    });

    it('detects a posture that is merely DESCRIBED, not set (regression proof)', () => {
        // The assertions above read masked code, so prove the masking is what
        // makes them meaningful: a file that only mentions the options in a
        // comment must not satisfy them.
        const commentOnly = codeOf(`
            /* dataCollection: { userInfo: false, databaseQueryData: false } */
            // sendDefaultPii: false
            Sentry.init({ dsn });
        `);
        expect(commentOnly).not.toMatch(/userInfo:\s*false/);
        expect(commentOnly).not.toMatch(/sendDefaultPii:\s*false/);
    });
});
