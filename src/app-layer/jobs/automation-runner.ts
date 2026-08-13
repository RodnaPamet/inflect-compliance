/**
 * Scheduled Automation Runner
 *
 * Cron-based job that finds Controls with automationKey configured,
 * determines which are due for execution, and dispatches checks.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * DUE-SELECTION RULES
 * ═══════════════════════════════════════════════════════════════════════
 *
 * A control is due for an automated check when ALL of:
 *   1. automationKey is set (non-null)
 *   2. evidenceSource = 'INTEGRATION' (explicitly opted in)
 *   3. Control is not soft-deleted (deletedAt is null)
 *   4. Control is APPLICABLE
 *   5. nextDueAt <= now (schedule window reached)
 *   6. No successful execution exists within the current frequency window
 *      (idempotency / duplicate-run protection)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * FREQUENCY → INTERVAL MAPPING
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   AD_HOC     → manual only (skipped by scheduler)
 *   DAILY      → 24 hours
 *   WEEKLY     → 7 days
 *   MONTHLY    → 30 days
 *   QUARTERLY  → 90 days
 *   ANNUALLY   → 365 days
 *
 * ═══════════════════════════════════════════════════════════════════════
 * RESULT MAPPING
 * ═══════════════════════════════════════════════════════════════════════
 *
 * After each check:
 *   - IntegrationExecution row created (PASSED/FAILED/ERROR)
 *   - Evidence row created (type: CONFIGURATION, source: integration)
 *   - Control.lastTested updated
 *   - Control.nextDueAt advanced to next window
 *
 * Usage (cron):
 *   import { runScheduledAutomations } from '@/app-layer/jobs/automation-runner';
 *   await runScheduledAutomations();                    // all tenants, now
 *   await runScheduledAutomations({ tenantId: 'xxx' }); // specific tenant
 *   await runScheduledAutomations({ dryRun: true });    // preview only
 *
 * @module jobs/automation-runner
 */
