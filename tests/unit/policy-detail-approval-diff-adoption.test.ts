/**
 * Structural ratchet — Epic 45.3 policy detail review wiring.
 *
 * Locks the policy detail page to:
 *   - <ApprovalBanner> mounted at top, gated on `IN_REVIEW` status
 *   - canDecide bound to canAdmin (reviewer permission)
 *   - <VersionDiff> rendered in the Versions tab when ≥2 versions
 *     exist
 *   - both components imported from the canonical paths
 *
 * Mirrors the Epic 45.2 editor-adoption ratchet shape.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const POLICY_DETAIL = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/policies/[policyId]/page.tsx',
);
const source = codeOf(readFileSync(POLICY_DETAIL, 'utf8'));

describe('Policy detail — Epic 45.3 review wiring', () => {
    it('imports <ApprovalBanner> and <VersionDiff> from canonical paths', () => {
        expect(source).toMatch(
            /import\s*\{\s*ApprovalBanner\s*\}\s*from\s*['"]@\/components\/ui\/ApprovalBanner['"]/,
        );
        expect(source).toMatch(
            /import\s*\{\s*VersionDiff\s*\}\s*from\s*['"]@\/components\/ui\/VersionDiff['"]/,
        );
    });

    it('mounts <ApprovalBanner> only when the policy is IN_REVIEW + a PENDING approval exists', () => {
        // Two-condition gate: status check + presence of an active
        // PENDING row. The banner stays informational for non-actors
        // (canDecide=false), and the actions are gated by canAdmin.
        expect(source).toMatch(
            /policy\.status === ['"]IN_REVIEW['"][\s\S]{0,200}<ApprovalBanner/,
        );
        expect(source).toMatch(/canDecide=\{canAdmin\}/);
    });

    it('finds the most recent PENDING approval and surfaces version metadata to the banner', () => {
        // The page derives `pendingApproval` by finding a PENDING row
        // in `policy.approvals` then matching its policyVersionId
        // back into `policy.versions` for the version-number badge.
        expect(source).toContain(
            "pending = all.find((a) => a.status === 'PENDING')",
        );
        expect(source).toContain('matchingVersion?.versionNumber');
    });

    it('forwards onDecide to the existing decideApproval flow', () => {
        // The banner doesn't reinvent the decide path — it dispatches
        // through the page's `decideApproval` which POSTs to the
        // existing /policies/:id/approval/:approvalId/decide route.
        expect(source).toMatch(
            /<ApprovalBanner[\s\S]{0,400}onDecide=\{[\s\S]{0,200}decideApproval\(/,
        );
    });

    it('mounts <VersionDiff> in the Versions tab when 2+ versions exist', () => {
        expect(source).toMatch(/versions\.length\s*>=\s*2[\s\S]{0,200}<VersionDiff/);
        // Picker driven by the policy's actual versions array; no
        // hidden synthetic shape.
        expect(source).toMatch(/<VersionDiff[\s\S]{0,400}versions=\{versions\.map/);
    });

    it('reuses the existing decideApproval handler — no parallel approval path', () => {
        // The banner's decide flow MUST go through the same
        // POST /policies/:id/approval/:approvalId/decide route the
        // legacy in-version approval buttons used.
        expect(source).toContain(
            "fetch(apiUrl(`/policies/${policyId}/approval/",
        );
    });
});
