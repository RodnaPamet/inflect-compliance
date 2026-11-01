/**
 * #2861 slice one — the external-write mode ladder.
 *
 * The assertions that matter here are the REFUSALS, so each one names the
 * failure direction it defends. A ladder whose every test asserts a permitted
 * move is a ladder with no teeth: the only interesting question about an
 * authority gate is what it says no to.
 */
import {
    LADDER,
    RETIRED_MODES,
    MODE_MIN_DAYS,
    MODE_MIN_EVIDENCE,
    coerceStoredMode,
    isAboveClamp,
    permitsDispatch,
    recordsIntentOnly,
    refusesEveryWrite,
    requiresHumanApproval,
    refusalForMove,
    classifyMove,
    type ExternalWriteMode,
} from '@/lib/integrations/external-write-ladder';

const NOW = new Date('2026-09-26T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('external write ladder — shape', () => {
    it('orders the rungs weakest first, and the index IS the ordering', () => {
        expect([...LADDER]).toEqual(['DISABLED', 'DRY_RUN', 'PROPOSE_ONLY', 'AUTOMATIC']);
        // Positive control: the assertions below are about ordering, so a
        // one-element ladder would make several of them vacuous.
        expect(LADDER.length).toBe(4);
    });

    it('marks exactly one rung as dispatching, one as intent-only, one as approval-routed, one as none of those', () => {
        const dispatching = LADDER.filter(permitsDispatch);
        const intentOnly = LADDER.filter(recordsIntentOnly);
        const approval = LADDER.filter(requiresHumanApproval);
        const refusing = LADDER.filter(refusesEveryWrite);
        expect(dispatching).toEqual(['AUTOMATIC']);
        expect(intentOnly).toEqual(['DRY_RUN']);
        expect(approval).toEqual(['PROPOSE_ONLY']);
        expect(refusing).toEqual(['DISABLED']);
        // DISABLED must do none of the three — the whole point of the default.
        expect(permitsDispatch('DISABLED')).toBe(false);
        expect(recordsIntentOnly('DISABLED')).toBe(false);
        expect(requiresHumanApproval('DISABLED')).toBe(false);
        // And the fourth predicate is false for every rung that DOES something,
        // so the four are a total partition of the ladder rather than four
        // independent opinions. #3872's offer-time withholding reads the fourth,
        // and a rung added without classifying it here would be offered a write
        // tool the dispatch may not have an arm for.
        for (const mode of LADDER.filter((m) => m !== 'DISABLED')) {
            expect(refusesEveryWrite(mode)).toBe(false);
        }
        expect(dispatching.length + intentOnly.length + approval.length + refusing.length).toBe(LADDER.length);
    });

    it('an unset or unrecognised stored rung reads as refusing every write', () => {
        // The fail-closed direction, through the read boundary rather than
        // asserted about the predicate alone: a connection with no rung recorded
        // has been granted no authority, so its write tools are withheld from
        // the offer exactly as a deliberately DISABLED one's are.
        for (const stored of [null, undefined, '', 'PROPOSE', 'AUTOMATIC_BUT_TYPOED', '__proto__']) {
            expect(refusesEveryWrite(coerceStoredMode(stored))).toBe(true);
        }
        // And the control: a real rung is not swept up by that.
        expect(refusesEveryWrite(coerceStoredMode('PROPOSE_ONLY'))).toBe(false);
    });

    it('requires evidence from every rung that can be widened off and produces something', () => {
        // DISABLED produces nothing by construction; AUTOMATIC is the top rung
        // so nothing is widened off it. Everything between must demand proof.
        const middle = LADDER.slice(1, -1);
        expect(middle.length).toBeGreaterThan(0);
        for (const rung of middle) {
            expect(MODE_MIN_EVIDENCE[rung]).toBeGreaterThan(0);
        }
    });
});

