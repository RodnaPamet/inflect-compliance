/* eslint-disable @typescript-eslint/no-explicit-any */
import { RequestContext } from '../types';
import { OnboardingRepository } from '../repositories/OnboardingRepository';
import { assertCanManageOnboarding } from '../policies/onboarding.policies';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest } from '@/lib/errors/types';
import {
    emitOnboardingStarted,
    emitOnboardingStepCompleted,
    emitOnboardingFinished,
    emitOnboardingRestarted,
} from '../events/onboarding.events';
import { runStepAction, storeActionResult } from './onboarding-automation';
import { logger } from '@/lib/observability/logger';
import {
    recordOnboardingStepCompleted,
    recordOnboardingCompleted,
} from '@/lib/observability/business-metrics';

// ─── Step keys & ordering ───

const STEP_ORDER = [
    'COMPANY_PROFILE',
    'FRAMEWORK_SELECTION',
    // Conditional — only when NIS2 is selected (see isStepApplicable).
    'NIS2_SELF_ASSESSMENT',
    // Conditional — only when an AI framework is selected OR the tenant builds/
    // uses AI systems (see isStepApplicable).
    'AI_GOVERNANCE_SELF_ASSESSMENT',
    // Conditional — only when an EU digital-regulation framework (NIS2, DORA,
    // EU AI Act) is selected (see isStepApplicable).
    'SOVEREIGNTY_SELF_ASSESSMENT',
    'ASSET_SETUP',
    'CONTROL_BASELINE_INSTALL',
    'INITIAL_RISK_REGISTER',
    'TEAM_SETUP',
    'REVIEW_AND_FINISH',
] as const;

type OnboardingStep = (typeof STEP_ORDER)[number];

/**
 * Is this step applicable given the tenant's choices so far? A
 * non-applicable step is never shown and is excluded from the
 * progress denominator. Today only NIS2_SELF_ASSESSMENT is
 * conditional — it appears iff NIS2 is among the selected frameworks.
 */
export function isStepApplicable(
    step: OnboardingStep,
    stepData: Record<string, any>,
): boolean {
    if (step === 'NIS2_SELF_ASSESSMENT') {
        const fws: string[] =
            stepData?.FRAMEWORK_SELECTION?.selectedFrameworks ?? [];
        // Case-insensitive: the wizard's framework picker stores LOWERCASE
        // keys ('nis2'), while other call sites may use the canonical
        // 'NIS2'. Match either so the step actually appears.
        return Array.isArray(fws) && fws.some((f) => String(f).toUpperCase() === 'NIS2');
    }
    if (step === 'AI_GOVERNANCE_SELF_ASSESSMENT') {
        // Applicable when ANY AI framework is selected OR the tenant flagged
        // that it builds/uses AI systems in COMPANY_PROFILE. Otherwise the step
        // is never shown and is excluded from the progress denominator.
        const fws: string[] =
            stepData?.FRAMEWORK_SELECTION?.selectedFrameworks ?? [];
        const AI_FWS = new Set(['AISVS', 'ISO42001', 'EU_AI_ACT', 'EU-AI-ACT', 'OWASP-AISVS', 'AIUC-1']);
        const hasAiFramework =
            Array.isArray(fws) && fws.some((f) => AI_FWS.has(String(f).toUpperCase().replace(/\s+/g, '')));
        const buildsAi = stepData?.COMPANY_PROFILE?.usesAiSystems === true;
        return hasAiFramework || buildsAi;
    }
    if (step === 'SOVEREIGNTY_SELF_ASSESSMENT') {
        // Applicable when an EU digital-regulation framework is selected. Uses
        // the same EU keys the framework picker badges 'EU' (NIS2, DORA,
        // EU AI Act). Case/format-insensitive so a legacy lowercase 'nis2' or
        // an 'EU-AI-ACT' variant still matches. Otherwise the step is never
        // shown and is excluded from the progress denominator.
        const fws: string[] =
            stepData?.FRAMEWORK_SELECTION?.selectedFrameworks ?? [];
        const EU_FWS = new Set(['NIS2', 'DORA', 'EU_AI_ACT', 'EU-AI-ACT', 'EUAIACT']);
        return (
            Array.isArray(fws) &&
            fws.some((f) => EU_FWS.has(String(f).toUpperCase().replace(/\s+/g, '')))
        );
    }
    return true;
}

/**
 * Next step AFTER `currentStep`, skipping any non-applicable steps so a
 * non-NIS2 tenant never lands on NIS2_SELF_ASSESSMENT. Returns
 * `currentStep` when there is no further applicable step.
 */
function getNextStep(
    currentStep: OnboardingStep,
    stepData: Record<string, any> = {},
): string {
    const idx = STEP_ORDER.indexOf(currentStep);
    if (idx < 0) return currentStep;
    for (let i = idx + 1; i < STEP_ORDER.length; i++) {
        if (isStepApplicable(STEP_ORDER[i], stepData)) return STEP_ORDER[i];
    }
    return currentStep;
}

// ─── Get State ───