import { Prisma, EvidenceType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import '../integrations/bootstrap'; // populate the provider registry in THIS module graph (see usecases/integrations)
import { registry } from '../integrations/registry';
import { isScheduledCheckProvider, parseAutomationKey } from '../integrations/types';
import { recordCheckOutcome } from '@/lib/observability/integration-metrics';
import type { CheckInput, CheckResult } from '../integrations/types';
import { decryptField } from '@/lib/security/encryption';

// ─── Types ───────────────────────────────────────────────────────────

export interface AutomationRunnerOptions {
    tenantId?: string;
    now?: Date;
    dryRun?: boolean;
}

export interface AutomationRunnerResult {
    totalDue: number;
    executed: number;
    passed: number;
    failed: number;
    errors: number;
    notApplicable: number;
    skipped: number;
    dryRun: boolean;
    jobRunId: string;
}

interface DueControl {
    id: string;
    tenantId: string;
    automationKey: string;
    frequency: string | null;
    nextDueAt: Date | null;
    name: string;
}

// ─── Frequency → Interval Mapping ────────────────────────────────────

const FREQUENCY_INTERVALS_MS: Record<string, number> = {
    DAILY: 24 * 60 * 60 * 1000,
    WEEKLY: 7 * 24 * 60 * 60 * 1000,
    MONTHLY: 30 * 24 * 60 * 60 * 1000,
    QUARTERLY: 90 * 24 * 60 * 60 * 1000,
    ANNUALLY: 365 * 24 * 60 * 60 * 1000,
};

/**
 * Get the interval in ms for a given frequency.
 * Returns null for AD_HOC or unknown frequencies.
 */
export function getFrequencyIntervalMs(frequency: string | null): number | null {
    if (!frequency || frequency === 'AD_HOC') return null;
    return FREQUENCY_INTERVALS_MS[frequency] ?? null;
}

/**
 * Calculate the next due date given frequency and current due date.
 */
/**
 * Did this check actually observe anything?
 *
 * ERROR (broken collector, expired credentials, provider outage) and
 * NOT_APPLICABLE (empty population) are not answers — the check ran and
 * established nothing. Only PASSED and FAILED are real observations.
 *
 * This rule governs THREE writes and was previously spelled inline at each,
 * which is how it came to be applied at two of them and not the third: the
 * control's tested-state was advanced unconditionally, so a check that could
 * not run still reported the control as freshly tested and rolled its due date.
 *
 * The sibling on the manual/test-run path is `isAttestingVerdict`
 * (usecases/control/test-plans.ts), which is the same rule in that domain's
 * vocabulary (PASS/FAIL rather than PASSED/FAILED).
 */
export function isRealObservation(status: string | null | undefined): boolean {
    return status === 'PASSED' || status === 'FAILED';
}

export function computeNextDueAt(frequency: string | null, fromDate: Date): Date | null {
    const interval = getFrequencyIntervalMs(frequency);
    if (!interval) return null;
    return new Date(fromDate.getTime() + interval);
}

// ─── Due Control Selection ───────────────────────────────────────────

/**
 * Find controls that are due for automated checks.
 *
 * A control is due when:
 *   - automationKey is set
 *   - evidenceSource = 'INTEGRATION'
 *   - not deleted, is APPLICABLE
 *   - nextDueAt <= now (or nextDueAt is null and frequency is set)
 *   - no execution within current frequency window
 */
export async function findDueAutomationControls(
    now: Date,
    tenantId?: string
): Promise<DueControl[]> {
    const where: Prisma.ControlWhereInput = {
        automationKey: { not: null },
        evidenceSource: 'INTEGRATION',
        deletedAt: null,
        applicability: 'APPLICABLE',
        frequency: { not: null, notIn: ['AD_HOC'] },
        OR: [
            { nextDueAt: { lte: now } },
            { nextDueAt: null }, // never scheduled yet — execute immediately
        ],
    };

    if (tenantId) {
        where.tenantId = tenantId;
    } else {
        where.tenantId = { not: null }; // only tenant-scoped controls
    }

    const controls = await prisma.control.findMany({
        where,
        select: {
            id: true,
            tenantId: true,
            automationKey: true,
            frequency: true,
            nextDueAt: true,
            name: true,
        },
        orderBy: { nextDueAt: 'asc' },
        take: 500, // bounded batch size
    });

    // Filter: skip controls where a recent execution already exists within the window
    const dueControls: DueControl[] = [];

    for (const ctrl of controls) {
        if (!ctrl.tenantId || !ctrl.automationKey) continue;

        const interval = getFrequencyIntervalMs(ctrl.frequency);
        if (!interval) continue;

        // Check for existing execution within the current window
        const windowStart = new Date(now.getTime() - interval);
        const recentExecution = await prisma.integrationExecution.findFirst({
            where: {
                controlId: ctrl.id,
                tenantId: ctrl.tenantId,
                automationKey: ctrl.automationKey,
                status: { in: ['PASSED', 'FAILED', 'RUNNING'] },
                executedAt: { gte: windowStart },
            },
            select: { id: true },
        });

        if (!recentExecution) {
            dueControls.push({
                id: ctrl.id,
                tenantId: ctrl.tenantId,
                automationKey: ctrl.automationKey,
                frequency: ctrl.frequency,
                nextDueAt: ctrl.nextDueAt,
                name: ctrl.name,
            });
        }
    }

    return dueControls;
}

// ─── Single Control Execution ────────────────────────────────────────

/**
 * Decrypt connection secrets safely.
 */
function decryptSecrets(secretEncrypted: string | null): Record<string, unknown> {
    if (!secretEncrypted) return {};
    try {
        return JSON.parse(decryptField(secretEncrypted));
    } catch {
        return {};
    }
}

/**
 * Execute an automation check for a single control.
 * Creates IntegrationExecution, Evidence, and updates Control scheduling.
 */
export async function executeControlAutomation(
    control: DueControl,
    jobRunId: string,
    now: Date
): Promise<{ status: CheckResult['status']; executionId: string }> {
    const parsed = parseAutomationKey(control.automationKey);
    if (!parsed) {
        logger.warn('Invalid automationKey', {
            component: 'automation-runner',
            controlId: control.id,
            automationKey: control.automationKey,
        });
        return { status: 'ERROR', executionId: '' };
    }

    // Resolve provider
    const resolution = registry.resolveByAutomationKey(control.automationKey);
    if (!resolution) {
        logger.warn('No provider for automationKey', {
            component: 'automation-runner',
            automationKey: control.automationKey,
        });
        return { status: 'ERROR', executionId: '' };
    }

    const { provider } = resolution;
    if (!isScheduledCheckProvider(provider)) {
        logger.warn('Provider does not support scheduled checks', {
            component: 'automation-runner',
            provider: parsed.provider,
        });
        return { status: 'ERROR', executionId: '' };
    }

    // Find active connection
    const connection = await prisma.integrationConnection.findFirst({
        where: {
            tenantId: control.tenantId,
            provider: parsed.provider,
            isEnabled: true,
        },
    });

    if (!connection) {
        logger.warn('No active connection for provider', {
            component: 'automation-runner',
            tenantId: control.tenantId,
            provider: parsed.provider,
        });
        return { status: 'ERROR', executionId: '' };
    }

    // Create RUNNING execution
    const execution = await prisma.integrationExecution.create({
        data: {
            tenantId: control.tenantId,
            connectionId: connection.id,
            provider: parsed.provider,
            automationKey: control.automationKey,
            controlId: control.id,
            status: 'RUNNING',
            triggeredBy: 'scheduled',
            jobRunId,
        },
    });

    // Execute check
    const startTime = Date.now();
    let result: CheckResult;

    try {
        const secrets = decryptSecrets(connection.secretEncrypted);
        const checkInput: CheckInput = {
            automationKey: control.automationKey,
            parsed,
            tenantId: control.tenantId,
            controlId: control.id,
            connectionConfig: {
                ...(connection.configJson as Record<string, unknown>),
                ...secrets,
            },
            triggeredBy: 'scheduled',
            jobRunId,
        };

        result = await provider.runCheck(checkInput);
    } catch (err) {
        const durationMs = Date.now() - startTime;
        const errorMessage = err instanceof Error ? err.message : String(err);

        await prisma.integrationExecution.update({
            where: { id: execution.id },
            data: {
                status: 'ERROR',
                errorMessage,
                durationMs,
                completedAt: now,
            },
        });

        return { status: 'ERROR', executionId: execution.id };
    }

    const durationMs = result.durationMs ?? (Date.now() - startTime);

    // Create evidence from result
    let evidenceId: string | undefined;
    const evidencePayload = provider.mapResultToEvidence(
        {
            automationKey: control.automationKey,
            parsed,
            tenantId: control.tenantId,
            controlId: control.id,
            connectionConfig: {},
            triggeredBy: 'scheduled',
            jobRunId,
        },
        result
    );

    // H2 — never write APPROVED evidence off a broken run (ERROR) or an empty
    // population (NOT_APPLICABLE). Only PASSED/FAILED reflect a real
    // observation the evidence can attest to.
    const evidenceEligible = isRealObservation(result.status);
    if (evidencePayload && evidenceEligible) {
        const evidence = await prisma.evidence.create({
            data: {
                tenantId: control.tenantId,
                // Integration EvidencePayload.type uses a wider vocabulary
                // (DOCUMENT/SCREENSHOT/LOG/CONFIGURATION/REPORT) than the
                // narrow Prisma EvidenceType (FILE/LINK/TEXT). Integration-
                // created evidence is always a text summary of the check
                // result, so map it to TEXT explicitly — mirrors the
                // usecase writer in usecases/integrations.ts and removes the
                // former `as EvidenceType` cast (PR-1).
                type: EvidenceType.TEXT,
                title: evidencePayload.title,
                content: evidencePayload.content,
                category: evidencePayload.category ?? 'integration',
                status: 'APPROVED',
            },
        });
        await prisma.evidenceControlLink.create({
            data: {
                tenantId: control.tenantId,
                evidenceId: evidence.id,
                controlId: control.id,
                createdByUserId: null,
            },
        });
        evidenceId = evidence.id;
    }

    // Update execution
    await prisma.integrationExecution.update({
        where: { id: execution.id },
        data: {
            status: result.status,
            resultJson: result.details as Prisma.InputJsonValue,
            evidenceId,
            errorMessage: result.errorMessage,
            durationMs,
            completedAt: now,
        },
    });

    // H6 — domain metric so a broken collector / false PASSED / NOT_APPLICABLE
    // is alertable (the generic job.execution.count can't see it).
    const outcomeKey = parseAutomationKey(control.automationKey);
    recordCheckOutcome({ provider: outcomeKey?.provider ?? 'unknown', checkType: outcomeKey?.checkType ?? 'unknown', status: result.status, durationMs });

    // PR-1 — close the failing-check loop: materialize (or reconcile) a
    // Finding from the outcome. Fail-safe — the execution + evidence are
    // already committed, so a finding-side error is logged, not thrown.
    await reconcileFindingForCheck(control, result.status, result, now);

    // Advance control scheduling — ONLY on a real verdict.
    //
    // This ran unconditionally. An ERROR (broken collector, expired
    // credentials, provider outage) or a NOT_APPLICABLE (empty population)
    // therefore stamped `lastTested = now` and rolled `nextDueAt` forward, so a
    // control that nobody actually verified dropped off /tests?due=..., the
    // dashboard and the coverage surfaces until its next cycle. A check that
    // could not run reported the control as freshly tested.
    //
    // The rule was already established twice IN THIS FILE and simply not
    // applied here: `evidenceEligible` above refuses to mint APPROVED evidence
    // off a non-verdict, and `reconcileFindingForCheck` refuses to auto-close a
    // finding off one. `attestControlTested` — the manual and test-run path —
    // gates on `isAttestingVerdict` for exactly this reason, with a docblock
    // saying that claiming "tested and on schedule" would be a false assurance
    // an auditor could act on. The automated path was the one place the
    // assurance was granted for free.
    //
    // FAILED still attests: the control WAS exercised and the answer was "not
    // effective". That failure is carried by the Finding above; leaving the
    // control ALSO reading overdue would double-count one problem.
    const attests = isRealObservation(result.status);
    if (attests) {
        const nextDueAt = computeNextDueAt(control.frequency, now);
        await prisma.control.update({
            where: { id: control.id },
            data: {
                lastTested: now,
                ...(nextDueAt ? { nextDueAt } : {}),
            },
        });
    }

    return { status: result.status, executionId: execution.id };
}

// ─── FAILED → Finding (PR-1) ─────────────────────────────────────────

/** Provenance tag on Findings materialized from an automated check. */
export const INTEGRATION_CHECK_SOURCE_KIND = 'INTEGRATION_CHECK';

/**
 * Turn a scheduled-check outcome into a tracked Finding, closing the
 * failing-check loop.
 *
 * On FAILED — open a de-duplicated OPEN Finding for (control, automationKey),
 * tagged `sourceKind='INTEGRATION_CHECK'` /
 * `sourceRef='<controlId>:<automationKey>'`. Re-runs never pile up
 * duplicates; the `Finding[tenantId, sourceKind, sourceRef]` index backs the
 * lookup (mirrors the scanner-ingestion / NIS2 materializer contract).
 *
 * On PASSED — reconcile: auto-close any still-open finding for that source,
 * so a check that recovers clears its finding.
 *
 * On ERROR — the check could not run (creds/network); not a compliance
 * failure, so neither open nor close.
 *
 * Fully fail-safe — errors are logged and swallowed, never propagated to
 * the run.
 */
async function reconcileFindingForCheck(
    control: DueControl,
    status: CheckResult['status'],
    result: CheckResult,
    now: Date,
): Promise<void> {
    // H2 — a broken run (ERROR) or an empty population (NOT_APPLICABLE) is NOT
    // a pass: it must never auto-close an open finding. Only a genuine
    // FAILED/PASSED derived from a real parsed result reconciles findings.
    if (!isRealObservation(status)) return;

    const sourceRef = `${control.id}:${control.automationKey}`;
    try {
        if (status === 'FAILED') {
            const existing = await prisma.finding.findFirst({
                where: {
                    tenantId: control.tenantId,
                    sourceKind: INTEGRATION_CHECK_SOURCE_KIND,
                    sourceRef,
                    status: { not: 'CLOSED' },
                    deletedAt: null,
                },
                select: { id: true },
            });
            if (existing) return; // de-duplicate — one open finding per source

            await prisma.finding.create({
                data: {
                    tenantId: control.tenantId,
                    controlId: control.id,
                    severity: 'MEDIUM',
                    type: 'NONCONFORMITY',
                    title: `Automated check failed: ${control.name}`.slice(0, 250),
                    description: (result.summary || `Check ${control.automationKey} failed.`).slice(0, 2000),
                    status: 'OPEN',
                    sourceKind: INTEGRATION_CHECK_SOURCE_KIND,
                    sourceRef,
                },
            });
        } else {
            // PASSED — reconcile any still-open finding for this source.
            await prisma.finding.updateMany({
                where: {
                    tenantId: control.tenantId,
                    sourceKind: INTEGRATION_CHECK_SOURCE_KIND,
                    sourceRef,
                    status: { not: 'CLOSED' },
                },
                data: {
                    status: 'CLOSED',
                    verificationNotes: `Auto-closed: ${control.automationKey} passed on ${now.toISOString().slice(0, 10)}`,
                    verifiedAt: now,
                },
            });
        }
    } catch (err) {
        logger.error('Automated-check finding reconcile failed (non-fatal)', {
            component: 'automation-runner',
            controlId: control.id,
            automationKey: control.automationKey,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ─── Batch Runner ────────────────────────────────────────────────────

/**
 * Run all due scheduled automations.
 *
 * This is the main entry point called by cron.
 * Uses runJob() for structured observability.
 */
export async function runScheduledAutomations(
    options: AutomationRunnerOptions = {}
): Promise<AutomationRunnerResult> {
    return runJob('automation-runner', async () => {
        const now = options.now ?? new Date();
        const dryRun = options.dryRun ?? false;
        const jobRunId = crypto.randomUUID();

        // 1. Find due controls
        const dueControls = await findDueAutomationControls(now, options.tenantId);

        logger.info('Automation runner: due controls found', {
            component: 'automation-runner',
            totalDue: dueControls.length,
            dryRun,
            jobRunId,
        });

        if (dryRun) {
            return {
                totalDue: dueControls.length,
                executed: 0,
                passed: 0,
                failed: 0,
                errors: 0,
                notApplicable: 0,
                skipped: dueControls.length,
                dryRun: true,
                jobRunId,
            };
        }

        // 2. Execute each control
        let executed = 0;
        let passed = 0;
        let failed = 0;
        let errors = 0;
        let notApplicable = 0;
        let skipped = 0;

        for (const control of dueControls) {
            // Verify provider exists before executing
            if (!registry.canHandle(control.automationKey)) {
                skipped++;
                logger.info('Automation runner: skipping (no provider)', {
                    component: 'automation-runner',
                    controlId: control.id,
                    automationKey: control.automationKey,
                });
                continue;
            }

            try {
                const result = await executeControlAutomation(control, jobRunId, now);
                executed++;

                switch (result.status) {
                    case 'PASSED': passed++; break;
                    case 'FAILED': failed++; break;
                    case 'ERROR': errors++; break;
                    case 'NOT_APPLICABLE': notApplicable++; break;
                }
            } catch (err) {
                errors++;
                logger.error('Automation runner: execution failed', {
                    component: 'automation-runner',
                    controlId: control.id,
                    err: err instanceof Error ? err : new Error(String(err)),
                });
            }
        }

        logger.info('Automation runner: batch complete', {
            component: 'automation-runner',
            jobRunId,
            totalDue: dueControls.length,
            executed,
            passed,
            failed,
            errors,
            notApplicable,
            skipped,
        });

        return {
            totalDue: dueControls.length,
            executed,
            passed,
            failed,
            errors,
            notApplicable,
            skipped,
            dryRun: false,
            jobRunId,
        };
    }, { tenantId: options.tenantId });
}
