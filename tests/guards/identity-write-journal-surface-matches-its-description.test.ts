/**
 * What `CLAUDE.md` says the identity-write-journal surface IS, against what it
 * is (#5570).
 *
 * ═══ THE FAILURE THIS EXISTS TO CATCH ═══
 *
 * The spec described the surface as two routes, both read-only, and gave the
 * reason as a decision rather than an omission:
 *
 *     Both are read-only, and that is a decision rather than an unfinished
 *     half: `DirectoryWriter` declares no `enable()` verb, so re-applying a
 *     captured prior state is an act somebody performs in the customer's own
 *     directory, holding the state this surface hands them.
 *
 * By then there were FOUR routes, one of them `restorable/[accountId]` with a
 * POST that reaches `usecases/identity-restore-account.ts` and PATCHes
 * `accountEnabled: true` into a customer's directory. The verb half of the
 * sentence stayed true — there is no `enable()` — which is exactly why this
 * went unnoticed: the premise was checkable and correct, and the conclusion
 * drawn from it was neither.
 *
 * That matters more than ordinary doc rot. The same file calls this subsystem
 * "the highest-blast-radius capability in the product", so somebody auditing
 * what can write to a customer's directory from this surface read a specific,
 * confident sentence saying nothing could, and stopped. `CLAUDE.md` records the
 * cost of precisely that, about precisely this subsystem: "The sentence was
 * specific enough to be believed and to stop a reader checking."
 *
 * ═══ WHY THE CHECK IS A PRESENCE, NOT AN ABSENCE ═══
 *
 * The obvious guard — "no paragraph about this surface may say read-only" —
 * fails against the correction itself, which QUOTES the old wording so the
 * change is legible. Three guards in this backlog were satisfied by my own
 * prose doing that. So the rule is the other way round: a paragraph that
 * mentions the surface and the words "read-only" must also carry the negation,
 * and the correction must name the route that makes it so.
 *
 * It is also two-way. Should the POST ever be removed, the first test fails on
 * the stale correction rather than leaving the doc describing a write that no
 * longer exists.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

const JOURNAL_PREFIX = 'src/app/api/t/[tenantSlug]/admin/identity-write-journal';
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Exported HTTP methods of one route file. */
function methodsOf(rel: string): string[] {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const found = new Set<string>();
    for (const m of src.matchAll(/^export\s+(?:const|async function)\s+(GET|POST|PUT|PATCH|DELETE)\b/gm)) {
        found.add(m[1]);
    }
    return [...found].sort();
}

const routes = repoRelativeFiles()
    .filter((f) => f.startsWith(`${JOURNAL_PREFIX}/`) || f === `${JOURNAL_PREFIX}/route.ts`)
    .filter((f) => f.endsWith('/route.ts'))
    .sort();

const surface = new Map(routes.map((r) => [r.slice(JOURNAL_PREFIX.length + 1), methodsOf(r)]));
const mutatingRoutes = [...surface.entries()].filter(([, ms]) => ms.some((m) => MUTATING.includes(m as never)));

/** The blank-line-separated paragraphs of CLAUDE.md that mention this surface. */
function journalParagraphs(): string[] {
    const md = fs.readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
    // `identity-write-journal` rather than the `admin/`-prefixed path: the
    // paragraphs spell it both ways, and matching only the longer form made the
    // correction invisible to this guard the first time round.
    return md.split(/\n\s*\n/).filter((p) => p.includes('identity-write-journal'));
}

describe('the journal surface census', () => {
    it('is exactly these routes and these methods', () => {
        // Pinned so ADDING a mutating route anywhere under this prefix is a
        // reviewed diff that lands next to the sentence describing it.
        expect(Object.fromEntries(surface)).toEqual({
            'route.ts': ['GET'],
            '[journalId]/route.ts': ['GET'],
            'unsettled/route.ts': ['GET'],
            'restorable/[accountId]/route.ts': ['GET', 'POST'],
        });
    });

    it('the population is real — four routes, found through git', () => {
        // Without this the census could be empty and every assertion below
        // would pass over nothing.
        expect(routes).toHaveLength(4);
        expect(mutatingRoutes.map(([r]) => r)).toEqual(['restorable/[accountId]/route.ts']);
    });
});

describe('CLAUDE.md describes that surface truthfully', () => {
    it('finds the paragraphs at all', () => {
        expect(journalParagraphs().length).toBeGreaterThan(0);
    });

    it('says the surface is NOT read-only, while a mutating route exists', () => {
        const paragraphs = journalParagraphs();
        if (mutatingRoutes.length === 0) {
            // The inverse direction: with the POST gone, a doc still insisting
            // the surface is not read-only would be the new wrong sentence.
            expect(paragraphs.some((p) => p.includes('not read-only'))).toBe(false);
            return;
        }
        expect(paragraphs.some((p) => p.includes('not read-only'))).toBe(true);
        // And it names the route that makes it so, rather than hedging.
        expect(paragraphs.some((p) => p.includes('restorable'))).toBe(true);
    });

    it('no paragraph calls the surface read-only without the negation beside it', () => {
        const offenders = journalParagraphs()
            .filter((p) => p.includes('read-only') && !p.includes('not read-only'))
            .map((p) => p.slice(0, 120));
        expect(offenders).toEqual([]);
    });
});

describe('the DirectoryWriter verb set', () => {
    /** Member names declared on the interface, `?` kept so optionality shows. */
    function directoryWriterMembers(): string[] {
        const src = fs.readFileSync(
            path.join(REPO_ROOT, 'src/app-layer/usecases/identity-disable-account.ts'),
            'utf8',
        );
        const start = src.indexOf('export interface DirectoryWriter {');
        expect(start).toBeGreaterThan(-1);
        const body = src.slice(start, src.indexOf('\n}', start));
        return [
            ...new Set(
                [...body.matchAll(/^\s{4}(?:readonly\s+)?([a-zA-Z]+)(\??)[(:]/gm)].map((m) => `${m[1]}${m[2]}`),
            ),
        ].sort();
    }

    it('is exactly what the docs reason about', () => {
        // `restore?` being here is the fact #5570 turned on. Pinning the set
        // means a future "declares no X verb" claim can be checked against it,
        // and adding a verb is a reviewed diff.
        expect(directoryWriterMembers()).toEqual([
            'disable',
            'preflight?',
            'provider',
            'readState',
            'restore?',
            'selfAccountIds?',
        ]);
    });

    it('declares no enable verb — the half of the old sentence that was true', () => {
        // Kept because the sentence is still quoted in the corrected
        // paragraph, and a reader should be able to confirm the premise rather
        // than take the correction's word for it.
        expect(directoryWriterMembers()).not.toContain('enable');
        expect(directoryWriterMembers()).not.toContain('enable?');
    });
});
