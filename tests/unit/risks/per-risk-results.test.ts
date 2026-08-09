/**
 * The one validated read of `RiskSimulationRun.perRiskResultsJson`.
 *
 * B2-6 — three server-side readers each narrowed this Prisma `Json` column
 * their own way, and only one of them validated. The consequence was not
 * hypothetical: `risk-report.ts` required `aleP90` to be a number but never
 * checked `aleMean`, while `board/page.tsx` cast without checking anything,
 * so one malformed row could show a tail figure on the board and none in the
 * PDF generated from the SAME simulation run.
 *
 * The cases below are the ones the three readers disagreed about.
 */
import {
    parsePerRiskResults,
    buildTailByRisk,
} from '@/lib/risk/per-risk-results';

const row = (over: Record<string, unknown> = {}) => ({
    riskId: 'r1',
    aleMean: 100,
    aleP50: 90,
    aleP90: 250,
    aleP95: 400,
    contribution: 0.4,
    ...over,
});

describe('parsePerRiskResults', () => {
    it('indexes a well-formed run by riskId', () => {
        expect(parsePerRiskResults([row()])).toEqual({
            r1: { aleMean: 100, aleP50: 90, aleP90: 250, aleP95: 400, contribution: 0.4 },
        });
    });

    it.each([
        ['null (run never completed)', null],
        ['undefined (no run at all)', undefined],
        ['a JSON object instead of an array', { r1: row() }],
        ['a JSON string', '[]'],
        ['a number', 3],
    ])('returns an empty map for %s rather than throwing', (_label, input) => {
        // A run that has not completed has no per-risk results. That is a
        // normal state — the board renders "no simulation yet" — so this
        // must not be an exception path.
        expect(parsePerRiskResults(input)).toEqual({});
    });

    it.each([
        ['a null entry', null],
        ['a string entry', 'r1'],
        ['a missing riskId', { aleMean: 1 }],
        ['a non-string riskId', { riskId: 7, aleMean: 1 }],
        ['a missing aleMean', { riskId: 'r1' }],
        ['a non-numeric aleMean', { riskId: 'r1', aleMean: '100' }],
    ])('drops %s', (_label, entry) => {
        // riskId and aleMean are the two load-bearing fields: one to key on,
        // one to fall back to. Without either there is nothing to salvage.
        expect(parsePerRiskResults([entry])).toEqual({});
    });

    it('keeps the good rows when one entry is malformed', () => {
        // The old board cast would have handed `undefined` to arithmetic for
        // the bad row; the old report reader would have dropped BOTH.
        const out = parsePerRiskResults([row({ riskId: 'a' }), null, row({ riskId: 'b' })]);
        expect(Object.keys(out).sort()).toEqual(['a', 'b']);
    });

    it('falls back to the mean for a pre-RQ3-1 row with no percentiles', () => {
        // Runs written before RQ3-1 genuinely lack these fields. Falling
        // back to the mean keeps portfolio arithmetic total, and leaves
        // p50 === p90 === mean, which `tail-language.ts` reads as "no tail".
        expect(parsePerRiskResults([{ riskId: 'r1', aleMean: 100 }])).toEqual({
            r1: { aleMean: 100, aleP50: 100, aleP90: 100, aleP95: 100, contribution: 0 },
        });
    });

    it('falls back per-field, not all-or-nothing', () => {
        const out = parsePerRiskResults([{ riskId: 'r1', aleMean: 100, aleP90: 250 }]);
        expect(out.r1).toEqual({
            aleMean: 100, aleP50: 100, aleP90: 250, aleP95: 100, contribution: 0,
        });
    });

    it('keeps a contribution of zero rather than defaulting it away', () => {
        // 0 is a real value — a risk that contributes nothing to portfolio
        // variance. `|| 0` and `typeof === number` agree here, but a future
        // `??`-to-`||` edit would not.
        expect(parsePerRiskResults([row({ contribution: 0 })]).r1.contribution).toBe(0);
    });

    it('keeps an aleMean of zero — a quantified risk with no expected loss', () => {
        // A truthiness check on aleMean drops this row entirely.
        expect(parsePerRiskResults([{ riskId: 'r1', aleMean: 0 }]).r1.aleMean).toBe(0);
    });

    it('lets a later duplicate riskId win rather than producing two entries', () => {
        const out = parsePerRiskResults([row({ aleP90: 1 }), row({ aleP90: 2 })]);
        expect(out.r1.aleP90).toBe(2);
    });
});

describe('buildTailByRisk', () => {
    it('projects the P90 for each valid row', () => {
        expect(buildTailByRisk([row({ riskId: 'a' }), row({ riskId: 'b', aleP90: 10 })]))
            .toEqual({ a: 250, b: 10 });
    });

    it('applies the SAME admission rule as the full parse', () => {
        // This is the invariant that was broken: the report accepted rows
        // with no aleMean, the board accepted anything. Both now agree with
        // parsePerRiskResults, so the report and the board can never show a
        // different set of risks for one run.
        const rows = [row({ riskId: 'a' }), { riskId: 'b', aleP90: 5 }, null];
        expect(Object.keys(buildTailByRisk(rows)))
            .toEqual(Object.keys(parsePerRiskResults(rows)));
    });

    it('reports the mean as the P90 for a row with no tail data', () => {
        // Not a missing key. The board shows a number, and it is the honest
        // one: with no distribution the best P90 estimate IS the mean.
        expect(buildTailByRisk([{ riskId: 'r1', aleMean: 100 }])).toEqual({ r1: 100 });
    });

    it('returns an empty map for a run with no results', () => {
        expect(buildTailByRisk(null)).toEqual({});
    });
});
