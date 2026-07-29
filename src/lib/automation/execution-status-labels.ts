/**
 * ONE vocabulary for `AutomationExecutionStatus`, shared by every surface that
 * shows one.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 *
 * `ExecutionsPanel` mapped the enum through a local `statusLabels` record
 * ("Succeeded"), while `MonitorTab` rendered `{e.status}` raw ("SUCCEEDED") —
 * and the two are ONE CLICK apart: the monitor's recent-activity feed sits
 * beside the rule sheet whose executions panel lists the very same rows. The
 * same execution could be read as "Succeeded" in one place and "SUCCEEDED" in
 * the other, which reads as two different systems rather than one.
 *
 * `triggeredBy` had the same problem with no mapping anywhere — `'event'`,
 * `'manual'` and `'schedule'` were rendered verbatim.
 *
 * Keeping the labels here rather than in each component is the actual fix: a
 * local record per surface is what let them drift.
 *
 * Both helpers resolve against the `automation.executions` namespace, so callers
 * pass a resolver bound to it.
 */

/** Resolver bound to the `automation.executions` next-intl namespace. */
type Resolver = (key: string) => string;

/** Every `AutomationExecutionStatus` member (see enums.prisma). */
export const EXECUTION_STATUSES = [
    'PENDING',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'SKIPPED',
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export function buildExecutionStatusLabels(t: Resolver): Record<string, string> {
    return {
        PENDING: t('statusPending'),
        RUNNING: t('statusRunning'),
        SUCCEEDED: t('statusSucceeded'),
        FAILED: t('statusFailed'),
        SKIPPED: t('statusSkipped'),
    };
}

/** `AutomationExecution.triggeredBy` is a free-form string; these are the values the code writes. */
export const TRIGGER_SOURCES = ['event', 'manual', 'schedule', 'chain', 'subflow'] as const;

export function buildTriggerSourceLabels(t: Resolver): Record<string, string> {
    return {
        event: t('triggeredByEvent'),
        manual: t('triggeredByManual'),
        schedule: t('triggeredBySchedule'),
        chain: t('triggeredByChain'),
        subflow: t('triggeredBySubflow'),
    };
}