describe('coerceStoredMode — fails CLOSED', () => {
    it.each([...LADDER])('passes through the known rung %s', (rung) => {
        expect(coerceStoredMode(rung)).toBe(rung);
    });

    it.each([null, undefined, ''])('reads absence (%p) as DISABLED, not as a missing value', (v) => {
        expect(coerceStoredMode(v)).toBe('DISABLED');
    });

    it('reads a mode from a newer build as DISABLED rather than as permitted', () => {
        // The failure direction: isAboveClamp sorts an unknown to -1, which
        // reads as "not above the clamp" — permitted. Coercion is what stops a
        // row this build cannot understand from being treated as the widest
        // authority the caller allows.
        expect(coerceStoredMode('SOMETHING_FROM_THE_FUTURE')).toBe('DISABLED');
        expect(coerceStoredMode('automatic')).toBe('DISABLED'); // case matters
    });

    it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
        'does not return an inherited Object.prototype member for %s',
        (key) => {
            const out = coerceStoredMode(key);
            expect(typeof out).toBe('string');
            expect(LADDER as readonly string[]).toContain(out);
            expect(out).toBe('DISABLED');
        },
    );

    it('re-checks a RETIRED_MODES replacement against the ladder', () => {
        // The table is hand-written and empty today. The contract is that what
        // comes out is a rung whatever the table says, so a bad entry must not
        // escape. Proven by exercising the lookup path with a key not in it.
        expect(Object.keys(RETIRED_MODES)).toEqual([]);
        expect(coerceStoredMode('PROPOSE')).toBe('DISABLED');
    });
});

describe('isAboveClamp', () => {
    it('is strict, so an equal mode is not above its clamp', () => {
        expect(isAboveClamp('DRY_RUN', 'DRY_RUN')).toBe(false);
        expect(isAboveClamp('PROPOSE_ONLY', 'DRY_RUN')).toBe(true);
        expect(isAboveClamp('DRY_RUN', 'PROPOSE_ONLY')).toBe(false);
        expect(isAboveClamp('AUTOMATIC', 'DISABLED')).toBe(true);
    });
});

describe('refusalForMove — narrowing', () => {
    it.each([
        ['AUTOMATIC', 'DISABLED'],
        ['AUTOMATIC', 'PROPOSE_ONLY'],
        ['PROPOSE_ONLY', 'DRY_RUN'],
        ['DRY_RUN', 'DISABLED'],
    ] as Array<[ExternalWriteMode, ExternalWriteMode]>)(
        'never gates %s → %s, because revoking an authority must not be made to wait',
        (from, to) => {
            // No modeSince, no evidence — the hostile case for a gate, and the
            // one where an operator is most likely mid-incident.
            expect(refusalForMove({ mode: from, modeSince: null }, to, NOW)).toBeNull();
        },
    );

    it('treats a move to the same rung as permitted', () => {
        expect(refusalForMove({ mode: 'DRY_RUN', modeSince: null }, 'DRY_RUN', NOW)).toBeNull();
    });
});

