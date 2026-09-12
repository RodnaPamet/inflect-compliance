/**
 * Every leaver outcome must have a badge colour chosen for it.
 *
 * WHY THIS GUARD EXISTS, AND WHY A TYPE DOES NOT DO THE JOB. `OUTCOME_VARIANT`
 * in `LeaverPassesClient.tsx` is `Record<string, StatusBadgeVariant>` and the
 * render falls through `?? 'neutral'`. That fall-through is deliberate and must
 * stay: a pass row written by an older deployment can carry an outcome this
 * build has never heard of, and rendering it grey is better than crashing the
 * page an operator is reading mid-incident.
 *
 * The cost of that tolerance is that ADDING an outcome cannot fail to compile.
 * It draws the same grey as `ALREADY_DISABLED` — the "nothing to do" colour —
 * while every sibling refusal draws `warning`. #2498 shipped exactly that: a new
 * `REFUSED_UNMEASURED`, raised when the live directory contradicts the
 * observation the blast-radius breaker measured, rendered in the colour that
 * means nothing happened. Under the #2499 chain EVERY candidate takes that
 * refusal, so the page would have shown a whole run of them and read as quiet.
 * The client's own docblock names the pattern: "the quietest possible
 * presentation of the loudest possible outcome, on the one page an operator
 * watches during a proving run."
 *
 * Tightening the map to `Record<DisableOutcome, …>` would say the same thing at
 * compile time, but `DisableOutcome` lives in a server usecase and importing it
 * into a client component drags that module graph into the bundle — the cost
 * #2496 spent a whole leaf-module extraction avoiding. A source scan pays
 * nothing at runtime and fails just as loudly.
 *
 * THE POPULATION IS DERIVED, NOT LISTED. Both sides are read from source, so a
 * retired outcome updates this check rather than dating it. If you are here
 * because it went red: pick a colour deliberately. `neutral` is a legitimate
 * choice — `ALREADY_DISABLED` earns it — but it has to be chosen.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { declarationOf } from '../helpers/source-blocks';

const ROOT = join(__dirname, '..', '..');
const USECASE = join(ROOT, 'src/app-layer/usecases/identity-disable-account.ts');
const CLIENT = join(
    ROOT,
    'src/app/t/[tenantSlug]/(app)/admin/identity-leaver-passes/LeaverPassesClient.tsx',
);

/**
 * The union members of `DisableOutcome`, read from its declaration.
 *
 * `declarationOf` from source-blocks cannot be used here: it matches
 * `const <name>` only and throws on a type alias. So this bounds the slice
 * itself — and BOUNDS IT, rather than reading to EOF, for the reason that
 * helper's own docstring gives: an unbounded slice stays green when its target
 * is gutted, as long as some later declaration still mentions the tokens being
 * matched. The alias ends at the first line beginning in column zero with
 * something that is not a union arm (`|`) or a comment (`/`, `*`).
 */
function declaredOutcomes(): string[] {
    const src = readFileSync(USECASE, 'utf8');
    const start = src.search(/^export type DisableOutcome\b/m);
    if (start < 0) throw new Error('DisableOutcome declaration not found');
    const rest = src.slice(start);
    const endRel = rest.search(/\n(?![ \t])(?![|/*])\S/);
    if (endRel < 0) throw new Error('DisableOutcome declaration is unbounded');
    // Comments stripped BEFORE matching: the arms carry docblocks, and prose
    // quoting an outcome name must not become a member.
    const decl = rest.slice(0, endRel).replace(/\/\*[\s\S]*?\*\//g, '');
    const members = [...decl.matchAll(/\|\s*'([A-Z_]+)'/g)].map((m) => m[1]);
    return [...new Set(members)].sort();
}

/** The keys `OUTCOME_VARIANT` assigns a colour to. */
function mappedOutcomes(): string[] {
    const block = declarationOf(readFileSync(CLIENT, 'utf8'), 'OUTCOME_VARIANT');
    const keys = [...block.matchAll(/^\s*([A-Z_]+):\s*'/gm)].map((m) => m[1]);
    return [...new Set(keys)].sort();
}

describe('every leaver outcome has a badge colour chosen for it', () => {
    it('reads a non-empty population from BOTH sides', () => {
        // The positive control, and not ceremony: both halves below are
        // set-difference assertions, and a difference against an empty set is
        // empty. A regex that stopped matching — a reformat, a rename, a union
        // rewritten as an enum — would leave every assertion in this file
        // passing while checking nothing.
        expect(declaredOutcomes().length).toBeGreaterThan(5);
        expect(mappedOutcomes().length).toBeGreaterThan(5);
        // And they must be the same KIND of thing: if the two extractors drifted
        // apart, the overlap would collapse even though both are non-empty.
        const overlap = declaredOutcomes().filter((o) => mappedOutcomes().includes(o));
        expect(overlap.length).toBeGreaterThan(5);
    });

    it('maps every declared outcome', () => {
        const unmapped = declaredOutcomes().filter((o) => !mappedOutcomes().includes(o));
        // Named, not counted — the failure message has to say WHICH outcome will
        // render grey, or whoever reads it has to go and diff two lists by hand.
        expect(unmapped).toEqual([]);
    });

    it('maps nothing that is not a declared outcome', () => {
        // The other direction, and it is not symmetry for its own sake: a stale
        // key is a colour chosen for an outcome that can no longer occur, which
        // is how a map keeps looking maintained while the thing it describes
        // moves. Same reasoning as the "no stale entries" case every exemption
        // list in this repo carries.
        const stale = mappedOutcomes().filter((o) => !declaredOutcomes().includes(o));
        expect(stale).toEqual([]);
    });

    it('gives the contradiction refusal the same weight as its sibling refusals', () => {
        // The specific regression. REFUSED_UNMEASURED means the live directory
        // disagreed with the observation the breaker measured — the loudest
        // thing this page can say short of a failure — and it shipped drawing
        // the "nothing to do" grey. Pinned against its siblings rather than
        // against the literal 'warning', so a deliberate palette change moves
        // all three together instead of silently re-quieting this one.
        const block = declarationOf(readFileSync(CLIENT, 'utf8'), 'OUTCOME_VARIANT');
        const variantOf = (key: string) =>
            new RegExp(`^\\s*${key}:\\s*'([a-z]+)'`, 'm').exec(block)?.[1];

        expect(variantOf('REFUSED_UNMEASURED')).toBe(variantOf('REFUSED_TARGET'));
        expect(variantOf('REFUSED_UNMEASURED')).toBe(variantOf('REFUSED_PROTECTED'));
        expect(variantOf('REFUSED_UNMEASURED')).not.toBe(variantOf('ALREADY_DISABLED'));
    });
});
