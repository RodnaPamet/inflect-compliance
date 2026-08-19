/**
 * The blast-radius breaker: what it refuses, and what it must NOT refuse.
 *
 * Both halves are load-bearing. A rail that refuses correct input gets switched
 * off, and a switched-off rail protects nothing — so the "allows" cases below
 * are as much a part of the contract as the refusals.
 */
import {
    checkDisableBlastRadius,
    MAX_DISABLES_PER_RUN,
    MAX_DISABLE_SHARE,
    SHARE_RULE_FLOOR,
} from '@/app-layer/usecases/identity-write-breaker';

describe('an empty batch is always allowed', () => {
    it('zero proposed disables passes, even with no known population', () => {
        // A no-op run surfacing as a refusal would train operators to ignore
        // refusals, which is the failure mode this whole rail cannot afford.
        expect(checkDisableBlastRadius({ proposed: 0, population: 0 })).toEqual({ allowed: true });
    });

    it('a negative count is treated as empty, not as a strange batch', () => {
        expect(checkDisableBlastRadius({ proposed: -3, population: 100 }).allowed).toBe(true);
    });
});

describe('an unknown population is refused, not assumed safe', () => {
    it('refuses a real batch when the population is zero', () => {
        // The denominator being unknown is not evidence of a small blast
        // radius. This is also the divide-by-zero guard.
        const d = checkDisableBlastRadius({ proposed: 1, population: 0 });
        expect(d.allowed).toBe(false);
        expect(d.allowed === false && d.reason).toMatch(/population is unknown/i);
    });
});

describe('the absolute cap', () => {
    it('allows a batch exactly at the cap', () => {
        // Off-by-one here means either a rail that fires early or one that
        // lets a batch through. The boundary is asserted in both directions.
        expect(
            checkDisableBlastRadius({ proposed: MAX_DISABLES_PER_RUN, population: 100_000 }).allowed,
        ).toBe(true);
    });

    it('refuses one above the cap', () => {
        const d = checkDisableBlastRadius({ proposed: MAX_DISABLES_PER_RUN + 1, population: 100_000 });
        expect(d.allowed).toBe(false);
        expect(d.allowed === false && d.reason).toMatch(/per-run cap/i);
    });

    it('the cap binds even in a huge directory where the share is tiny', () => {
        // 51 of a million is 0.005% — well under the share cap. The absolute
        // rule is what stops "small percentage of a big number" from being a
        // large number of real people.
        const d = checkDisableBlastRadius({ proposed: MAX_DISABLES_PER_RUN + 1, population: 1_000_000 });
        expect(d.allowed).toBe(false);
    });
});

describe('the share cap', () => {
    it('refuses a batch over the share, once above the floor', () => {
        // 20 of 100 = 20%, over the 10% cap and over the floor.
        const d = checkDisableBlastRadius({ proposed: 20, population: 100 });
        expect(d.allowed).toBe(false);
        expect(d.allowed === false && d.reason).toMatch(/share cap/i);
    });

    it('allows a batch exactly at the share cap', () => {
        // 10 of 100 = exactly 10%. Refusal is for EXCEEDING it.
        expect(checkDisableBlastRadius({ proposed: 10, population: 100 }).allowed).toBe(true);
    });

    it('reports the actual percentage so an operator can judge it', () => {
        const d = checkDisableBlastRadius({ proposed: 30, population: 100 });
        expect(d.allowed === false && d.reason).toMatch(/30\.0%/);
    });
});

describe('the small-tenant floor — the half that keeps the rail switched on', () => {
    it('allows one departure in a three-person tenant, which is 33%', () => {
        // Without the floor this is refused forever: in a tiny tenant a single
        // leaver is ALWAYS a double-digit share. A rail that refuses every
        // correct event at the bottom end is one an operator disables.
        expect(checkDisableBlastRadius({ proposed: 1, population: 3 }).allowed).toBe(true);
    });

    it('allows a batch at the floor even when the share is far over', () => {
        // 5 of 10 = 50%, but at the floor.
        expect(checkDisableBlastRadius({ proposed: SHARE_RULE_FLOOR, population: 10 }).allowed).toBe(true);
    });

    it('but the floor does NOT disable the share rule above it', () => {
        // 6 of 10 = 60%, one above the floor. The floor is a threshold for
        // the rule to apply, not a blanket exemption.
        const d = checkDisableBlastRadius({ proposed: SHARE_RULE_FLOOR + 1, population: 10 });
        expect(d.allowed).toBe(false);
    });
});

describe('the normal cases this must not interfere with', () => {
    it('a routine handful of leavers in a mid-size tenant', () => {
        expect(checkDisableBlastRadius({ proposed: 3, population: 400 }).allowed).toBe(true);
    });

    it('a large but plausible wave in a large tenant', () => {
        // 40 of 5,000 = 0.8%: under both caps. A real Monday at a big company
        // must not trip this.
        expect(checkDisableBlastRadius({ proposed: 40, population: 5_000 }).allowed).toBe(true);
    });

    it('the whole directory vanishing is refused — the case the rail exists for', () => {
        const d = checkDisableBlastRadius({ proposed: 500, population: 500 });
        expect(d.allowed).toBe(false);
    });
});

describe('the thresholds are coherent with each other', () => {
    it('the floor is below the absolute cap', () => {
        // If the floor were above the cap the share rule could never fire —
        // every batch big enough to reach it would already be refused.
        expect(SHARE_RULE_FLOOR).toBeLessThan(MAX_DISABLES_PER_RUN);
    });

    it('the share is a fraction, not a percentage', () => {
        // A 10 here instead of 0.1 would silently disable the share rule
        // entirely, since no batch is 1000% of its population.
        expect(MAX_DISABLE_SHARE).toBeGreaterThan(0);
        expect(MAX_DISABLE_SHARE).toBeLessThan(1);
    });
});