describe('refusalForMove — widening', () => {
    it('refuses a two-rung jump and names the path', () => {
        const r = refusalForMove(
            { mode: 'DRY_RUN', modeSince: daysAgo(400), evidenceInWindow: 99 },
            'AUTOMATIC',
            NOW,
        );
        expect(r).toMatch(/one level at a time/);
        expect(r).toMatch(/DRY_RUN → PROPOSE_ONLY → AUTOMATIC/);
    });

    it('cannot reach AUTOMATIC from DRY_RUN however long the dwell, so approvals cannot be skipped', () => {
        // This is the sibling arrangement the module rejected, asserted as a
        // property: unattended external writes are unreachable without having
        // passed through the rung where humans approve them.
        for (const days of [0, 7, 365, 10_000]) {
            expect(
                refusalForMove(
                    { mode: 'DRY_RUN', modeSince: daysAgo(days), evidenceInWindow: 1_000 },
                    'AUTOMATIC',
                    NOW,
                ),
            ).not.toBeNull();
        }
    });

    it('refuses when the current rung has no recorded start', () => {
        expect(
            refusalForMove({ mode: 'DRY_RUN', modeSince: null, evidenceInWindow: 5 }, 'PROPOSE_ONLY', NOW),
        ).toMatch(/no recorded start/);
    });

    it('distinguishes "could not count" from zero', () => {
        // An unknown count is not evidence of absence. Reported as its own
        // refusal so nobody reads a probe failure as a satisfied gate.
        const r = refusalForMove(
            { mode: 'DRY_RUN', modeSince: daysAgo(30) },
            'PROPOSE_ONLY',
            NOW,
        );
        expect(r).toMatch(/could not look/);
    });

    it('refuses on missing evidence BEFORE complaining about days', () => {
        // Ordering matters: an operator who waited the week and ran nothing
        // should be told that, not sent away to wait again.
        const r = refusalForMove(
            { mode: 'DRY_RUN', modeSince: daysAgo(1), evidenceInWindow: 0 },
            'PROPOSE_ONLY',
            NOW,
        );
        expect(r).toMatch(/dry-run intents/);
        expect(r).not.toMatch(/days\. \d+ to go/);
    });

    it('refuses PROPOSE_ONLY → AUTOMATIC without approved proposals — the #2241 answer', () => {
        const r = refusalForMove(
            { mode: 'PROPOSE_ONLY', modeSince: daysAgo(90), evidenceInWindow: 0 },
            'AUTOMATIC',
            NOW,
        );
        expect(r).toMatch(/approved proposals/);
    });

    it('refuses while the dwell is unmet even with evidence', () => {
        const r = refusalForMove(
            { mode: 'PROPOSE_ONLY', modeSince: daysAgo(MODE_MIN_DAYS - 1), evidenceInWindow: 10 },
            'AUTOMATIC',
            NOW,
        );
        expect(r).toMatch(new RegExp(`of the ${MODE_MIN_DAYS} required`));
    });

    it('permits the climb once dwell and evidence are both satisfied', () => {
        expect(
            refusalForMove(
                { mode: 'DRY_RUN', modeSince: daysAgo(MODE_MIN_DAYS), evidenceInWindow: 1 },
                'PROPOSE_ONLY',
                NOW,
            ),
        ).toBeNull();
        expect(
            refusalForMove(
                { mode: 'PROPOSE_ONLY', modeSince: daysAgo(MODE_MIN_DAYS), evidenceInWindow: 1 },
                'AUTOMATIC',
                NOW,
            ),
        ).toBeNull();
    });

    it('gates DISABLED → DRY_RUN on the dwell only, since DISABLED records nothing', () => {
        // Arming the dry run must be reachable from a standing start, otherwise
        // the ladder can never be climbed at all.
        expect(
            refusalForMove({ mode: 'DISABLED', modeSince: daysAgo(MODE_MIN_DAYS) }, 'DRY_RUN', NOW),
        ).toBeNull();
        expect(MODE_MIN_EVIDENCE.DISABLED).toBeUndefined();
    });
});

/**
 * DISABLED HAS NO OBSERVATION WINDOW (owner decision, 2026-09-27).
 *
 * The dwell exists so what a rung RECORDS can be read before a wider one acts on
 * it, and `DISABLED` records nothing by construction. `MODE_MIN_EVIDENCE` had
 * already reached that conclusion on the evidence axis; the elapsed-days axis had
 * not, so a never-set connection's first widen was refused and the operator was
 * sent to re-select `DISABLED` and wait a week at a rung that observes nothing.
 *
 * Every assertion here has a paired one proving the exemption did not leak to a
 * rung that DOES record something.
 */
