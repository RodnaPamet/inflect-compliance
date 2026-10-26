/**
 * Typed domain-event contracts for the automation layer.
 *
 * Where `events.ts` is the *string* catalogue, this file is the
 * *shape* catalogue: one discriminated-union member per event with
 * its own `data` payload. Producers get compile-time guarantees:
 * emitting `RISK_CREATED` with the wrong `data` shape is a type
 * error, not a silently non-firing rule later.
 *
 * Shared metadata (tenantId, actor, entity, timestamp) lives on the
 * base shape so every event carries what the bus, dispatcher, and
 * execution history all need without each producer re-stamping it.
 */

import type { AutomationEventName } from './events';

/**
 * Metadata every automation event carries, regardless of type.
 * - `tenantId` is stamped by the bus from RequestContext; producers
 *   never set it manually, so cross-tenant leakage is impossible at
 *   the contract layer.
 * - `emittedAt` is stamped by the bus at emit time. Stable across
 *   downstream handlers and execution rows.
 * - `stableKey` is optional; when present, the dispatcher derives the
 *   execution idempotencyKey from (ruleId, event, stableKey) so a
 *   retried producer never double-fires.
 * - `actorApiKeyId` is stamped by the bus from RequestContext, and only
 *   when the emitting request was made with an API key (#4386). A rule
 *   with no author runs as `actorUserId`, and this is what bounds it to
 *   the key that request was limited to. Absent on every event a session,
 *   a job without a key, or a build before this field emitted.
 */
export interface AutomationEventMetadata {
    tenantId: string;
    entityType: string;
    entityId: string;
    actorUserId: string | null;
    actorApiKeyId?: string;
    emittedAt: Date;
    stableKey?: string;
}

// ─── Per-event payload shapes ──────────────────────────────────────────

export interface RiskCreatedData {
    title: string;
    score: number;
    category: string | null;
}
export interface RiskUpdatedData {
    changedFields: string[];
}
export interface RiskStatusChangedData {
    fromStatus: string;
    toStatus: string;
}
export interface RiskControlsMappedData {
    controlId: string;
    action: 'LINKED' | 'UNLINKED';
}

export interface TestPlanCreatedData {
    name: string;
    controlId: string;
}
export interface TestPlanUpdatedData {
    changedFields: string[];
}
export interface TestPlanStatusChangedData {
    fromStatus: string;
    toStatus: string;
}
export interface TestRunCreatedData {
    testPlanId: string;
}
export interface TestRunCompletedData {
    testPlanId: string;
    result: string;
}
export interface TestRunFailedData {
    findingSummary: string | null;
}
export interface TestEvidenceLinkedData {
    testRunId: string;
    kind: string;
}
export interface TestEvidenceUnlinkedData {
    testRunId: string;
}

export interface EvidenceExpiringData {
    title: string;
    controlId: string | null;
    retentionUntil: string | null;
}
export interface EvidenceExpiredData {
    title: string;
    controlId: string | null;
    expiredAt: string | null;
}

export interface ScheduleFiredData {
    /** The allowlisted target entity type that came due. */
    target: string;
    /** The entity's due-date field value (ISO). */
    dueAt: string | null;
    /** Days-before-due the rule was configured to fire. */
    offsetDays: number;
}

export interface ControlStatusChangedData {
    fromStatus: string;
    toStatus: string;
}
export interface PolicyReviewDueData {
    title: string;
    nextReviewAt: string | null;
    daysOverdue: number;
}
export interface VendorAssessmentOverdueData {
    vendorName: string;
    /** REVIEW_OVERDUE | RENEWAL_OVERDUE — which deadline lapsed. */
    kind: string;
    daysOverdue: number;
}

export interface OnboardingStartedData {
    /** Empty by design — event name carries the meaning. */
    readonly _?: never;
}
export interface OnboardingStepCompletedData {
    step: string;
}
export interface OnboardingFinishedData {
    readonly _?: never;
}
export interface OnboardingRestartedData {
    readonly _?: never;
}

export interface TaskCreatedData {
    /** Ticket key (e.g. "TSK-42"); null for legacy tasks that predate keying. */
    key: string | null;
    title: string;
    type: string;
    severity: string;
    priority: string;
    assigneeUserId: string | null;
    controlId: string | null;
}
export interface TaskStatusChangedData {
    fromStatus: string;
    toStatus: string;
    resolution: string | null;
}

export interface IssueCreatedData {
    /** Ticket key; null for legacy issues that predate keying. */
    key: string | null;
    title: string;
    severity: string;
    status: string;
    assigneeUserId: string | null;
}
export interface IssueStatusChangedData {
    fromStatus: string;
    toStatus: string;
}

