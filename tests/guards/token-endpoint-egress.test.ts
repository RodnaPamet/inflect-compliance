/**
 * Every OAuth token exchange goes through the resilient fetch, wherever it lives.
 *
 * ## Why this exists alongside the integrations guard
 *
 * `integrations-bounded-fetch-coverage.test.ts` scans a PATH —
 * `src/app-layer/integrations/**`. That axis turned out to be wrong.
 * `src/lib/auth/refresh.ts` performs the Microsoft and Google refresh-token
 * exchanges, is the real POST behind `sharepoint/token.ts`'s refresh, and sits
 * outside that tree — so it used the bare global `fetch` with nothing to catch
 * it. A grep of the provider subtree for `method: 'POST'` also misses it,
 * because the call is delegated out of the layer.
 *
 * So this guard selects by what the code DOES rather than where it sits: any
 * file that talks to a known OAuth token endpoint must not reach the unbounded
 * global fetch.
 *
 * ## What is actually at stake
 *
 * Three things, and the third is the one that hides:
 *
 *   - no deadline — a hung token endpoint stalls the sync indefinitely;
 *   - no 429 handling — a throttle surfaces as a generic failure, which the
 *     queue answers with three full re-syncs;
 *   - no classification — `resilientFetch` is what turns a 401/403 into
 *     `IntegrationAuthError`, and `markAuthFailure` branches on exactly that
 *     class. Through the bare global fetch, a genuinely revoked credential
 *     comes back as an anonymous `Error` and the connection keeps rendering as
 *     healthy.
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'src');

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p));
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
    }
    return out;
}

const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Known OAuth2 token endpoints. Matched against comment-stripped source, so a
 * docblock discussing one does not enrol the file.
 */
const TOKEN_ENDPOINT = /oauth2\.googleapis\.com\/token|login\.microsoftonline\.com|\/oauth2\/v2\.0\/token|\/ccx\/oauth2\//;

/** Same shapes the integrations guard rejects — kept deliberately in sync. */
const UNBOUNDED =
    /(\?\?\s*(globalThis\.)?fetch\b)|(=\s*(globalThis\.)?fetch\b)|(\bawait\s+fetch\s*\()/;

const ALLOWED: Record<string, string> = {
    // none — every token exchange in the tree routes through resilientFetch.
};

describe('OAuth token exchanges do not reach the global fetch', () => {
    const files = walk(SRC);
    const tokenFiles = files.filter((f) =>
        TOKEN_ENDPOINT.test(stripComments(fs.readFileSync(f, 'utf8'))),
    );

    it('sanity — token endpoints were actually found', () => {
        // Selecting zero files would make every assertion below vacuous, which
        // is the failure mode this whole suite keeps running into.
        expect(tokenFiles.length).toBeGreaterThanOrEqual(3);
    });

    it('none of them default to, or directly call, the unbounded fetch', () => {
        const offenders = tokenFiles
            .map((f) => path.relative(process.cwd(), f))
            .filter((rel) => !(rel in ALLOWED))
            .filter((rel) =>
                UNBOUNDED.test(stripComments(fs.readFileSync(path.join(process.cwd(), rel), 'utf8'))),
            );

        expect({ offenders }).toEqual({ offenders: [] });
    });

    it('covers src/lib/auth/refresh.ts specifically, the file that motivated this', () => {
        // Named explicitly: if it is ever moved or renamed, this fails rather
        // than silently dropping out of the selection.
        const rel = tokenFiles.map((f) => path.relative(process.cwd(), f));
        expect(rel).toContain('src/lib/auth/refresh.ts');
    });
});
