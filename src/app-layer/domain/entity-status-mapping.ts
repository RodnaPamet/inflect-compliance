/**
 * Elevation PR-1 — shared status → StatusBadge variant mappings.
 *
 * Until this PR each detail page redeclared its own STATUS_VARIANT
 * literal:
 *   risks/[riskId]/page.tsx::STATUS_VARIANT
 *   controls/[controlId]/page.tsx (inline ternaries)
 *   tasks/[taskId]/page.tsx (inline)
 *   policies/[policyId]/page.tsx::STATUS_BADGE
 *   etc.
 * Result: the same domain enum mapped to subtly different badge tones
 * across pages. Consolidating into one file ensures every consumer
 * (MetaStrip, list-row badge, dashboard distribution) reads the same
 * vocabulary.
 *
 * The mappings live in the app-layer (not src/lib) because they're
 * domain semantics — what a "Risk OPEN" or "Policy DRAFT" means
 * visually is a product-design decision, not a UI primitive.
 */

import type { StatusBadgeVariant } from '@/components/ui/status-badge';
import { TASK_STATUS_BADGE } from '@/lib/task-status-badge';
import type { RiskSeverityTone } from '@/lib/risk-matrix/scoring';

// ─── Risk status ─────────────────────────────────────────────────────

export const RISK_STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    OPEN: 'warning',
    MITIGATING: 'info',
    // Audit Coherence S1 — controls in place, residual score
    // computed, awaiting explicit acceptance call. Distinct from
    // MITIGATING (work in progress) and ACCEPTED (signed off).
    MITIGATED: 'success',
    ACCEPTED: 'neutral',
    CLOSED: 'success',
};

// ─── Risk score band ─────────────────────────────────────────────────

// The hardcoded ≤5/≤12/≤18 risk-score band ladder was removed (PR-J):
// it disagreed with the tenant's configured `RiskMatrixConfig` bands, so
// the detail header chip could label a score differently from the
// list/assessment/explainer. Every surface now resolves the band via
// `resolveBandForScore` and the tone via `resolveBandTone` from
// `@/lib/risk-matrix/scoring`. This helper only maps the config-derived
// severity tone to a StatusBadge variant so the header chip / KPIStat
// speak the shared badge vocabulary.
export function riskSeverityToBadgeVariant(tone: RiskSeverityTone): StatusBadgeVariant {
    switch (tone) {
        case 'success': return 'success';
        case 'attention': return 'warning';
        case 'critical': return 'error';
        default: return 'neutral';
    }
}

// ─── Control status ──────────────────────────────────────────────────

/**
 * ControlStatus → badge variant. Covers ALL SEVEN enum members
 * (`prisma/schema/enums.prisma`), deliberately.
 *
 * It used to define four. The three it omitted — PLANNED, IMPLEMENTING,
 * NOT_APPLICABLE — did not fail loudly; they fell through each caller's
 * `?? 'neutral'`, so the gap was invisible and every page that wanted them
 * wrote its own map instead. Six independent copies grew that way, and they
 * disagreed: PLANNED rendered `neutral` on the SoA and controls list but
 * `info` in the policy traceability panel, for the same control.
 *
 * A missing key here is not a neutral default — it is an invitation to fork.
 * When a status is added to the enum, add it here in the same change.
 */
export const CONTROL_STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    NOT_STARTED: 'neutral',
    // PLANNED is `neutral`, matching the SoA, the controls list and the
    // control health card. It is an intention, not work in flight — colouring
    // it `info` (as the traceability panel did) made a control nobody had
    // started look the same as one being actively implemented.
    PLANNED: 'neutral',
    IN_PROGRESS: 'info',
    IMPLEMENTING: 'info',
    IMPLEMENTED: 'success',
    NEEDS_REVIEW: 'warning',
    NOT_APPLICABLE: 'neutral',
};

export const CONTROL_APPLICABILITY_VARIANT: Record<string, StatusBadgeVariant> = {
    APPLICABLE: 'info',
    NOT_APPLICABLE: 'neutral',
    EXCLUDED: 'neutral',
};

// ─── Task status ──────────────────────────────────────────

// Derived from the single source of truth in `@/lib/task-status-badge`
// (Tasks roadmap TP-1) — kept as a thin compat alias so existing
// callers (and the shape unit test) that want just the tone keep
// working. Do NOT re-inline this literal; edit `TASK_STATUS_BADGE`.
export const TASK_STATUS_VARIANT: Record<string, StatusBadgeVariant> =
    Object.fromEntries(
        Object.entries(TASK_STATUS_BADGE).map(([status, spec]) => [status, spec.variant]),
    );