// ─── Discriminated union ───────────────────────────────────────────────
//
// The whole point: `event` is the tag; `data` narrows off it. Any
// handler that checks `evt.event === 'RISK_CREATED'` gets
// `RiskCreatedData` on `evt.data` automatically.

export type AutomationDomainEvent =
    | (AutomationEventMetadata & { event: 'RISK_CREATED'; data: RiskCreatedData })
    | (AutomationEventMetadata & { event: 'RISK_UPDATED'; data: RiskUpdatedData })
    | (AutomationEventMetadata & { event: 'RISK_STATUS_CHANGED'; data: RiskStatusChangedData })
    | (AutomationEventMetadata & { event: 'RISK_CONTROLS_MAPPED'; data: RiskControlsMappedData })
    | (AutomationEventMetadata & { event: 'TEST_PLAN_CREATED'; data: TestPlanCreatedData })
    | (AutomationEventMetadata & { event: 'TEST_PLAN_UPDATED'; data: TestPlanUpdatedData })
    | (AutomationEventMetadata & { event: 'TEST_PLAN_PAUSED'; data: TestPlanStatusChangedData })
    | (AutomationEventMetadata & { event: 'TEST_PLAN_RESUMED'; data: TestPlanStatusChangedData })
    | (AutomationEventMetadata & { event: 'TEST_RUN_CREATED'; data: TestRunCreatedData })
    | (AutomationEventMetadata & { event: 'TEST_RUN_COMPLETED'; data: TestRunCompletedData })
    | (AutomationEventMetadata & { event: 'TEST_RUN_FAILED'; data: TestRunFailedData })
    | (AutomationEventMetadata & { event: 'TEST_EVIDENCE_LINKED'; data: TestEvidenceLinkedData })
    | (AutomationEventMetadata & { event: 'TEST_EVIDENCE_UNLINKED'; data: TestEvidenceUnlinkedData })
    | (AutomationEventMetadata & { event: 'EVIDENCE_EXPIRING'; data: EvidenceExpiringData })
    | (AutomationEventMetadata & { event: 'EVIDENCE_EXPIRED'; data: EvidenceExpiredData })
    | (AutomationEventMetadata & { event: 'SCHEDULE'; data: ScheduleFiredData })
    | (AutomationEventMetadata & { event: 'CONTROL_STATUS_CHANGED'; data: ControlStatusChangedData })
    | (AutomationEventMetadata & { event: 'POLICY_REVIEW_DUE'; data: PolicyReviewDueData })
    | (AutomationEventMetadata & { event: 'VENDOR_ASSESSMENT_OVERDUE'; data: VendorAssessmentOverdueData })
    | (AutomationEventMetadata & { event: 'ONBOARDING_STARTED'; data: OnboardingStartedData })
    | (AutomationEventMetadata & { event: 'ONBOARDING_STEP_COMPLETED'; data: OnboardingStepCompletedData })
    | (AutomationEventMetadata & { event: 'ONBOARDING_FINISHED'; data: OnboardingFinishedData })
    | (AutomationEventMetadata & { event: 'ONBOARDING_RESTARTED'; data: OnboardingRestartedData })
    | (AutomationEventMetadata & { event: 'TASK_CREATED'; data: TaskCreatedData })
    | (AutomationEventMetadata & { event: 'TASK_STATUS_CHANGED'; data: TaskStatusChangedData })
    | (AutomationEventMetadata & { event: 'ISSUE_CREATED'; data: IssueCreatedData })
    | (AutomationEventMetadata & { event: 'ISSUE_STATUS_CHANGED'; data: IssueStatusChangedData });

// Compile-time assertion: union membership equals the string catalogue.
// If a new catalogue entry is added without a contract, this line
// becomes a TypeScript error.
type _CatalogueConsistency = Exclude<
    AutomationEventName,
    AutomationDomainEvent['event']
>;

const _catalogueCheck: _CatalogueConsistency extends never ? true : false = true;

// ─── Producer-facing emit shape ────────────────────────────────────────
//
// What a usecase actually hands to the bus — metadata minus the
// fields the bus itself stamps (tenantId, emittedAt, actorApiKeyId).
// Keeps usecases from accidentally forging another tenant's id, or
// naming — or leaving out — the key a request was made with.

export type EmitAutomationEvent = {
    [E in AutomationDomainEvent as E['event']]: Omit<
        E,
        'tenantId' | 'emittedAt' | 'actorApiKeyId'
    >;
}[AutomationDomainEvent['event']];

/**
 * Narrow a raw persisted/unknown event to a specific variant.
 * Useful for dispatcher code that loaded an AutomationExecution row
 * and needs to narrow by `triggerEvent`.
 */
export function isEvent<E extends AutomationDomainEvent['event']>(
    evt: AutomationDomainEvent,
    name: E
): evt is Extract<AutomationDomainEvent, { event: E }> {
    return evt.event === name;
}
