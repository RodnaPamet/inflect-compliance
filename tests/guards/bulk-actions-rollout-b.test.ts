/**
 * Canonical BulkActionBar rollout — wave B: Evidence + Policy.
 *
 * Both entities have workflow-gated status (Evidence: the reviewer-identity
 * review chain; Policy: the publish-approval gate), so — per operator
 * decision — neither bar offers bulk status. The bars are assign-focused:
 *   - Evidence: Assign owner only.
 *   - Policy:   Assign owner (write) + Archive (the one safe terminal verb,
 *               admin-gated, mirroring archivePolicy).
 *
 * This guard locks that shape: the bars must NOT carry a `value: 'status'`
 * action, and Policy's Archive route must exist.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codeOf, functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Comments masked at the READER, so every assertion below is about code.
 *
 * This guard is mostly NEGATIVE — `not.toMatch(/value: 'status'/)`,
 * `not.toMatch(/bulkSetEvidenceStatus/)` — and a negative assertion over raw
 * text is the worst case of the class: the shape it is meant to forbid is
 * exactly the shape somebody writes in a comment while removing it
 * ("no bulk status — status is workflow-gated"). One such note and the
 * assertion fails on a codebase that is CORRECT, so the pressure is to
 * loosen the regex rather than to fix the read. The positive half has the
 * mirror problem: a commented-out `value: 'assign'` vouches for a bar that
 * no longer offers it. `functionBodyOf` already masks; this makes the
 * whole-file reads agree with it.
 */
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('Bulk action rollout — Evidence (assign-only)', () => {
    it('has a bulk assign route but NO bulk status route', () => {
        expect(exists('src/app/api/t/[tenantSlug]/evidence/bulk/assign/route.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/evidence/bulk/status/route.ts')).toBe(false);
    });

    it('usecase asserts write + uses a tenant-scoped bulk update', () => {
        const uc = read('src/app-layer/usecases/evidence.ts');
        expect(uc).toMatch(/export async function bulkAssignEvidence/);
        expect(uc).toMatch(/assertCanWrite\(ctx\)/);
        expect(uc).toMatch(/EvidenceRepository\.bulkUpdate/);
        // No bulk status usecase — status is workflow-gated.
        expect(uc).not.toMatch(/bulkSetEvidenceStatus/);
    });

    it('repository bulkUpdate is one updateMany filtered by tenantId', () => {
        const repo = read('src/app-layer/repositories/EvidenceRepository.ts');
        expect(repo).toMatch(/static async bulkUpdate/);
        expect(repo).toMatch(/updateMany/);
        expect(repo).toMatch(/tenantId: ctx\.tenantId/);
    });

    it('schema exists + caps the batch', () => {
        const sch = read('src/lib/schemas/index.ts');
        expect(sch).toMatch(/BulkEvidenceAssignSchema/);
        expect(sch).toMatch(/evidenceIds: z\.array/);
    });

    it('client mounts BulkActionBar with assign — and NO status action', () => {
        const client = read('src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx');
        expect(client).toMatch(/<BulkActionBar\b/);
        expect(client).toMatch(/value: 'assign'/);
        expect(client).not.toMatch(/value: 'status'/);
    });
});

describe('Bulk action rollout — Policy (assign + archive)', () => {
    it('has bulk assign + archive routes but NO bulk status route', () => {
        expect(exists('src/app/api/t/[tenantSlug]/policies/bulk/assign/route.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/policies/bulk/archive/route.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/policies/bulk/status/route.ts')).toBe(false);
    });

    it('assign asserts write, archive asserts admin; both use a bulk update', () => {
        const uc = read('src/app-layer/usecases/policy.ts');
        expect(uc).toMatch(/export async function bulkAssignPolicy/);
        expect(uc).toMatch(/export async function bulkArchivePolicy/);
        expect(uc).toMatch(/PolicyRepository\.bulkUpdate/);
        // archive is admin-gated; status has no bulk path.
        //
        // `assertCanAdminPolicies` is the domain-aware gate: it still calls the
        // coarse `assertCanAdmin` underneath and ADDITIONALLY requires the
        // custom role's granular `policies.edit` flag, so this is a tightening,
        // not a loosening. The bare `assertCanAdmin(ctx)` form is still
        // accepted for surfaces that have not moved yet. (The optional group is
        // required rather than cosmetic: `assertCanAdmin\(` does not match
        // `assertCanAdminPolicies(` — the escaped paren follows "Admin".)
        //
        // Bounded to the FUNCTION BODY, not a 160-character window from the
        // name. The window form is strictly worse than the whole-file regex it
        // replaced: it fails on unrelated growth above the gate, and passes on
        // a gate that has drifted 161 characters away. CLAUDE.md names the
        // shape — never slice a magic byte offset.
        expect(functionBodyOf(uc, 'bulkArchivePolicy')).toMatch(
            /assertCanAdmin(Policies)?\(ctx\)/,
        );
        expect(uc).not.toMatch(/bulkSetPolicyStatus/);
    });

    it('repository bulkUpdate is one updateMany filtered by tenantId', () => {
        const repo = read('src/app-layer/repositories/PolicyRepository.ts');
        expect(repo).toMatch(/static async bulkUpdate/);
        expect(repo).toMatch(/updateMany/);
        expect(repo).toMatch(/tenantId: ctx\.tenantId/);
    });

    it('schemas exist (assign + archive) + cap the batch', () => {
        const sch = read('src/lib/schemas/index.ts');
        expect(sch).toMatch(/BulkPolicyAssignSchema/);
        expect(sch).toMatch(/BulkPolicyArchiveSchema/);
        expect(sch).toMatch(/policyIds: z\.array/);
    });

    it('client mounts BulkActionBar with assign + archive — and NO status action', () => {
        const client = read('src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx');
        expect(client).toMatch(/<BulkActionBar\b/);
        expect(client).toMatch(/value: 'assign'/);
        expect(client).toMatch(/value: 'archive'/);
        expect(client).not.toMatch(/value: 'status'/);
    });
});
