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
    requiresHumanApproval,
    refusalForMove,
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

    it('marks exactly one rung as dispatching, one as intent-only, one as approval-routed', () => {
        const dispatching = LADDER.filter(permitsDispatch);
        const intentOnly = LADDER.filter(recordsIntentOnly);
        const approval = LADDER.filter(requiresHumanApproval);
        expect(dispatching).toEqual(['AUTOMATIC']);
        expect(intentOnly).toEqual(['DRY_RUN']);
        expect(approval).toEqual(['PROPOSE_ONLY']);
        // DISABLED must do none of the three — the whole point of the default.
        expect(permitsDispatch('DISABLED')).toBe(false);
        expect(recordsIntentOnly('DISABLED')).toBe(false);
        expect(requiresHumanApproval('DISABLED')).toBe(false);
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
