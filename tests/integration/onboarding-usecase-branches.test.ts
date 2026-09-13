/**
 * Branch-coverage integration test for the onboarding usecases —
 * exercises the admin permission denials, the "must be started"
 * badRequest guards, the start idempotency branch, save/complete/skip
 * step progression (including the NIS2-applicable nextStep branch, the
 * idempotent already-completed early-return, and the skipped-step
 * removal branch), finish + restart, the metrics applicable-filter +
 * no-record branches, and the exported pure functions
 * (isStepApplicable, checkCompletionCriteria).
 *
 * Hits a real DB (project convention).
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    getOnboardingState,
    startOnboarding,
    saveOnboardingStep,
    completeOnboardingStep,
    skipOnboardingStep,
    finishOnboarding,
    restartOnboarding,
    getOnboardingMetrics,
    isStepApplicable,
    checkCompletionCriteria,
} from '@/app-layer/usecases/onboarding';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `onb-br-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;
const OTHER_TENANT_ID = `t2-${SUITE_TAG}`;

let ownerUserId: string;
let editorUserId: string;
let ctx: ReturnType<typeof makeRequestContext>;
let editor: ReturnType<typeof makeRequestContext>;
let ctxOther: ReturnType<typeof makeRequestContext>;

async function makeUser(label: string, role: Role): Promise<string> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: u.id, role, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

describeFn('onboarding usecase — branch coverage (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        await globalPrisma.tenant.upsert({
            where: { id: OTHER_TENANT_ID },
            update: {},
            create: { id: OTHER_TENANT_ID, name: `t2 ${SUITE_TAG}`, slug: `${SUITE_TAG}-2` },
        });
        ownerUserId = await makeUser('owner', Role.OWNER);
        editorUserId = await makeUser('editor', Role.EDITOR);
        ctx = makeRequestContext('OWNER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: ownerUserId });
        editor = makeRequestContext('EDITOR', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: editorUserId });
        ctxOther = makeRequestContext('OWNER', { tenantId: OTHER_TENANT_ID, tenantSlug: `${SUITE_TAG}-2`, userId: ownerUserId });
    });

    afterAll(async () => {
        await globalPrisma.tenantOnboarding.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
        await globalPrisma.task.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
        await deleteAuditRowsForTenants(globalPrisma, [TENANT_ID, OTHER_TENANT_ID]);
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" IN ($1, $2)`, TENANT_ID, OTHER_TENANT_ID);
        });
        await globalPrisma.user.deleteMany({ where: { id: { in: [ownerUserId, editorUserId] } } });
        await globalPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
        await globalPrisma.$disconnect();
    });

    it('non-admin is denied every onboarding management action', async () => {
        await expect(startOnboarding(editor)).rejects.toThrow(/administrator/i);
        await expect(saveOnboardingStep(editor, 'COMPANY_PROFILE' as any, {})).rejects.toThrow(/administrator/i);
        await expect(completeOnboardingStep(editor, 'COMPANY_PROFILE' as any)).rejects.toThrow(/administrator/i);
        await expect(skipOnboardingStep(editor, 'COMPANY_PROFILE' as any)).rejects.toThrow(/administrator/i);
        await expect(finishOnboarding(editor)).rejects.toThrow(/administrator/i);
        await expect(restartOnboarding(editor)).rejects.toThrow(/administrator/i);
        await expect(getOnboardingMetrics(editor)).rejects.toThrow(/administrator/i);
    });

    it('full lifecycle: guards, start, save/skip/complete progression, finish, restart', async () => {
        // getOnboardingState auto-creates a NOT_STARTED record.
        const state = await getOnboardingState(ctx);
        expect(state.status).toBe('NOT_STARTED');

        // "must be started" guards (record exists but is NOT_STARTED).
        await expect(saveOnboardingStep(ctx, 'COMPANY_PROFILE' as any, {})).rejects.toThrow(/must be started/i);
        await expect(completeOnboardingStep(ctx, 'COMPANY_PROFILE' as any)).rejects.toThrow(/must be started/i);
        await expect(skipOnboardingStep(ctx, 'COMPANY_PROFILE' as any)).rejects.toThrow(/must be started/i);
        await expect(finishOnboarding(ctx)).rejects.toThrow(/in progress/i);

        // start → IN_PROGRESS; start again returns the existing in-progress record.
        const started = await startOnboarding(ctx);
        expect(started.status).toBe('IN_PROGRESS');
        const startedAgain = await startOnboarding(ctx);
        expect(startedAgain.status).toBe('IN_PROGRESS');

        // save framework selection with NIS2 so the conditional step becomes applicable.
        await saveOnboardingStep(ctx, 'FRAMEWORK_SELECTION' as any, { selectedFrameworks: ['nis2'] });

        // skip FRAMEWORK_SELECTION → getNextStep lands on NIS2_SELF_ASSESSMENT (applicable branch).
        const skipped = await skipOnboardingStep(ctx, 'FRAMEWORK_SELECTION' as any);
        expect(skipped.currentStep).toBe('NIS2_SELF_ASSESSMENT');
        // skip the same step again → no-dup branch.
        await skipOnboardingStep(ctx, 'FRAMEWORK_SELECTION' as any);

        // skip then complete COMPANY_PROFILE → exercises the skipped-step removal branch.
        await skipOnboardingStep(ctx, 'COMPANY_PROFILE' as any);
        await skipOnboardingStep(ctx, 'COMPANY_PROFILE' as any); // already-skipped no-dup
        const completed = await completeOnboardingStep(ctx, 'COMPANY_PROFILE' as any);
        expect(completed.completedSteps).toContain('COMPANY_PROFILE');

        // completing an already-completed step → idempotent early-return branch.
        await completeOnboardingStep(ctx, 'COMPANY_PROFILE' as any);

        // a second genuine completion (no automation for REVIEW_AND_FINISH).
        await completeOnboardingStep(ctx, 'REVIEW_AND_FINISH' as any);

        // TEAM_SETUP has automation that returns a result → exercises the
        // Phase-2 success branch (result-truthy log + storeActionResult).
        await completeOnboardingStep(ctx, 'TEAM_SETUP' as any);

        // metrics applicable-filter branch (NIS2 applicable → counted).
        const metrics = await getOnboardingMetrics(ctx);
        expect(metrics.status).toBe('IN_PROGRESS');
        expect(metrics.totalSteps).toBeGreaterThanOrEqual(1);
        expect(metrics.completedSteps).toBeGreaterThanOrEqual(1);

        // finish → COMPLETED; finishing again → badRequest.
        const finished = await finishOnboarding(ctx);
        expect(finished.status).toBe('COMPLETED');
        await expect(finishOnboarding(ctx)).rejects.toThrow(/in progress/i);

        // restart → NOT_STARTED.
        const restarted = await restartOnboarding(ctx);
        expect(restarted.status).toBe('NOT_STARTED');
    });

    it('getOnboardingMetrics returns NOT_STARTED when no record exists', async () => {
        const metrics = await getOnboardingMetrics(ctxOther);
        expect(metrics.status).toBe('NOT_STARTED');
        expect(metrics.completedSteps).toBe(0);
        expect(metrics.progress).toBe(0);
        expect(metrics.totalSteps).toBeGreaterThan(0);
    });

    it('isStepApplicable + checkCompletionCriteria pure-function branches', () => {
        // NIS2 conditional
        expect(isStepApplicable('NIS2_SELF_ASSESSMENT', {})).toBe(false);
        expect(isStepApplicable('NIS2_SELF_ASSESSMENT', { FRAMEWORK_SELECTION: { selectedFrameworks: ['NIS2'] } })).toBe(true);
        expect(isStepApplicable('NIS2_SELF_ASSESSMENT', { FRAMEWORK_SELECTION: { selectedFrameworks: ['iso27001'] } })).toBe(false);
        // selectedFrameworks not an array → Array.isArray guard branch
        expect(isStepApplicable('NIS2_SELF_ASSESSMENT', { FRAMEWORK_SELECTION: { selectedFrameworks: 'nis2' } } as any)).toBe(false);
        // non-conditional step always applicable
        expect(isStepApplicable('ASSET_SETUP', {})).toBe(true);

        // missing required steps → issues
        const issues = checkCompletionCriteria([], [], {});
        expect(issues).toEqual(expect.arrayContaining([expect.stringMatching(/company profile/i), expect.stringMatching(/review/i)]));

        // required completed, no frameworks → ready
        expect(checkCompletionCriteria(['COMPANY_PROFILE', 'REVIEW_AND_FINISH'], [], {})).toEqual([]);

        // frameworks selected but control not completed/skipped → issue
        const withFw = checkCompletionCriteria(
            ['COMPANY_PROFILE', 'REVIEW_AND_FINISH', 'FRAMEWORK_SELECTION'],
            [],
            { FRAMEWORK_SELECTION: { selectedFrameworks: ['iso27001'] } },
        );
        expect(withFw).toEqual([expect.stringMatching(/control baseline/i)]);

        // control skipped → ready
        const skippedControl = checkCompletionCriteria(
            ['COMPANY_PROFILE', 'REVIEW_AND_FINISH', 'FRAMEWORK_SELECTION'],
            ['CONTROL_BASELINE_INSTALL'],
            { FRAMEWORK_SELECTION: { selectedFrameworks: ['iso27001'] } },
        );
        expect(skippedControl).toEqual([]);
    });
});
