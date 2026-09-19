/**
 * Ratchet — NIS2 gap-assessment multi-respondent delegation (Prompt 2).
 *
 * Locks the load-bearing properties: single-source bank, disjoint partition,
 * baseline-never-delegated, data-layer authorization, index/permission
 * registration, and propose-not-commit confinement to finalize.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// #2246 Class A — source reads masked at the seam (comments blanked,
// string literals kept). The JSON fixture keeps its own RAW reader: JSON
// has no comments to blank and codeOf would corrupt a `//` inside a string.
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const readJson = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const usecase = read('src/app-layer/usecases/gap-assessment-assignment.ts');

describe('NIS2 assignment — single source of the bank', () => {
    it('the assignment usecase reads the shared repo/bank, not a local question copy', () => {
        expect(usecase).toMatch(/Nis2GapAssessmentRepository/);
        // No embedded question ids (the gap-<n>-<nn> pattern lives only in the fixture).
        expect(usecase).not.toMatch(/gap-\d+-\d+/);
    });
});

describe('NIS2 assignment — partition is a disjoint cover of the real 116-question bank', () => {
    const bank = JSON.parse(readJson('prisma/fixtures/nis2-gap-assessment.json')) as {
        questions: Array<{ id: string; respondent: string }>;
    };
    const ROLES = new Set(['CEO', 'IT', 'HR', 'PROCUREMENT', 'ANYONE']);

    it('grouping by respondent partitions all 116 ids with no gaps and no overlap', () => {
        // Mirrors partitionByRespondent's logic: bucket each question by its
        // respondent (unknown → ANYONE). The union must be exactly the bank.
        const buckets: Record<string, string[]> = { CEO: [], IT: [], HR: [], PROCUREMENT: [], ANYONE: [] };
        for (const q of bank.questions) {
            const role = ROLES.has(q.respondent) ? q.respondent : 'ANYONE';
            buckets[role].push(q.id);
        }
        const all = Object.values(buckets).flat();
        expect(bank.questions.length).toBe(116);
        expect(all.length).toBe(116); // no gaps
        expect(new Set(all).size).toBe(116); // no overlap (disjoint)
    });
});

describe('NIS2 assignment — invariants', () => {
    it('dispatch REJECTS a WIZARD_BASELINE run', () => {
        expect(usecase).toMatch(/WIZARD_BASELINE/);
        expect(usecase).toMatch(/cannot be delegated/i);
    });

    it('submit enforces data-layer authorization (rejects out-of-bucket ids)', () => {
        const submit = usecase.slice(usecase.indexOf('submitAssignmentAnswers'));
        expect(submit).toMatch(/bucket\.has\(/);
        expect(submit).toMatch(/not in your assignment/i);
    });

    it('finalize is the ONLY site that completes/snapshots; dispatch/submit never create risks/controls', () => {
        expect(usecase).not.toMatch(/createRisk|createControl/);
        const finalize = usecase.slice(usecase.indexOf('export async function finalizeAssessment'));
        expect(finalize).toMatch(/markAssessmentCompleted/);
        expect(finalize).toMatch(/snapshotNis2Readiness/);
    });
});

describe('NIS2 assignment — schema + route registration', () => {
    it('Nis2GapAssignment carries both tenantId-leading indexes + the role unique', () => {
        const schema = codeOf(readPrismaSchema());
        const block = schema.slice(schema.indexOf('model Nis2GapAssignment'));
        expect(block).toMatch(/@@index\(\[tenantId, assessmentId\]\)/);
        expect(block).toMatch(/@@index\(\[tenantId, assigneeUserId\]\)/);
        expect(block).toMatch(/@@unique\(\[assessmentId, respondentRole\]\)/);
    });

    it('dispatch/finalize routes are requirePermission-gated + registered', () => {
        const dispatch = read('src/app/api/t/[tenantSlug]/gap-assessments/[id]/assignments/route.ts');
        const finalize = read('src/app/api/t/[tenantSlug]/gap-assessments/[id]/assignments/finalize/route.ts');
        expect(dispatch).toMatch(/requirePermission/);
        expect(finalize).toMatch(/requirePermission/);
        const routePerms = read('src/lib/security/route-permissions.ts');
        expect(routePerms).toMatch(/gap-assessments/);
    });
});
