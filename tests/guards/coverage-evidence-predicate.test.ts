/**
 * Guardrail: coverage-evidence predicate unification (ep1 evidence review gate).
 *
 * ─── The invariant ──────────────────────────────────────────────────
 *
 * "Evidence that counts toward framework coverage / audit readiness" has
 * exactly ONE definition — `isCoverageQualifyingEvidence` /
 * `coverageQualifyingEvidenceWhere` in
 * `src/lib/compliance/coverage-evidence.ts`: APPROVED, not archived,
 * not soft-deleted, and unexpired.
 *
 * Before this PR four scorer sites disagreed. The worst offender counted
 * `status: { in: ['SUBMITTED', 'APPROVED'] }`, so a merely-SUBMITTED
 * (un-reviewed) piece of evidence silently satisfied a control's
 * coverage gate — approval was not load-bearing.
 *
 * This ratchet locks the unification. For each scorer file it asserts:
 *   1. it imports from `@/lib/compliance/coverage-evidence` (so the
 *      shared predicate is actually wired, not re-inlined);
 *   2. (comments stripped) it contains no `SUBMITTED` literal — the
 *      canary for a re-introduced inline status set that would let
 *      un-approved evidence count again;
 *   3. it contains no `status: { in: [` fragment — the shape the old
 *      inline evidence filter used.
 *
 * A future "optimisation" that re-inlines an evidence status filter
 * trips this test in the same diff.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

const SCORER_FILES = [
    'src/app-layer/usecases/audit-readiness/scoring.ts',
    'src/app-layer/usecases/framework/coverage.ts',
    // Widened: each of these counted evidence its own way, so the same
    // control could read as covered on one screen and not another.
    //   - mapping.ts     — SOC2/NIS2 evidenceCount, bare status check with
    //                      no expiry/archive/delete guard at all.
    //   - packs.ts       — audit-pack control selection, status-only.
    //   - soa.ts         — diverged the OTHER way: filtered deletedAt but
    //                      not status, so DRAFT evidence inflated the tally.
    'src/app-layer/usecases/mapping.ts',
    'src/app-layer/usecases/audit-readiness/packs.ts',
    'src/app-layer/usecases/soa.ts',
] as const;

/**
 * Files that touch evidence status but are NOT coverage scorers. Each
 * needs a written reason — the completeness check below fails on any
 * unlisted file so a NEW scorer can't quietly inline the rule again.
 */
const NON_SCORER_EVIDENCE_FILES: ReadonlyArray<readonly [string, string]> = [
    ['src/app-layer/usecases/evidence.ts',
     'Owns the evidence state machine — it SETS status, it does not score.'],
    ['src/app-layer/usecases/aws-posture.ts',
     'Write path: creates auto-collected evidence already APPROVED.'],
    ['src/app-layer/usecases/cloud-posture.ts',
     'Write path: same as aws-posture.'],
    ['src/app-layer/usecases/scanner-ingestion.ts',
     'Write path: scanner-sourced evidence.'],
    ['src/app-layer/usecases/questionnaire.ts',
     'Answer-library picker — suggests prior evidence, does not score coverage.'],
    ['src/app-layer/usecases/compliance-calendar.ts',
     'Deadline surface — uses the evidence-EXPIRY predicate (app-layer/domain/evidence-expiry), a different question.'],
    ['src/app-layer/repositories/DashboardRepository.ts',
     'Freshness/retention KPI buckets — overdue/dueSoon semantics, not coverage.'],
];

/**
 * Strip block (`/* … *​/`) and line (`// …`) comments so a legitimate
 * mention of "SUBMITTED" in prose (e.g. describing the state machine)
 * doesn't false-positive. Deliberately simple — the scorer files carry
 * no comment-like string literals that would break this.
 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

describe('coverage-evidence predicate unification', () => {
    for (const rel of SCORER_FILES) {
        describe(rel, () => {
            const abs = path.join(REPO_ROOT, rel);
            const raw = fs.readFileSync(abs, 'utf8');
            const code = stripComments(raw);

            it('imports the shared coverage-evidence predicate', () => {
                expect(raw).toMatch(
                    /from\s+['"]@\/lib\/compliance\/coverage-evidence['"]/,
                );
            });

            it('contains no re-inlined SUBMITTED evidence status (comments stripped)', () => {
                expect(code).not.toContain('SUBMITTED');
            });

            it('contains no re-inlined EVIDENCE status filter', () => {
                // Evidence-specific canaries. A bare `status: { in: [` check
                // would false-positive on packs.ts, which legitimately
                // filters CONTROL status that way — the invariant here is
                // about how EVIDENCE is qualified.
                expect(code).not.toMatch(/EvidenceStatus\./);
                expect(code).not.toMatch(/evidence:\s*\{\s*status:/);
                expect(code).not.toMatch(/\be\.status\s*===/);
                expect(code).not.toMatch(/evidence\.status\s*===/);
            });
        });
    }

    /**
     * Completeness. The per-file loop above only polices files someone
     * remembered to list — which is exactly how mapping.ts, packs.ts and
     * soa.ts drifted for so long. This inverse check fails when a file
     * qualifies evidence by status without either being a listed scorer
     * (routed through the shared predicate) or being explicitly excused.
     */
    describe('completeness — no unlisted file qualifies evidence by status', () => {
        const listed = new Set<string>([
            ...SCORER_FILES,
            ...NON_SCORER_EVIDENCE_FILES.map(([f]) => f),
        ]);

        function walk(dir: string, out: string[] = []): string[] {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const abs = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(abs, out);
                else if (entry.name.endsWith('.ts')) out.push(abs);
            }
            return out;
        }

        it('every evidence-status-qualifying file is listed', () => {
            const roots = ['src/app-layer/usecases', 'src/app-layer/repositories'];
            const offenders: string[] = [];
            for (const root of roots) {
                for (const abs of walk(path.join(REPO_ROOT, root))) {
                    const rel = path
                        .relative(REPO_ROOT, abs)
                        .split(path.sep)
                        .join('/');
                    if (listed.has(rel)) continue;
                    const code = stripComments(fs.readFileSync(abs, 'utf8'));
                    // Does it TOUCH evidence rows at all?
                    if (!/\bevidence[A-Za-z]*\.(findMany|count|groupBy|findFirst|aggregate)/.test(code)) {
                        continue;
                    }
                    // …and qualify them by an APPROVED status of its own?
                    // The common shape is a direct
                    // `evidence.findMany({ where: { status: 'APPROVED' } })`,
                    // so a plain `status: 'APPROVED'` in a file that queries
                    // evidence is the canary — narrower patterns missed
                    // exactly the shape a new scorer would reach for.
                    if (/EvidenceStatus\.|evidence:\s*\{\s*status:|status:\s*['"]APPROVED['"]|\be\.status\s*===\s*['"]APPROVED/.test(code)) {
                        offenders.push(rel);
                    }
                }
            }
            expect(offenders).toEqual([]);
        });

        it('has no stale entries — every listed file exists', () => {
            for (const rel of [...SCORER_FILES, ...NON_SCORER_EVIDENCE_FILES.map(([f]) => f)]) {
                expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);
            }
        });
    });
});
