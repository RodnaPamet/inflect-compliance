/**
 * `list_risks` filters by score up to the largest score a matrix can give
 * (#5304, owner decision 2026-11-14).
 *
 * A matrix is at most 10x10 (`RISK_MATRIX_MAX_LEVELS`), so a score reaches
 * 100. The tool used to stop at 25, the 5x5 default's maximum, so on a larger
 * matrix an agent could not ask for its highest risks at all.
 *
 * The advertised `inputSchema` and the enforced `argsSchema` are asserted
 * TOGETHER: an advertised bound the parser does not hold misleads the model,
 * and a parser bound the advertisement does not show refuses calls the model
 * was told it could make. Raising the advertised bound changes the tool's
 * `schemaHash`, so every tenant that pinned `list_risks` sees it withheld until
 * a person re-approves it. That is the decision, and nothing here keeps an old
 * pin valid.
 */
import { listRisksTool } from '@/lib/mcp/tools/risk-tools';
import { RISK_MATRIX_MAX_LEVELS, RISK_MATRIX_MAX_SCORE } from '@/lib/risk-matrix/schema';

type Bounded = { minimum: number; maximum: number };

describe('list_risks score filter', () => {
    it('the largest possible score is the largest matrix squared, which is 100', () => {
        expect(RISK_MATRIX_MAX_LEVELS).toBe(10);
        expect(RISK_MATRIX_MAX_SCORE).toBe(100);
    });

    it.each(['scoreMin', 'scoreMax'])('%s is advertised up to the largest score', (field) => {
        const props = (listRisksTool.inputSchema as { properties: Record<string, Bounded> })
            .properties;
        expect(props[field]).toMatchObject({ minimum: 1, maximum: RISK_MATRIX_MAX_SCORE });
    });

    it.each(['scoreMin', 'scoreMax'])('%s is enforced up to the largest score, and no further', (field) => {
        const parse = (v: number) => listRisksTool.argsSchema.safeParse({ [field]: v }).success;
        expect(parse(RISK_MATRIX_MAX_SCORE)).toBe(true);
        expect(parse(50)).toBe(true);
        expect(parse(RISK_MATRIX_MAX_SCORE + 1)).toBe(false);
        expect(parse(0)).toBe(false);
    });
});