/**
 * B2-6 — the ONE severity → tone map for tasks. The list
 * (`TasksClient`) and the linked-tasks panel each kept a byte-identical
 * inline copy that disagreed with this one on two levels, so the same
 * task showed HIGH red in the list and amber on its own detail page,
 * and LOW grey in the list and blue on detail. Both copies now import
 * this map — do NOT re-inline it.
 *
 * `HIGH: 'error'` (not `'warning'`) is the repo-wide convention: it is
 * what `FindingsClient`, `VulnerabilitiesClient`, `SecurityTestingClient`
 * and `VENDOR_CRITICALITY_VARIANT` (six lines below, in this file) all
 * use. Findings matter most — `TaskType.AUDIT_FINDING` tasks
 * materialise FROM findings (`Task.findingId`), so a finding and its
 * remediation task must not disagree about what HIGH looks like. The
 * old value collapsed MEDIUM and HIGH into one tone, which is the
 * boundary users actually triage on; collapsing HIGH/CRITICAL instead
 * groups the two that share a response ("escalate now").
 */
export const TASK_SEVERITY_VARIANT: Record<string, StatusBadgeVariant> = {
    INFO: 'neutral',
    LOW: 'info',
    MEDIUM: 'warning',
    HIGH: 'error',
    CRITICAL: 'error',
};

// ─── Policy status / approval ────────────────────────────────────────

export const POLICY_STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    DRAFT: 'neutral',
    IN_REVIEW: 'info',
    PUBLISHED: 'success',
    ARCHIVED: 'warning',
};

export const POLICY_APPROVAL_VARIANT: Record<string, StatusBadgeVariant> = {
    PENDING: 'info',
    APPROVED: 'success',
    REJECTED: 'error',
};

// ─── Vendor status / criticality ─────────────────────────────────────

export const VENDOR_STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    ACTIVE: 'success',
    ONBOARDING: 'info',
    OFFBOARDING: 'warning',
    OFFBOARDED: 'neutral',
};

export const VENDOR_CRITICALITY_VARIANT: Record<string, StatusBadgeVariant> = {
    LOW: 'neutral',
    MEDIUM: 'warning',
    HIGH: 'error',
    CRITICAL: 'error',
};

// Vendor assessment lifecycle (separate from vendor status).
// Covers BOTH the legacy World-A approval flow (DRAFT/IN_REVIEW/APPROVED/
// REJECTED) and the live G-3 send-and-collect lifecycle
// (SENT → IN_PROGRESS → SUBMITTED → REVIEWED → CLOSED). Every enum value
// has a tone so no status renders the default-neutral fallback.
export const VENDOR_ASSESSMENT_VARIANT: Record<string, StatusBadgeVariant> = {
    // Legacy World-A.
    DRAFT: 'neutral',
    IN_REVIEW: 'warning',
    APPROVED: 'success',
    REJECTED: 'error',
    // G-3 / World-B.
    SENT: 'info',
    IN_PROGRESS: 'info',
    SUBMITTED: 'warning',
    REVIEWED: 'success',
    CLOSED: 'neutral',
};

// i18n message key (under the `vendors.statusLabel` block) for a
// vendor-assessment status enum value. Client surfaces render
// `t(vendorAssessmentStatusLabelKey(status))` instead of the raw enum.
export function vendorAssessmentStatusLabelKey(status: string): string {
    return `statusLabel.${status}`;
}

// The live G-3 "send-and-collect" lifecycle statuses. An assessment in any
// of these opens the internal review surface (which adapts by status:
// read-only progress before SUBMITTED, review at SUBMITTED, close at
// REVIEWED, history when CLOSED). Anything else is a retired legacy
// World-A row (DRAFT/IN_REVIEW/APPROVED/REJECTED) with no responder — the
// vendor-table routes those to a non-actionable marker. This is the single
// source of truth for the vendor-table "Open →" routing-by-status logic.
const G3_ASSESSMENT_STATUSES: ReadonlySet<string> = new Set([
    'SENT',
    'IN_PROGRESS',
    'SUBMITTED',
    'REVIEWED',
    'CLOSED',
]);

export function isG3AssessmentStatus(status: string): boolean {
    return G3_ASSESSMENT_STATUSES.has(status);
}
