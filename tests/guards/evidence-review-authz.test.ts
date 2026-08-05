/**
 * R5-P2 — evidence review-flow + authz consistency (structural ratchet).
 *
 * Locks the load-bearing guarantees:
 *   1. The UI can see the AV verdict (repo selects scanStatus) and refuses
 *      download/preview/thumbnail through the shared client predicate.
 *   2. Approve/Reject is offered only to ADMIN (matching the server), and a
 *      failed review is surfaced, not swallowed.
 *   3. Read-only roles get no selection/bulk bar.
 *   4. Replacing/editing APPROVED content resets it to SUBMITTED (re-review).
 *   5. A rejection must carry a reason (server-side).
 *   6. Evidence write gates consult appPermissions (custom-role aware).
 *   7. A body-supplied ownerUserId is validated as an ACTIVE member.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const EVIDENCE = 'src/app-layer/usecases/evidence.ts';
const REPO = 'src/app-layer/repositories/EvidenceRepository.ts';
const POLICIES = 'src/app-layer/policies/evidence.policies.ts';
const CLIENT = 'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx';
const SHEET = 'src/app/t/[tenantSlug]/(app)/evidence/EvidenceDetailSheet.tsx';
const GALLERY = 'src/components/ui/EvidenceGallery.tsx';
const SCAN = 'src/lib/evidence-scan.ts';

describe('R5-P2 (1) scan status is visible + gated', () => {
    it('the repository selects scanStatus for list + detail', () => {
        const src = read(REPO);
        expect(src).toMatch(/mimeType: true, scanStatus: true/);
        expect(src).toMatch(/scanStatus: true,\s*\n\s*scannedAt: true/);
    });
    it('a client-safe scan predicate exists and gates all three surfaces', () => {
        expect(read(SCAN)).toMatch(/export function isScanServable/);
        expect(read(CLIENT)).toMatch(/isScanServable|isScanInfected/);
        expect(read(SHEET)).toMatch(/isScanServable/);
        expect(read(GALLERY)).toMatch(/scanServable/);
    });
});

describe('R5-P2 (2) reviewer gate matches the server', () => {
    const src = read(CLIENT);
    it('Approve/Reject row buttons require canAdmin', () => {
        expect(src).toMatch(/status === 'SUBMITTED' && permissions\.canAdmin/);
    });
    it('a failed review is surfaced, not swallowed', () => {
        expect(src).toMatch(/toast\.error\(tx\('list\.reviewFailed'\)\)/);
    });
});

describe('R5-P2 (3) read-only roles get no bulk bar', () => {
    const src = read(CLIENT);
    it('selection is gated on write and bulk actions on their tier', () => {
        expect(src).toMatch(/selectionEnabled=\{permissions\.canWrite\}/);
        expect(src).toMatch(/permissions\.canAdmin \? \[\{[\s\S]{0,120}value: 'approve'/);
        // handleBulkApply gained a catch that toasts the failure
        expect(src).toMatch(/\} catch \{[\s\S]{0,300}toast\.error\(tx\('list\.bulkFailed'\)\)/);
    });
});

describe('R5-P2 (4) content change on APPROVED forces re-review', () => {
    const src = read(EVIDENCE);
    it('replaceEvidenceFile + updateEvidence reset APPROVED to SUBMITTED', () => {
        expect(src).toMatch(/requiresReReview = target\.status === 'APPROVED'/);
        expect(src).toMatch(/contentReReview[\s\S]{0,120}status === 'APPROVED'/);
        expect(src).toMatch(/status: 'SUBMITTED'/);
    });
});

describe('R5-P2 (5) rejection requires a reason', () => {
    it('reviewEvidence rejects a blank REJECTED comment', () => {
        expect(read(EVIDENCE)).toMatch(/newStatus === 'REJECTED' && !comment\?\.trim\(\)/);
    });
});

describe('R5-P2 (6) evidence gates are custom-role aware', () => {
    it('evidence.policies consults appPermissions.evidence and usecases use it', () => {
        expect(read(POLICIES)).toMatch(/ctx\.appPermissions\.evidence\.(view|edit|upload)/);
        const ev = read(EVIDENCE);
        expect(ev).toMatch(/assertCanEditEvidence\(ctx\)/);
        expect(ev).toMatch(/assertCanUploadEvidence\(ctx\)/);
    });
});

describe('R5-P2 (7) ownerUserId is validated as an active member', () => {
    const src = read(EVIDENCE);
    it('a shared helper checks ACTIVE membership and is applied at every write', () => {
        expect(src).toMatch(/async function assertOwnerIsActiveMember/);
        expect((src.match(/assertOwnerIsActiveMember\(db, ctx,/g) ?? []).length).toBeGreaterThanOrEqual(4);
        // notifyEvidenceOwner resolves via membership, not an unscoped user lookup
        expect(src).not.toMatch(/db\.user\.findUnique\(\{ where: \{ id: evidence\.ownerUserId \} \}\)/);
    });
});
