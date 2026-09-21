/**
 * Guardrail — the JWT membership payload stays bounded.
 *
 * The NextAuth JWT is a fixed-size credential carried in a cookie, not
 * a data store. The `jwt` callback in `src/auth.ts` embeds the user's
 * tenant + org memberships so the Edge middleware can authorize a slug
 * with no DB hit — but a user in very many tenants would otherwise
 * grow the cookie without bound (a latent overflow bug).
 *
 * The fix (2026-05-21): both membership arrays are capped at
 * `MAX_JWT_MEMBERSHIPS` and the over-cap case is flagged with
 * `membershipsTruncated` / `orgMembershipsTruncated` so the middleware
 * gate can defer a slug-miss to the authoritative server-side check.
 *
 * This ratchet fails CI if a future edit:
 *   - removes the `.slice(0, MAX_JWT_MEMBERSHIPS)` cap from either
 *     array (re-introducing the unbounded payload), or
 *   - bumps `MAX_JWT_MEMBERSHIPS` past a sane ceiling (defeating the
 *     bound by making the "cap" effectively infinite), or
 *   - drops the truncation flags the middleware relies on.
 *
 * The checks scan the raw source: every pattern asserted here
 * (`export const MAX_JWT_MEMBERSHIPS = <n>`, `.slice(0, …)`) is
 * executable-code syntax that never appears in prose, so no
 * comment-stripping is needed.
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const AUTH_TS = path.resolve(__dirname, '../../src/auth.ts');

const SLICE_RE = /\.slice\(\s*0\s*,\s*MAX_JWT_MEMBERSHIPS\s*\)/g;

/**
 * Generous ceiling. The cap exists to bound the cookie; even 200 fat
 * entries is "bounded", but anything past this is a conscious decision
 * that must edit this guardrail (and explain why) in the same PR.
 */
const MAX_REASONABLE_CAP = 200;

describe('JWT membership payload is bounded', () => {
    const code = codeOf(fs.readFileSync(AUTH_TS, 'utf-8'));

    test('MAX_JWT_MEMBERSHIPS is defined and within a sane ceiling', () => {
        const m = /export const MAX_JWT_MEMBERSHIPS\s*=\s*(\d+)/.exec(code);
        expect(m).not.toBeNull();
        const cap = Number(m![1]);
        expect(cap).toBeGreaterThan(0);
        expect(cap).toBeLessThanOrEqual(MAX_REASONABLE_CAP);
    });

    test('both membership arrays are capped with .slice(0, MAX_JWT_MEMBERSHIPS)', () => {
        const sliceCount = (code.match(SLICE_RE) ?? []).length;
        // One for tenant memberships, one for org memberships.
        expect(sliceCount).toBeGreaterThanOrEqual(2);
    });

    test('the truncation flags the middleware gate relies on are present', () => {
        expect(code).toContain('membershipsTruncated');
        expect(code).toContain('orgMembershipsTruncated');
    });

    // ─── Regression proof — the detector catches an un-capped payload ───

    test('detector flags an auth.ts that maps memberships without the cap', () => {
        const mutated = code.replace(SLICE_RE, '');
        expect((mutated.match(SLICE_RE) ?? []).length).toBe(0);
    });
});
