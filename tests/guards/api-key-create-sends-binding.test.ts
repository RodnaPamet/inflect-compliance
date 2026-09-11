/**
 * THE API-KEY CREATE FORM ACTUALLY SENDS THE BINDING.
 *
 * ── THE DEFECT THIS EXISTS FOR, AND WHY A BACKEND TEST CANNOT SEE IT ────────
 *
 * `createApiKey` has accepted `agentId` and `maxAutonomyLevel` since the agent
 * register shipped. It validates them properly: it refuses a ceiling with no
 * agent, refuses a ceiling above the agent's own level, and resolves the agent
 * under RLS. The route's zod schema accepts both. The list usecase returns both.
 *
 * And the form sent `{ name, scopes, expiresAt }`.
 *
 * So every credential the product minted through its own UI stood at
 * `no_binding` — and under `requireRegisteredAgent` that is not a cosmetic gap,
 * it is a key the tool boundary refuses. Every backend test passed throughout,
 * because every backend test called the usecase directly with the field the UI
 * was not sending. The integration suite proved the API could do the thing;
 * nothing proved the product ever asked it to.
 *
 * That is the gap this file closes, and it is the reason it is a SOURCE scan
 * rather than another usecase test: the defect lives in the request body, and
 * the request body is the one thing a usecase test necessarily supplies for
 * itself.
 *
 * ── WHY NOT A RENDERED TEST ─────────────────────────────────────────────────
 *
 * A rendered test would have to drive the form, stub `fetch`, and assert on the
 * captured body — which is a better test and a much larger one, and it would
 * still pass if someone added a second create path that omitted the field. This
 * asserts the property directly at every call site that posts to the endpoint.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';
import { repoFiles, repoRelative } from '../helpers/repo-files';

const ROOT = path.resolve(__dirname, '../..');

/** Every `fetch(...)` to the api-keys endpoint with `method: 'POST'`, by file. */
function createCallSites(): Array<{ rel: string; body: string }> {
    const sites: Array<{ rel: string; body: string }> = [];

    for (const abs of repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })) {
        // COMMENTS STRIPPED — a docstring that mentions `agentId` must not be
        // able to satisfy a guard about what the request body contains. That is
        // exactly the shape this file is written against: prose describing a
        // binding the code did not send.
        const code = codeOf(fs.readFileSync(abs, 'utf8'));
        if (!code.includes("'/admin/api-keys'")) continue;
        if (!code.includes("method: 'POST'")) continue;

        // The body literal: from `body: JSON.stringify({` to its closing `})`.
        const start = code.indexOf('body: JSON.stringify({');
        if (start === -1) continue;
        const end = code.indexOf('})', start);
        sites.push({ rel: repoRelative(abs), body: code.slice(start, end) });
    }
    return sites;
}

const sites = createCallSites();

/**
 * The call sites MISSING a field, as repo-relative PATHS.
 *
 * Every assertion below takes one of these lists as its subject rather than a
 * file's text, and that is not stylistic. `assertion-needle-uniqueness-ratchet`
 * counts assertions whose subject is a whole-file read it cannot follow — a path
 * built in a loop and a needle checked against raw source are both blind spots,
 * and a guard that grows that set is trading one kind of coverage for another.
 * Filtering first moves the claim off the file text entirely, and gives a
 * failure that NAMES the offending file instead of one that says a string was
 * absent from a blob.
 */
function withoutField(field: string): string[] {
    return sites.filter((s) => !s.body.includes(field)).map((s) => s.rel).sort();
}

describe('the scan found the create call at all', () => {
    it('locates at least one POST to /admin/api-keys', () => {
        // Without this, every assertion below is vacuous over an empty list —
        // which is how a guard reports total compliance with nothing.
        expect(sites.length).toBeGreaterThanOrEqual(1);
    });

    it('the body it captured is the real one', () => {
        // Positive control: the fields that were ALWAYS sent must be present in
        // what the extractor pulled out. If these stop matching, the extractor
        // has drifted and the agentId assertion below means nothing.
        //
        // The SUBJECT is a list of PATHS, not a file's text — see the note on
        // `withoutField` below.
        expect(withoutField('name:')).toEqual([]);
        expect(withoutField('scopes:')).toEqual([]);
    });

    it('the endpoint the scan keys on still exists', () => {
        expect(
            fs.existsSync(path.join(ROOT, 'src/app/api/t/[tenantSlug]/admin/api-keys/route.ts')),
        ).toBe(true);
    });
});

describe('every create call sends the agent binding', () => {
    it('every call site posts agentId', () => {
        const offenders = withoutField('agentId');
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.join(', ')} creates an API key without sending \`agentId\`.\n\n` +
                    `The API has always accepted it. A credential minted without it stands ` +
                    `at no_binding, and a tenant that enforces agent registration refuses ` +
                    `it at the tool boundary — so this mints keys that cannot work, and ` +
                    `nothing else in the suite notices.`,
            );
        }
        expect(offenders).toEqual([]);
    });

    it('every call site posts maxAutonomyLevel', () => {
        // The ceiling is optional in the type but not optional to OFFER: it is
        // the only way a credential can narrow its agent's authority, and a form
        // that cannot express it makes every key as powerful as the agent it
        // acts as.
        expect(withoutField('maxAutonomyLevel')).toEqual([]);
    });
});
