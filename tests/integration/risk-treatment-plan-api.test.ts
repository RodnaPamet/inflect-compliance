/**
 * Epic G-7 — API contract tests for the risk-scoped treatment-plan
 * surface + risk-detail wiring.
 */
import * as fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('Epic G-7 — treatment-plan API + UI wiring', () => {
    const listRoute = read(
        'src/app/api/t/[tenantSlug]/risks/[id]/treatment-plans/route.ts',
    );
    const detailRoute = read(
        'src/app/api/t/[tenantSlug]/risks/[id]/treatment-plans/[planId]/route.ts',
    );
    const milestonesRoute = read(
        'src/app/api/t/[tenantSlug]/risks/[id]/treatment-plans/[planId]/milestones/route.ts',
    );
    const completeMilestoneRoute = read(
        'src/app/api/t/[tenantSlug]/risks/[id]/treatment-plans/[planId]/milestones/[milestoneId]/complete/route.ts',
    );
    const completePlanRoute = read(
        'src/app/api/t/[tenantSlug]/risks/[id]/treatment-plans/[planId]/complete/route.ts',
    );
    const card = read('src/components/risks/RiskTreatmentPlanCard.tsx');
    // P1 — the treatment plan card moved from the detail page (Overview) into
    // the guided assessment panel (Step 4), so the whole lifecycle lives in
    // one narrated path.
    const assessmentPanel = read(
        'src/app/t/[tenantSlug]/(app)/risks/[riskId]/RiskAssessmentPanel.tsx',
    );

    // ── Route delegates ─────────────────────────────────────────────

    it('list/create route delegates correctly + validates body', () => {
        expect(listRoute).toMatch(/export const GET/);
        expect(listRoute).toMatch(/export const POST/);
        expect(listRoute).toContain('listTreatmentPlans');
        expect(listRoute).toContain('createTreatmentPlan');
        expect(listRoute).toContain('CreateTreatmentPlanSchema');
        expect(listRoute).toContain('withValidatedBody');
    });

    it('detail route verifies risk-vs-plan hierarchy', () => {
        expect(detailRoute).toContain('getTreatmentPlan');
        expect(detailRoute).toContain('plan.riskId !== params.id');
    });

    it('milestone routes are typed + validated', () => {
        expect(milestonesRoute).toContain('addMilestone');
        expect(milestonesRoute).toContain('AddMilestoneSchema');
        expect(milestonesRoute).toContain('withValidatedBody');
        expect(completeMilestoneRoute).toContain('completeMilestone');
        expect(completeMilestoneRoute).toContain('CompleteMilestoneSchema');
    });

    it('complete-plan route is typed + validated', () => {
        expect(completePlanRoute).toContain('completePlan');
        expect(completePlanRoute).toContain('CompletePlanSchema');
        expect(completePlanRoute).toContain('withValidatedBody');
    });

    // ── Tenant scoping invariant ────────────────────────────────────

    it('every route uses getTenantCtx', () => {
        for (const src of [
            listRoute,
            detailRoute,
            milestonesRoute,
            completeMilestoneRoute,
            completePlanRoute,
        ]) {
            expect(src).toContain('getTenantCtx');
        }
    });

    it('list POST rejects body riskId / URL id mismatch', () => {
        expect(listRoute).toContain('body.riskId !== params.id');
    });

    // ── Card surfaces canonical workflow buttons ────────────────────

    it('card exposes create / add-milestone / complete testids', () => {
        expect(card).toContain('risk-treatment-plan-card');
        expect(card).toContain('treatment-plan-create-button');
        expect(card).toContain('treatment-plan-add-milestone-button');
        expect(card).toContain('treatment-plan-complete-button');
        expect(card).toContain('treatment-plan-progress');
        expect(card).toContain('treatment-plan-strategy-badge');
        expect(card).toContain('treatment-plan-form-strategy');
        expect(card).toContain('treatment-plan-form-owner');
        expect(card).toContain('treatment-plan-form-submit');
        expect(card).toContain('milestone-form-title');
        expect(card).toContain('milestone-form-submit');
        expect(card).toContain('complete-plan-remark');
        expect(card).toContain('complete-plan-submit');
    });

    it('card uses the canonical usecases through the API — no raw Prisma', () => {
        expect(card).not.toContain('@/lib/prisma');
        // Mutations only via fetch on the documented routes.
        expect(card).toContain('/treatment-plans');
        expect(card).toContain('/milestones');
        expect(card).toContain('/complete');
    });

    // ── Guided assessment (Step 4) mounts the card ─────────────────

    it('the assessment panel imports and mounts the card with permissions + a real owner roster', () => {
        expect(assessmentPanel).toContain('RiskTreatmentPlanCard');
        expect(assessmentPanel).toMatch(/canWrite=\{canWrite\}/);
        expect(assessmentPanel).toMatch(/canAdmin=\{canAdmin\}/);
        expect(assessmentPanel).toMatch(/tenantSlug=\{tenantSlug\}/);
        // P1 — the owner CTA is now fillable (was ownerChoices={[]}).
        expect(assessmentPanel).toMatch(/ownerChoices=\{ownerChoices\}/);
    });
});