/**
 * Returns the current onboarding state for the tenant.
 * If no record exists, auto-creates one with NOT_STARTED status.
 */
export async function getOnboardingState(ctx: RequestContext) {
    return runInTenantContext(ctx, async (db) => {
        const existing = await OnboardingRepository.getByTenantId(db, ctx);
        if (existing) return existing;

        const initial = await OnboardingRepository.upsertInitial(db, ctx);
        return initial;
    });
}

// ─── Start Onboarding ───

/**
 * Starts the onboarding wizard. Idempotent — calling multiple times is safe.
 * Admin-only.
 */
export async function startOnboarding(ctx: RequestContext) {
    assertCanManageOnboarding(ctx);
    logger.info('onboarding started', { component: 'onboarding' });
    return runInTenantContext(ctx, async (db) => {
        const existing = await OnboardingRepository.getByTenantId(db, ctx);
        if (existing && existing.status === 'IN_PROGRESS') {
            return existing;
        }

        const record = await OnboardingRepository.start(db, ctx);
        await emitOnboardingStarted(db, ctx);
        return record;
    });
}

// ─── Save Step Data ───

/**
 * Persists step-specific payload data without marking the step as complete.
 * Useful for saving partial form data (resume support).
 * Admin-only.
 */

export async function saveOnboardingStep(ctx: RequestContext, step: OnboardingStep, data: Record<string, any>) {
    assertCanManageOnboarding(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await OnboardingRepository.getByTenantId(db, ctx);
        if (!existing || existing.status !== 'IN_PROGRESS') {
            throw badRequest('Onboarding must be started before saving step data.');
        }
        return OnboardingRepository.saveStepData(db, ctx, step, data);
    });
}

// ─── Complete Step ───

/**
 * Marks a step as completed, advances currentStep, and runs the automation action.
 * Idempotent — completing an already-completed step is a no-op.
 * Admin-only.
 *
 * Architecture note: The step completion (lightweight DB updates) runs inside
 * a Prisma transaction for RLS enforcement. The automation action (e.g. installing
 * framework packs with dozens of controls/tasks) runs AFTER the transaction commits
 * to avoid exceeding Prisma's interactive transaction timeout (5s default).
 * The automation is fire-and-forget — failures are logged but don't block the wizard.
 */
export async function completeOnboardingStep(ctx: RequestContext, step: OnboardingStep) {
    assertCanManageOnboarding(ctx);

    // Phase 1: Complete the step inside a transaction (lightweight, fast)
    const record = await runInTenantContext(ctx, async (db) => {
        const existing = await OnboardingRepository.getByTenantId(db, ctx);
        if (!existing || existing.status !== 'IN_PROGRESS') {
            throw badRequest('Onboarding must be started before completing steps.');
        }

        // Idempotent: already completed
        if (existing.completedSteps.includes(step)) {
            return existing;
        }

        const nextStep = getNextStep(step, (existing.stepData as Record<string, any>) || {});
        const stepRecord = await OnboardingRepository.completeStep(db, ctx, step, nextStep);
        await emitOnboardingStepCompleted(db, ctx, step);
        // Genuine-completion path only (the idempotent early-return above
        // never reaches here, so a repeat call does not double-count).
        recordOnboardingStepCompleted({ step });

        // If step was previously skipped, remove from skipped list

        const stepData = (stepRecord.stepData as Record<string, any>) || {};
        const skippedSteps: string[] = stepData._skippedSteps || [];
        if (skippedSteps.includes(step)) {
            const updated = skippedSteps.filter(s => s !== step);
            await OnboardingRepository.saveStepData(db, ctx, '_skippedSteps', updated);
        }

        return stepRecord;
    });

    // Phase 2: Run automation AFTER the transaction commits (heavy, may be slow)
    // This runs outside the transaction so it won't cause timeout issues.
    // Errors are logged but don't block the wizard response.
    try {

        const allData = (record.stepData as Record<string, any>) || {};
        const sd = allData[step] || {};
        const result = await runStepAction(ctx, step, sd, allData);
        if (result) {
            logger.info('onboarding automation completed', {
                component: 'onboarding', step, action: result.action,
                created: result.created, skipped: result.skipped,
            });
            await storeActionResult(ctx, step, result);
        }
    } catch (e) {
        logger.warn('onboarding automation failed', {
            component: 'onboarding', step,
            error: e instanceof Error ? { name: e.name, message: e.message } : { name: 'UnknownError', message: String(e) },
        });
    }

    logger.info('onboarding step completed', { component: 'onboarding', step });
    return record;
}

// ─── Skip Step ───

/**
 * Marks a step as skipped (recorded in stepData._skippedSteps).
 * Advances the currentStep to the next step.
 * Admin-only.
 */
