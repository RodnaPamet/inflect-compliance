/**
 * The harness ladder's scoring rule (#3660): a rung is met only when every
 * criterion on it, and on every rung below, is met WITH evidence.
 */
import {
    ALL_HARNESS_CRITERIA,
    HARNESS_CRITERIA,
    HARNESS_LEVELS,
    isHarnessCriterionId,
    isShortfall,
    levelAtLeast,
    rungOf,
    scoreHarness,
    shortfallBarFor,
    type CriterionVerdict,
    type HarnessCriterionId,
    type HarnessLevel,
} from '@/lib/agentic/harness-ladder';

const met = (criterion: HarnessCriterionId): CriterionVerdict => ({ criterion, met: true, evidence: `evidence:${criterion}` });
const metThrough = (top: HarnessLevel): CriterionVerdict[] =>
    HARNESS_LEVELS.slice(1, rungOf(top) + 1).flatMap((l) => (HARNESS_CRITERIA[l] as readonly HarnessCriterionId[]).map(met));

describe('the ladder order', () => {
    it('is H0 to H5, and rungOf is the tuple index', () => {
        expect(HARNESS_LEVELS).toEqual(['H0', 'H1', 'H2', 'H3', 'H4', 'H5']);
        HARNESS_LEVELS.forEach((l, i) => expect(rungOf(l)).toBe(i));
    });

    it('compares ordinally: a higher level satisfies a lower bar, never the reverse', () => {
        expect(levelAtLeast('H4', 'H3')).toBe(true);
        expect(levelAtLeast('H3', 'H3')).toBe(true);
        expect(levelAtLeast('H2', 'H3')).toBe(false);
    });

    it('defines no criteria at H0 and at least one on every other rung', () => {
        expect(HARNESS_CRITERIA.H0).toHaveLength(0);
        for (const l of HARNESS_LEVELS.slice(1)) expect(HARNESS_CRITERIA[l].length).toBeGreaterThan(0);
    });

    it('gives every criterion a unique id prefixed with the rung that first requires it', () => {
        expect(new Set(ALL_HARNESS_CRITERIA).size).toBe(ALL_HARNESS_CRITERIA.length);
        for (const l of HARNESS_LEVELS) {
            for (const c of HARNESS_CRITERIA[l]) expect(c.startsWith(`${l}.`)).toBe(true);
        }
        expect(isHarnessCriterionId('H2.policy_card')).toBe(true);
        expect(isHarnessCriterionId('H9.made_up')).toBe(false);
    });
});

describe('scoreHarness', () => {
    it('scores an agent with no verdicts at H0, blocked by every H1 criterion', () => {
        expect(scoreHarness([])).toEqual({ level: 'H0', blockingNextRung: HARNESS_CRITERIA.H1 });
    });

    it.each(HARNESS_LEVELS.slice(1))('scores %s when every criterion up to it is evidenced', (top) => {
        const score = scoreHarness(metThrough(top));
        expect(score.level).toBe(top);
        const next = HARNESS_LEVELS[rungOf(top) + 1];
        expect(score.blockingNextRung).toEqual(next ? HARNESS_CRITERIA[next] : []);
    });

    it('stops at the rung below a single missing criterion, and names it', () => {
        const verdicts = metThrough('H5').filter((v) => v.criterion !== 'H2.audience_tokens');
        expect(scoreHarness(verdicts)).toEqual({ level: 'H1', blockingNextRung: ['H2.audience_tokens'] });
    });

    it('never lets a higher rung compensate for a missing lower one', () => {
        const verdicts = metThrough('H5').filter((v) => v.criterion !== 'H1.owner');
        expect(scoreHarness(verdicts).level).toBe('H0');
    });

    it('counts a criterion reported as met without evidence as not met', () => {
        const verdicts = metThrough('H1').map((v) => (v.criterion === 'H1.owner' ? { ...v, evidence: null } : v));
        expect(scoreHarness(verdicts).level).toBe('H0');
        const blank = metThrough('H1').map((v) => (v.criterion === 'H1.owner' ? { ...v, evidence: '   ' } : v));
        expect(scoreHarness(blank).level).toBe('H0');
    });

    it('judges a criterion reported twice on its least favourable answer, in either order', () => {
        const contradiction: CriterionVerdict = { criterion: 'H1.owner', met: false, evidence: null };
        expect(scoreHarness([...metThrough('H1'), contradiction]).level).toBe('H0');
        expect(scoreHarness([contradiction, ...metThrough('H1')]).level).toBe('H0');
    });
});

describe('the report-only shortfall bar', () => {
    it('is H3 for write-capable or external reach and H2 for read-only reach', () => {
        expect(shortfallBarFor('write-or-external')).toBe('H3');
        expect(shortfallBarFor('read-only')).toBe('H2');
    });

    it('holds an agent of unknown reach to the higher bar', () => {
        expect(shortfallBarFor('unknown')).toBe('H3');
        expect(isShortfall('H2', 'unknown')).toBe(true);
    });

    it.each([
        ['H1', 'read-only', true],
        ['H2', 'read-only', false],
        ['H2', 'write-or-external', true],
        ['H3', 'write-or-external', false],
        ['H5', 'write-or-external', false],
    ] as const)('%s with %s reach is a shortfall: %s', (level, reach, expected) => {
        expect(isShortfall(level, reach)).toBe(expected);
    });
});