describe('DISABLED is exempt from the observation window', () => {
    const NOW = new Date('2026-09-27T12:00:00.000Z');

    it('permits DISABLED → DRY_RUN with a NULL modeSince', () => {
        expect(refusalForMove({ mode: 'DISABLED', modeSince: null }, 'DRY_RUN', NOW)).toBeNull();
    });

    it('permits it with a modeSince seconds old, so no dwell is served', () => {
        const justNow = new Date(NOW.getTime() - 1_000);
        expect(refusalForMove({ mode: 'DISABLED', modeSince: justNow }, 'DRY_RUN', NOW)).toBeNull();
    });

    it('still refuses DRY_RUN → PROPOSE_ONLY on a NULL modeSince', () => {
        // The paired assertion. Exempting DISABLED must not exempt the rung that
        // actually records something.
        expect(
            refusalForMove({ mode: 'DRY_RUN', modeSince: null, evidenceInWindow: 5 }, 'PROPOSE_ONLY', NOW),
        ).toMatch(/no recorded start/);
    });

    it('still refuses DRY_RUN → PROPOSE_ONLY on an unserved dwell', () => {
        const justNow = new Date(NOW.getTime() - 1_000);
        expect(
            refusalForMove({ mode: 'DRY_RUN', modeSince: justNow, evidenceInWindow: 5 }, 'PROPOSE_ONLY', NOW),
        ).toMatch(/held for 0 of the 7/);
    });

    it('still refuses a two-rung jump FROM DISABLED', () => {
        // The exemption is about the window, not about the one-rung rule.
        expect(refusalForMove({ mode: 'DISABLED', modeSince: null }, 'PROPOSE_ONLY', NOW)).toMatch(
            /one level at a time/,
        );
    });

    it('still refuses DRY_RUN → PROPOSE_ONLY on missing evidence, dwell served', () => {
        const longAgo = new Date(NOW.getTime() - 30 * 86_400_000);
        expect(
            refusalForMove({ mode: 'DRY_RUN', modeSince: longAgo, evidenceInWindow: 0 }, 'PROPOSE_ONLY', NOW),
        ).toMatch(/recorded 0 of the 1 required/);
    });
});

describe('classifyMove — the code a page words (#4878)', () => {
    const ladder = { classifyMove, refusalForMove };
    const NOW = new Date('2026-10-30T12:00:00Z');
    const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

    it('agrees with refusalForMove on whether a move is refused, for every branch', () => {
        const cases: Array<[Parameters<typeof ladder.classifyMove>, string | null]> = [
            [[{ mode: 'DISABLED', modeSince: null }, 'PROPOSE_ONLY', NOW], 'MULTI_RUNG'],
            [[{ mode: 'DRY_RUN', modeSince: null, evidenceInWindow: 5 }, 'PROPOSE_ONLY', NOW], 'NO_START'],
            [[{ mode: 'DRY_RUN', modeSince: ago(10) }, 'PROPOSE_ONLY', NOW], 'EVIDENCE_UNCOUNTED'],
            [[{ mode: 'DRY_RUN', modeSince: ago(10), evidenceInWindow: 0 }, 'PROPOSE_ONLY', NOW], 'TOO_LITTLE_EVIDENCE'],
            [[{ mode: 'DRY_RUN', modeSince: ago(2), evidenceInWindow: 4 }, 'PROPOSE_ONLY', NOW], 'DWELL'],
            [[{ mode: 'DRY_RUN', modeSince: ago(10), evidenceInWindow: 4 }, 'PROPOSE_ONLY', NOW], null],
            [[{ mode: 'AUTOMATIC', modeSince: null }, 'DISABLED', NOW], null],
        ];
        for (const [args, code] of cases) {
            expect(ladder.classifyMove(...args)?.code ?? null).toBe(code);
            expect(ladder.refusalForMove(...args) === null).toBe(code === null);
        }
    });

    it('names the kind of evidence the current rung needs', () => {
        expect(
            ladder.classifyMove({ mode: 'PROPOSE_ONLY', modeSince: ago(10), evidenceInWindow: 0 }, 'AUTOMATIC', NOW),
        ).toEqual({ code: 'TOO_LITTLE_EVIDENCE', mode: 'PROPOSE_ONLY', count: 0, required: 1, kind: 'approvals' });
    });
});

