/**
 * Policy-coverage predicate FORWARD-LOCK.
 *
 * "A policy that counts" toward coverage / audit readiness has exactly ONE
 * definition: `@/lib/policy/coverage-predicate` (PUBLISHED + not deleted).
 * Before it, three scorers disagreed — the readiness pack counted APPROVED too,
 * the NIS2 scorer counted every status via a keyword match, and the coverage
 * summary ignored policies. This ratchet keeps them converged: every
 * policy-counting scorer MUST import the predicate and MUST NOT hand-roll a
 * policy-status filter on a `policy.findMany/count` query.
 *
 * NOTE: status-BREAKDOWN surfaces (DashboardRepository.getPolicySummary,
 * snapshot.ts) legitimately `groupBy status` to report per-status counts — they
 * are NOT "policies that count" scorers and are intentionally out of scope.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

const PREDICATE_MODULE = 'src/lib/policy/coverage-predicate.ts';

/** Every scorer that counts "policies that count" toward coverage/readiness. */
const SCORER_FILES: readonly string[] = [
    'src/app-layer/usecases/traceability.ts',
    'src/app-layer/usecases/audit-readiness/packs.ts',
    // audit-readiness/scoring.ts is intentionally NOT here: the NIS2 policy
    // dimension no longer counts policies-by-status — it scores the fraction of
    // in-scope controls carrying a PolicyControlLink (structural linkage), so it
    // is no longer a "policies that count" scorer.
];

// A raw policy-status filter directly on a policy query — the thing scorers
// must NOT do (they route through policyCountsWhere instead). Matches e.g.
// `policy.findMany({ where: { tenantId, status: {...} } })` or `status: 'PUBLISHED'`.
const RAW_POLICY_STATUS_FILTER = /policy\.(findMany|count|groupBy)\s*\(\s*\{[\s\S]{0,240}?status:/;

describe('Policy-coverage predicate forward-lock', () => {
    it('the single predicate module exists and pins PUBLISHED', () => {
        expect(exists(PREDICATE_MODULE)).toBe(true);
        const src = read(PREDICATE_MODULE);
        expect(src).toMatch(/POLICY_COUNTS_STATUS\s*=\s*'PUBLISHED'/);
        expect(src).toMatch(/export function policyCountsWhere/);
        expect(src).toMatch(/export function policyCountsTowardCoverage/);
    });

    it('every policy-counting scorer imports the shared predicate', () => {
        const missing = SCORER_FILES.filter((f) => {
            if (!exists(f)) return true;
            return !/from '@\/lib\/policy\/coverage-predicate'/.test(read(f));
        });
        // A scorer that counts policies without importing the predicate trips
        // here — route it through policyCountsWhere()/policyCountsTowardCoverage().
        expect(missing).toEqual([]);
    });

    it('no scorer hand-rolls a policy-status filter on a policy query', () => {
        const offenders = SCORER_FILES.filter((f) => exists(f) && RAW_POLICY_STATUS_FILTER.test(read(f)));
        expect(offenders).toEqual([]);
    });

    it('no stale scorer entries — every listed scorer exists', () => {
        expect(SCORER_FILES.filter((f) => !exists(f))).toEqual([]);
    });
});
