/**
 * Policy review-workflow + evidence-to-retain ratchet.
 *
 * Locks the load-bearing pieces of the canonical-skeleton / review-cadence
 * / evidence-linkage feature:
 *
 *   1. Policy carries the review fields (ownerUserId / reviewFrequencyDays /
 *      nextReviewAt / lastReviewedAt) and the PolicyEvidenceItem model exists.
 *   2. The review-reminder job exists AND is registered (schedules + executor).
 *   3. createPolicyFromTemplate pre-fills the cadence (parse runs) + seeds
 *      evidence-to-retain checklist items.
 *   4. markPolicyReviewed recomputes nextReviewAt + audits.
 *   5. The canonical-skeleton lint helper exists (warning-level) and the
 *      cadence/evidence parsers actually work on the imported templates.
 *   6. The detail page flags overdue policies + exposes "mark reviewed".
 *
 * Credit: section skeleton adapted from ciso-toolkit (MIT).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    CANONICAL_POLICY_SECTIONS,
    lintPolicySkeleton,
    parseReviewCadenceDays,
    parseEvidenceToRetain,
} from '@/lib/policy/template-skeleton';
import { readPrismaSchema } from '../helpers/prisma-schema';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('policy review workflow — schema', () => {
    const schema = readPrismaSchema();

    it('Policy carries the four review fields', () => {
        const model = schema.slice(schema.indexOf('model Policy {'), schema.indexOf('model PolicyApproval'));
        for (const f of ['ownerUserId', 'reviewFrequencyDays', 'nextReviewAt', 'lastReviewedAt']) {
            expect(model).toContain(f);
        }
    });

    it('PolicyEvidenceItem model exists, tenant-scoped, with an optional evidence link', () => {
        const m = schema.slice(schema.indexOf('model PolicyEvidenceItem {'));
        const body = m.slice(0, m.indexOf('\n}'));
        expect(body).toMatch(/tenantId\s+String/);
        expect(body).toMatch(/policyId\s+String/);
        expect(body).toMatch(/label\s+String/);
        expect(body).toMatch(/evidenceId\s+String\?/);
        expect(body).toMatch(/evidence\s+Evidence\?/);
        expect(body).toMatch(/@@index\(\[tenantId, policyId\]\)/);
    });
});

describe('policy review workflow — job registration', () => {
    it('the policy-review-reminder job is scheduled + registered', () => {
        expect(read('src/app-layer/jobs/schedules.ts')).toContain("'policy-review-reminder'");
        expect(read('src/app-layer/jobs/executor-registry.ts')).toContain("'policy-review-reminder'");
    });

    it('the reminder job uses the tenant reminder window + notifies + emits automation', () => {
        const job = read('src/app-layer/jobs/policyReviewReminder.ts');
        expect(job).toMatch(/reminderDaysBefore/);
        expect(job).toMatch(/notificationOutbox/);
        expect(job).toMatch(/type: 'POLICY_REVIEW_DUE'/); // notification type
        expect(job).toMatch(/event: 'POLICY_REVIEW_DUE'/); // automation emit (kept)
    });
});

describe('policy review workflow — usecases', () => {
    const usecase = read('src/app-layer/usecases/policy.ts');

    it('createPolicyFromTemplate pre-fills cadence + seeds evidence items (parse runs)', () => {
        const start = usecase.indexOf('export async function createPolicyFromTemplate');
        const body = usecase.slice(start, usecase.indexOf('export async function', start + 1));
        expect(body).toMatch(/parseReviewCadenceDays\(template\.contentText\)/);
        expect(body).toMatch(/parseEvidenceToRetain\(template\.contentText\)/);
        expect(body).toMatch(/policyEvidenceItem\.createMany/);
        // owner defaults to the creating user.
        expect(body).toMatch(/ownerUserId:\s*overrides\?\.ownerUserId\s*\?\?\s*ctx\.userId/);
    });

    it('the policy-review cadence rule has exactly one implementation, and markPolicyReviewed delegates to it', () => {
        // `applyPolicyReviewed` is the single implementation of "this policy
        // was reviewed" — `markPolicyReviewed` and the task→source reconciler
        // both call it, so they cannot diverge. (The reconciler used to carry
        // a private copy that wrote `nextReviewAt = null` for a cadence-less
        // policy, silently dropping it out of the reminder sweep forever.)
        // The BEHAVIOUR — recompute with a cadence, PRESERVE a manually-set
        // date without one — is proven end-to-end in
        // tests/integration/task-source-reconcile-invariants.test.ts.
        const bodyOf = (name: string) => {
            const start = usecase.indexOf(`export async function ${name}`);
            expect(start).toBeGreaterThan(-1);
            const end = usecase.indexOf('\nexport ', start + 1);
            return usecase.slice(start, end === -1 ? undefined : end);
        };

        const shared = bodyOf('applyPolicyReviewed');
        expect(shared).toMatch(/reviewFrequencyDays \* 86_400_000/);
        expect(shared).toMatch(/lastReviewedAt: now/);
        expect(shared).toMatch(/action: 'POLICY_REVIEWED'/);

        const wrapper = bodyOf('markPolicyReviewed');
        expect(wrapper).toMatch(/applyPolicyReviewed\(db, ctx, policy/);
        // No second copy of the cadence arithmetic in the wrapper.
        expect(wrapper).not.toMatch(/86_400_000/);
    });

    it('the explicit evidence link/unlink usecases exist', () => {
        const ev = read('src/app-layer/usecases/policy-evidence.ts');
        expect(ev).toMatch(/export async function linkPolicyEvidenceItem/);
        expect(ev).toMatch(/export async function unlinkPolicyEvidenceItem/);
        expect(ev).toMatch(/action: 'POLICY_EVIDENCE_LINKED'/);
    });
});

describe('policy review workflow — canonical skeleton + parsers', () => {
    it('exposes the canonical section list + a warning-level lint', () => {
        expect(CANONICAL_POLICY_SECTIONS).toContain('Evidence to Retain');
        expect(CANONICAL_POLICY_SECTIONS).toContain('Document Control');
        const result = lintPolicySkeleton('# Title\n## Purpose & Scope\nbody');
        expect(result.missing).toContain('Document Control'); // warning, not throw
        expect(result.conforms).toBe(false);
    });

    it('the cadence + evidence parsers work on the imported ciso-toolkit templates', () => {
        const fixture = JSON.parse(read('prisma/fixtures/policy-templates-ciso-toolkit.json')) as {
            templates: Array<{ externalRef: string; contentText: string }>;
        };
        let cadenceHits = 0;
        let evidenceHits = 0;
        for (const t of fixture.templates) {
            expect(lintPolicySkeleton(t.contentText).conforms).toBe(true);
            const days = parseReviewCadenceDays(t.contentText);
            if (days) cadenceHits++;
            if (parseEvidenceToRetain(t.contentText).length) evidenceHits++;
        }
        // Every toolkit template states an (annual) cadence + evidence list.
        expect(cadenceHits).toBe(fixture.templates.length);
        expect(evidenceHits).toBe(fixture.templates.length);
        // Annual cadence snaps to 365.
        expect(parseReviewCadenceDays(fixture.templates[0].contentText)).toBe(365);
    });
});

describe('policy review workflow — detail page', () => {
    const page = read('src/app/t/[tenantSlug]/(app)/policies/[policyId]/page.tsx');

    it('flags overdue review with a warning tone + exposes a mark-reviewed action', () => {
        expect(page).toMatch(/const isOverdue =/);
        expect(page).toMatch(/'critical'/); // MetaStrip overdue tone
        expect(page).toMatch(/mark-reviewed-btn/);
        expect(page).toMatch(/markReviewed/);
    });

    it('renders the evidence-to-retain checklist', () => {
        expect(page).toMatch(/PolicyEvidenceChecklist/);
    });

    it('keys the version "Published" badge off lifecycle status, not currentVersionId', () => {
        // Regression guard: a fresh draft / template-created policy has
        // currentVersionId set (so the Current tab has content) but
        // status DRAFT. The Versions tab must NOT call that "Published".
        expect(page).toMatch(/isPublishedVersion\s*=\s*isCurrentVersion\s*&&\s*policy\.status === 'PUBLISHED'/);
        // The publish badge + the Request Approval / Publish gating all
        // hang off isPublishedVersion, never a bare currentVersionId check.
        expect(page).not.toMatch(/isCurrentPublished/);
        // "Published" badge label moved to next-intl; assert the key + its en value.
        expect(page).toMatch(/isPublishedVersion && <StatusBadge variant="success">\{t\('detail\.published'\)\}/);
        const en = JSON.parse(read('messages/en.json')) as {
            policies: { detail: Record<string, string> };
        };
        expect(en.policies.detail.published).toBe('Published');
    });

    it('surfaces the next publication step from the Current tab', () => {
        // DRAFT / APPROVED actions live in the Versions tab — the Current
        // view points the user there so the flow is discoverable.
        expect(page).toMatch(/goto-versions-btn/);
        expect(page).toMatch(/setTab\('versions'\)/);
    });

    it('clarifies that "Mark reviewed" does not change publication status', () => {
        // Tooltip copy moved into the catalog (next-intl); assert the key + its value.
        expect(page).toMatch(/markReviewedTooltip/);
        const en = JSON.parse(read('messages/en.json')) as {
            policies: { detail: Record<string, string> };
        };
        expect(en.policies.detail.markReviewedTooltip).toMatch(/does not change the publication status/);
        // Success feedback so the (otherwise subtle) action is visible.
        expect(page).toMatch(/toast\.success\(/);
    });
});
