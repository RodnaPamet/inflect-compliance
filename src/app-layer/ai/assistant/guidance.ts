/**
 * Keeping prose guidance inside the real IA (#3845).
 *
 * The route table in `./nav-routes` goes into the system prompt so the model
 * has the actual navigation in front of it. This module is the second half of
 * that bargain: the check on the way OUT, for the case where the model names
 * a path anyway. A prompt is an instruction, not a guarantee, and the failure
 * being prevented here — a confidently described screen that does not exist —
 * is one the user cannot distinguish from their own mistake.
 */

import { isKnownAssistantRoute, normaliseRoute } from './nav-routes';

/**
 * Path-shaped tokens in free prose.
 *
 * Deliberately broad on what counts as a candidate and strict on what counts
 * as KNOWN, because the two errors are not symmetric: a missed fabrication
 * ships a wrong path to the user, while a false positive only costs the
 * assistant a sentence it could have said.
 *
 * The leading `(?<![A-Za-z0-9])` is load-bearing and was added because the
 * test caught it: without it, "and/or" yields `/or` and "read/write" yields
 * `/write`, so ordinary prose gets refused for naming a route it never named.
 * A slash that continues a word is not the start of a path. ("24/7" was
 * already safe -- `/7` does not start with a letter.)
 *
 * A trailing `[a-z0-9-]` class excludes the sentence-final punctuation that
 * would otherwise become part of the path.
 */
const PATH_TOKEN =
    /(?<![A-Za-z0-9])\/(?:t\/[A-Za-z0-9_-]+\/)?[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)*/g;

/**
 * Candidate paths in a block of prose, normalised and de-duplicated.
 *
 * Exported for the test, which asserts the extractor can see a path at all —
 * an extractor that silently matched nothing would make every "no unknown
 * routes" assertion below pass vacuously.
 */
export function pathTokensIn(text: string): string[] {
    if (typeof text !== 'string' || text === '') return [];
    const out = new Set<string>();
    for (const raw of text.match(PATH_TOKEN) ?? []) {
        const n = normaliseRoute(raw);
        if (n !== null && n !== '/') out.add(n);
    }
    return [...out].sort();
}

/**
 * The paths in this text that the nav table does not contain.
 *
 * A sub-path of a real route counts as unknown, which is the point: the table
 * can vouch for `/controls`, and cannot vouch for `/controls/missing-evidence`
 * being a page rather than a 404.
 */
export function unknownRoutesIn(text: string): string[] {
    return pathTokensIn(text).filter((p) => !isKnownAssistantRoute(p));
}

/**
 * What the user sees instead of an invented path.
 *
 * It names the problem rather than apologising, and it does NOT repeat the
 * fabricated path back as though it were a suggestion — quoting it is how a
 * wrong path still ends up in front of the user. The routes it CAN speak
 * about are already reachable in the sidebar, so the fallback is to say that
 * rather than to guess again.
 */
export const GUIDANCE_ROUTE_REFUSAL =
    'I started to describe a screen I cannot verify exists, so I have stopped ' +
    'rather than send you looking for it. Everything I can point you at is in ' +
    'the sidebar on the left.';

/**
 * Is this answer safe to show as guidance?
 *
 * Returns the unknown routes rather than a bare boolean so the caller can log
 * WHICH path was invented — a refusal with no record of what triggered it
 * cannot be investigated, and "the assistant refused" is the kind of report
 * that arrives without a reproduction.
 */
export interface GuidanceVerdict {
    readonly ok: boolean;
    readonly unknownRoutes: readonly string[];
}

export function checkGuidanceRoutes(text: string): GuidanceVerdict {
    const unknownRoutes = unknownRoutesIn(text);
    return { ok: unknownRoutes.length === 0, unknownRoutes };
}
