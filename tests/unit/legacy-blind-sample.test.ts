/**
 * The blind sample, and the lane it can close.
 *
 * THE RATE IS A STATISTICAL PROPERTY, so it is tested statistically. A
 * hand-picked id that happens to be in the sample proves the function returns
 * true sometimes, which `() => true` also satisfies. What has to hold is that
 * the realised share over a large population is close to the declared rate, and
 * that each individual answer is stable.
 */

import {
    agreesLaneClosed,
    blindDisagreed,
    BLIND_SAMPLE_RATE,
    isBlindHeld,
    type BlindComparison,
} from '@/lib/legacy-access/blind-sample';

const ids = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `cmvrd${String(i).padStart(10, '0')}xyz`);

describe('the sample rate', () => {
    it('withholds close to 5 % over a large population', () => {
        const population = ids(20_000);
        const held = population.filter((id) => isBlindHeld(id)).length;
        const share = held / population.length;

        // A tolerance derived from the population rather than guessed: the
        // standard error of a 5 % Bernoulli share over 20,000 draws is about
        // 0.15 pp, so 1 pp is ~6.5 sigma — tight enough to catch a rate that is
        // wrong, loose enough never to flake.
        expect(share).toBeGreaterThan(BLIND_SAMPLE_RATE - 0.01);
        expect(share).toBeLessThan(BLIND_SAMPLE_RATE + 0.01);
        // Print-the-second-number: the count beside the share, so a reader can
        // size the claim rather than trust the ratio.
        expect(held).toBeGreaterThan(700);
        expect(held).toBeLessThan(1_300);
    });

    it('is not uniformly false, which a wrong-direction comparison would be', () => {
        // The failure this catches: `>` instead of `<`, which withholds 95 %,
        // and a rate of 0 from an integer-division mistake. Both are caught by
        // the share test above; this one names them.
        expect(ids(200).some((id) => isBlindHeld(id))).toBe(true);
        expect(ids(200).every((id) => isBlindHeld(id))).toBe(false);
    });

    it('is DETERMINISTIC — a reviewer who refreshes sees the same thing', () => {
        // The property that makes the sample work at all. A row re-sampled on
        // each listing would show the verdict it was deliberately not showing.
        for (const id of ids(50)) {
            expect(isBlindHeld(id)).toBe(isBlindHeld(id));
        }
    });

    it('scales with the rate, so the constant is the thing in control', () => {
        const population = ids(20_000);
        const atFive = population.filter((id) => isBlindHeld(id, 0.05)).length;
        const atTwenty = population.filter((id) => isBlindHeld(id, 0.2)).length;
        expect(atTwenty).toBeGreaterThan(atFive * 3);
        // And it is a PREFIX relation: everything held at 5 % is held at 20 %,
        // because both read the same digest against a bigger bound. That is
        // what lets the rate be raised without re-sampling the rows already
        // measured.
        const fiveSet = new Set(population.filter((id) => isBlindHeld(id, 0.05)));
        for (const id of fiveSet) expect(isBlindHeld(id, 0.2)).toBe(true);
    });

    it('holds nothing at a rate of zero, and everything at one', () => {
        expect(ids(500).some((id) => isBlindHeld(id, 0))).toBe(false);
        expect(ids(500).every((id) => isBlindHeld(id, 1))).toBe(true);
    });

    it('an empty id is not a verdict, so it is not in the sample', () => {
        expect(isBlindHeld('')).toBe(false);
    });

    it('re-samples under a new revision, because the key is the VERDICT id', () => {
        // One resolution, two revisions, two verdict ids. The two must be
        // sampled independently — a sample keyed on the resolution would measure
        // the same accounts for every revision for ever.
        const underR1 = ids(2_000).map((id) => `${id}-rev1`);
        const underR2 = ids(2_000).map((id) => `${id}-rev2`);
        const heldR1 = new Set(underR1.filter((id) => isBlindHeld(id)));
        const heldR2 = new Set(underR2.filter((id) => isBlindHeld(id)).map((id) => id));

        // Both draw about the rate...
        expect(heldR1.size).toBeGreaterThan(50);
        expect(heldR2.size).toBeGreaterThan(50);
        // ...and they are not the same accounts. Compared on the shared stem.
        const stem = (s: string) => s.replace(/-rev\d$/, '');
        const stemsR1 = new Set([...heldR1].map(stem));
        const overlap = [...heldR2].map(stem).filter((s) => stemsR1.has(s)).length;
        // A 5 % sample twice over independently gives ~0.25 % overlap, far
        // below either sample's own size. Equality would mean the key was
        // effectively the resolution.
        expect(overlap).toBeLessThan(Math.min(heldR1.size, heldR2.size) / 2);
    });
});

describe('what counts as a disagreement', () => {
    const c = (over: Partial<BlindComparison> = {}): BlindComparison => ({
        verdictId: 'v1',
        modelEmployeeId: 'emp-1',
        reviewerEmployeeId: 'emp-1',
        ...over,
    });

    it('agreement is not a disagreement', () => {
        expect(blindDisagreed(c())).toBe(false);
    });

    it('a different person IS a disagreement', () => {
        expect(blindDisagreed(c({ reviewerEmployeeId: 'emp-2' }))).toBe(true);
    });

    it('a reviewer who answered a DIFFERENT question has not disagreed', () => {
        // Non-person, external and orphan all leave `reviewerEmployeeId` null.
        // Those answers are about what KIND of account it is; the model was
        // asked which person holds it. Scoring them as disagreements would close
        // the lane on the first service account anybody classified.
        expect(blindDisagreed(c({ reviewerEmployeeId: null }))).toBe(false);
    });

    it('a model with no pick is not evidence either', () => {
        expect(blindDisagreed(c({ modelEmployeeId: null }))).toBe(false);
    });
});

describe('the lane gate', () => {
    const agree: BlindComparison = {
        verdictId: 'v1',
        modelEmployeeId: 'emp-1',
        reviewerEmployeeId: 'emp-1',
    };
    const disagree: BlindComparison = {
        verdictId: 'v2',
        modelEmployeeId: 'emp-1',
        reviewerEmployeeId: 'emp-9',
    };

    it('stays open with no comparisons at all', () => {
        // An unmeasured revision is not a failed one. Closing here would mean
        // the lane never opens, since the first cycle has nothing to compare.
        expect(agreesLaneClosed([])).toBe(false);
    });

    it('stays open while every blind row agreed', () => {
        expect(agreesLaneClosed([agree, agree, agree])).toBe(false);
    });

    it('ONE disagreement closes it', () => {
        // Not a rate and not a threshold. Bulk ratification is a person
        // confirming many rows on the strength of a claim about the model, and
        // one counter-example means the rows are not the kind they were told.
        expect(agreesLaneClosed([agree, agree, disagree, agree])).toBe(true);
    });

    it('stays closed however many agreements follow', () => {
        expect(agreesLaneClosed([disagree, ...Array(100).fill(agree)])).toBe(true);
    });

    it('is not closed by a null-sided comparison', () => {
        expect(
            agreesLaneClosed([{ verdictId: 'v3', modelEmployeeId: 'emp-1', reviewerEmployeeId: null }]),
        ).toBe(false);
    });
});
