/**
 * A scheduled job's `description` is operator-facing text. It must not assert a
 * bound that is actually a per-tenant, mutable setting.
 *
 * WHAT THIS CAUGHT
 * ────────────────
 * `identity-leaver-dispatch` carried, in its `description` field:
 *
 *     "Clamped at DRY_RUN: it decides what a disable would do and writes
 *      nothing to any directory."
 *
 * True when written. #2187 then raised `LEAVER_MAX_MODE` from `DRY_RUN` to
 * `AUTOMATIC` (2026-08-30) and the string stayed. For the days that followed,
 * an operator reading job config to answer "can this job touch a real
 * directory?" got **no** from a field literally named `description`, while the
 * code's answer was "whatever the tenant's `identityLeaverMode` says". Two more
 * copies of the same dead claim sat in `executor-registry.ts` and
 * `auth.prisma`.
 *
 * WHY THIS GUARD IS NOT PROSE-GATING
 * ──────────────────────────────────
 * It does not check that any sentence is TRUE — a guard cannot know that, and
 * `docs/`-style "does the file mention X" checks verify mention rather than
 * accuracy (see the epic-ratchet lifecycle note in CLAUDE.md).
 *
 * It checks something structural and decidable instead: **a static string
 * cannot state a per-tenant value.** `identityLeaverMode` is stored per tenant
 * and changes under an operator's hand; any constant that names a rung as the
 * bound is therefore wrong for some tenant the moment it is written, and wrong
 * for every tenant as soon as the clamp moves. The rung names come from
 * `LADDER` itself, so retiring or adding a rung updates this guard's alphabet
 * automatically rather than leaving it pinned to a vocabulary that moved on.
 *
 * Naming a rung to describe the DEFAULT ("tenants default to DISABLED") states
 * a schema fact, not a bound, so the check looks for the claim shape —
 * clamp/limit wording next to a rung — rather than banning the words outright.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LADDER } from '@/lib/identity/write-ladder';

const ROOT = join(__dirname, '..', '..');
const SCHEDULES = join(ROOT, 'src/app-layer/jobs/schedules.ts');

/** Words that turn a rung name into an assertion about what the job MAY do. */
const BOUND_WORDS = ['clamp', 'clamped', 'limited to', 'capped at', 'restricted to', 'only ever'];

function descriptions(): { name: string; description: string }[] {
    const src = readFileSync(SCHEDULES, 'utf8');
    const out: { name: string; description: string }[] = [];
    // Each entry is `name: '<job>',` … `description: '<text>',` within one object literal.
    const re = /name:\s*'([^']+)'[\s\S]*?description:\s*'((?:[^'\\]|\\.)*)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.push({ name: m[1], description: m[2] });
    return out;
}

describe('scheduled job descriptions do not assert a per-tenant bound', () => {
    it('finds the schedule descriptions at all', () => {
        const found = descriptions();
        // A rewrite that changes the literal shape must not silently empty this
        // guard's population — an absent finding and a clean finding look the same.
        expect(found.length).toBeGreaterThanOrEqual(10);
        expect(found.map((d) => d.name)).toContain('identity-leaver-dispatch');
    });

    it('no description claims a write-ladder rung as the bound on what it may do', () => {
        const offenders = descriptions().filter(({ description }) => {
            const lower = description.toLowerCase();
            const namesRung = LADDER.some((rung) => description.includes(rung));
            const claimsBound = BOUND_WORDS.some((w) => lower.includes(w));
            return namesRung && claimsBound;
        });

        expect(offenders.map((o) => `${o.name}: ${o.description}`)).toEqual([]);
    });

    it('the leaver dispatch description says the mode is the tenant\'s, not a constant', () => {
        const leaver = descriptions().find((d) => d.name === 'identity-leaver-dispatch');
        expect(leaver).toBeDefined();
        // Positive half: it is not enough to have deleted the false claim — the
        // question an operator brings to this field still needs an answer.
        expect(leaver!.description).toMatch(/identityLeaverMode/);
    });
});