export async function skipOnboardingStep(ctx: RequestContext, step: OnboardingStep) {
    assertCanManageOnboarding(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await OnboardingRepository.getByTenantId(db, ctx);
        if (!existing || existing.status !== 'IN_PROGRESS') {
            throw badRequest('Onboarding must be started before skipping steps.');
        }


        const stepData = (existing.stepData as Record<string, any>) || {};
        const skippedSteps: string[] = stepData._skippedSteps || [];
        if (!skippedSteps.includes(step)) {
            skippedSteps.push(step);
        }

        await OnboardingRepository.saveStepData(db, ctx, '_skippedSteps', skippedSteps);

        const nextStep = getNextStep(step, stepData);
        return OnboardingRepository.completeStep(db, ctx, step, nextStep);
    });
}

// ─── Finish Onboarding ───

/**
 * Marks the entire onboarding as COMPLETED.
 * Admin-only.
 */
export async function finishOnboarding(ctx: RequestContext) {
    assertCanManageOnboarding(ctx);
    const { record, startedAt } = await runInTenantContext(ctx, async (db) => {
        const existing = await OnboardingRepository.getByTenantId(db, ctx);
        if (!existing || existing.status !== 'IN_PROGRESS') {
            throw badRequest('Onboarding must be in progress to finish.');
        }

        const record = await OnboardingRepository.finish(db, ctx);
        await emitOnboardingFinished(db, ctx);
        logger.info('onboarding finished', { component: 'onboarding' });
        return { record, startedAt: existing.startedAt };
    });
    recordOnboardingCompleted({
        timeToCompleteMs: startedAt ? Date.now() - new Date(startedAt).getTime() : 0,
    });
    return record;
}

// ─── Restart Onboarding ───

/**
 * Resets the onboarding to NOT_STARTED state.
 * Admin-only.
 */
export async function restartOnboarding(ctx: RequestContext) {
    assertCanManageOnboarding(ctx);
    return runInTenantContext(ctx, async (db) => {
        const record = await OnboardingRepository.reset(db, ctx);
        await emitOnboardingRestarted(db, ctx);
        return record;
    });
}

// ─── Metrics ───

/**
 * Returns summary metrics for the onboarding wizard.
 */
export async function getOnboardingMetrics(ctx: RequestContext) {
    assertCanManageOnboarding(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await OnboardingRepository.getByTenantId(db, ctx);
        if (!existing) {
            return {
                status: 'NOT_STARTED',
                completedSteps: 0,
                totalSteps: STEP_ORDER.length,
                progress: 0,
            };
        }

        // Exclude non-applicable steps (e.g. NIS2_SELF_ASSESSMENT for a
        // non-NIS2 tenant) from BOTH numerator and denominator — otherwise
        // a tenant that can never reach a step is stuck below 100% forever.
        const stepData = (existing.stepData as Record<string, any>) || {};
        const applicableSteps = STEP_ORDER.filter((s) => isStepApplicable(s, stepData));
        const applicableCompleted = existing.completedSteps.filter((s) =>
            (applicableSteps as readonly string[]).includes(s),
        );
        return {
            status: existing.status,
            currentStep: existing.currentStep,
            completedSteps: applicableCompleted.length,
            totalSteps: applicableSteps.length,
            progress: applicableSteps.length
                ? Math.round((applicableCompleted.length / applicableSteps.length) * 100)
                : 0,
            startedAt: existing.startedAt,
            completedAt: existing.completedAt,
        };
    });
}

// ─── Completion Criteria (pure function, tested directly) ───

/**
 * Pure function that checks whether the onboarding wizard is ready to be finished.
 * Returns an array of human-readable issue strings (empty = ready to finish).
 *
 * Rules:
 *  1. COMPANY_PROFILE and REVIEW_AND_FINISH are required — must be completed.
 *  2. Other steps can be skipped.
 *  3. If FRAMEWORK_SELECTION was completed (not skipped) AND frameworks were selected,
 *     then CONTROL_BASELINE_INSTALL must be completed or skipped.
 *  4. If no frameworks were selected (or FRAMEWORK_SELECTION was skipped),
 *     CONTROL_BASELINE_INSTALL is not required.
 */

export function checkCompletionCriteria(
    completedSteps: string[],
    skippedSteps: string[],
    stepData: Record<string, any>,
): string[] {
    const issues: string[] = [];

    // Rule 1: Required steps must be completed
    if (!completedSteps.includes('COMPANY_PROFILE')) {
        issues.push('Company profile step must be completed.');
    }
    if (!completedSteps.includes('REVIEW_AND_FINISH')) {
        issues.push('Review step must be completed.');
    }

    // Rule 3/4: Framework → Control dependency
    const fwCompleted = completedSteps.includes('FRAMEWORK_SELECTION');
    const selectedFrameworks: string[] = stepData?.FRAMEWORK_SELECTION?.selectedFrameworks || [];
    const hasFrameworks = fwCompleted && selectedFrameworks.length > 0;

    if (hasFrameworks) {
        const controlCompleted = completedSteps.includes('CONTROL_BASELINE_INSTALL');
        const controlSkipped = skippedSteps.includes('CONTROL_BASELINE_INSTALL');
        if (!controlCompleted && !controlSkipped) {
            issues.push('Control baseline install must be completed or skipped when frameworks are selected.');
        }
    }

    return issues;
}
