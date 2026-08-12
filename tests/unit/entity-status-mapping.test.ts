/**
 * Entity Status Mapping — Functional Unit Tests
 *
 * Behavioural coverage for `src/app-layer/domain/entity-status-mapping.ts`.
 * The hardcoded `getRiskScoreBand` classifier was removed in PR-J — risk
 * band + tone now resolve through the tenant-configurable
 * `resolveBandForScore` / `resolveBandTone` (see
 * `tests/unit/risk-matrix-scoring.test.ts`). What remains here is the
 * severity-tone → StatusBadge-variant bridge and the family of
 * status→badge-variant lookup tables every detail page reads. These maps
 * ARE domain semantics — a wrong tone is a product defect.
 */

import {
    riskSeverityToBadgeVariant,
    RISK_STATUS_VARIANT,
    CONTROL_STATUS_VARIANT,
    CONTROL_APPLICABILITY_VARIANT,
    TASK_STATUS_VARIANT,
    TASK_SEVERITY_VARIANT,
    POLICY_STATUS_VARIANT,
    POLICY_APPROVAL_VARIANT,
    VENDOR_STATUS_VARIANT,
    VENDOR_CRITICALITY_VARIANT,
    VENDOR_ASSESSMENT_VARIANT,
} from '../../src/app-layer/domain/entity-status-mapping';

// ═════════════════════════════════════════════════════════════════════
// 1. riskSeverityToBadgeVariant — config-tone → badge-variant bridge
// ═════════════════════════════════════════════════════════════════════

describe('riskSeverityToBadgeVariant', () => {
    test('success tone → success variant', () => {
        expect(riskSeverityToBadgeVariant('success')).toBe('success');
    });
    test('attention tone → warning variant', () => {
        expect(riskSeverityToBadgeVariant('attention')).toBe('warning');
    });
    test('critical tone → error variant', () => {
        expect(riskSeverityToBadgeVariant('critical')).toBe('error');
    });
    test('default/neutral tone → neutral variant', () => {
        expect(riskSeverityToBadgeVariant('default')).toBe('neutral');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Status → StatusBadge variant maps
// ═════════════════════════════════════════════════════════════════════

describe('status-variant lookup tables', () => {
    test('risk status maps cover the full lifecycle', () => {
        expect(RISK_STATUS_VARIANT.OPEN).toBe('warning');
        expect(RISK_STATUS_VARIANT.MITIGATING).toBe('info');
        expect(RISK_STATUS_VARIANT.ACCEPTED).toBe('neutral');
        expect(RISK_STATUS_VARIANT.CLOSED).toBe('success');
    });

    test('control status: terminal IMPLEMENTED is success, NEEDS_REVIEW is warning', () => {
        expect(CONTROL_STATUS_VARIANT.NOT_STARTED).toBe('neutral');
        expect(CONTROL_STATUS_VARIANT.IN_PROGRESS).toBe('info');
        expect(CONTROL_STATUS_VARIANT.IMPLEMENTED).toBe('success');
        expect(CONTROL_STATUS_VARIANT.NEEDS_REVIEW).toBe('warning');
    });

    test('control applicability: only APPLICABLE draws attention', () => {
        expect(CONTROL_APPLICABILITY_VARIANT.APPLICABLE).toBe('info');
        expect(CONTROL_APPLICABILITY_VARIANT.NOT_APPLICABLE).toBe('neutral');
        expect(CONTROL_APPLICABILITY_VARIANT.EXCLUDED).toBe('neutral');
    });

    test('task status: BLOCKED is the only error tone', () => {
        expect(TASK_STATUS_VARIANT.BLOCKED).toBe('error');
        const others = Object.entries(TASK_STATUS_VARIANT)
            .filter(([k]) => k !== 'BLOCKED')
            .map(([, v]) => v);
        expect(others).not.toContain('error');
    });

    test('task severity escalates LOW → CRITICAL', () => {
        expect(TASK_SEVERITY_VARIANT.INFO).toBe('neutral');
        expect(TASK_SEVERITY_VARIANT.LOW).toBe('info');
        expect(TASK_SEVERITY_VARIANT.MEDIUM).toBe('warning');
        // B2-6 — HIGH is `error`, not `warning`. See the note on the map.
        expect(TASK_SEVERITY_VARIANT.HIGH).toBe('error');
        expect(TASK_SEVERITY_VARIANT.CRITICAL).toBe('error');
    });

    /**
     * B2-6 — the top of the scale is where this file used to contradict
     * itself: `TASK_SEVERITY_VARIANT.HIGH` was `warning` while
     * `VENDOR_CRITICALITY_VARIANT.HIGH`, fifty lines below it, was
     * `error`. The two maps rank the same words, and the badge a user
     * learns to read as "act on this now" has to mean the same thing on
     * both. Pinning the AGREEMENT rather than the literal means a
     * deliberate future re-tone has to move both maps together.
     *
     * LOW is excluded on purpose: vendor criticality has no INFO level,
     * so its LOW carries the quiet tone that tasks give INFO.
     */
    test('task severity agrees with vendor criticality from MEDIUM up', () => {
        for (const level of ['MEDIUM', 'HIGH', 'CRITICAL']) {
            expect([level, TASK_SEVERITY_VARIANT[level]]).toEqual([
                level,
                VENDOR_CRITICALITY_VARIANT[level],
            ]);
        }
    });

    test('policy status: PUBLISHED is success, ARCHIVED warns', () => {
        expect(POLICY_STATUS_VARIANT.DRAFT).toBe('neutral');
        expect(POLICY_STATUS_VARIANT.IN_REVIEW).toBe('info');
        expect(POLICY_STATUS_VARIANT.PUBLISHED).toBe('success');
        expect(POLICY_STATUS_VARIANT.ARCHIVED).toBe('warning');
    });

    test('policy approval: REJECTED is error, APPROVED is success', () => {
        expect(POLICY_APPROVAL_VARIANT.PENDING).toBe('info');
        expect(POLICY_APPROVAL_VARIANT.APPROVED).toBe('success');
        expect(POLICY_APPROVAL_VARIANT.REJECTED).toBe('error');
    });

    test('vendor status maps the onboarding lifecycle', () => {
        expect(VENDOR_STATUS_VARIANT.ACTIVE).toBe('success');
        expect(VENDOR_STATUS_VARIANT.ONBOARDING).toBe('info');
        expect(VENDOR_STATUS_VARIANT.OFFBOARDING).toBe('warning');
        expect(VENDOR_STATUS_VARIANT.OFFBOARDED).toBe('neutral');
    });

    test('vendor criticality: HIGH and CRITICAL both surface as error', () => {
        expect(VENDOR_CRITICALITY_VARIANT.LOW).toBe('neutral');
        expect(VENDOR_CRITICALITY_VARIANT.MEDIUM).toBe('warning');
        expect(VENDOR_CRITICALITY_VARIANT.HIGH).toBe('error');
        expect(VENDOR_CRITICALITY_VARIANT.CRITICAL).toBe('error');
    });

    test('vendor assessment lifecycle distinct from vendor status', () => {
        expect(VENDOR_ASSESSMENT_VARIANT.DRAFT).toBe('neutral');
        expect(VENDOR_ASSESSMENT_VARIANT.IN_REVIEW).toBe('warning');
        expect(VENDOR_ASSESSMENT_VARIANT.APPROVED).toBe('success');
        expect(VENDOR_ASSESSMENT_VARIANT.REJECTED).toBe('error');
    });

    test('an unknown status key resolves to undefined (caller must default)', () => {
        // The maps are plain Records — consumers fall back to a
        // neutral tone for unmapped keys. This documents that contract.
        expect(RISK_STATUS_VARIANT['NONSENSE']).toBeUndefined();
        expect(TASK_STATUS_VARIANT['NONSENSE']).toBeUndefined();
    });

    test('every mapped variant is a known StatusBadge tone', () => {
        const allowed = new Set(['success', 'info', 'neutral', 'warning', 'error']);
        const allMaps = [
            RISK_STATUS_VARIANT, CONTROL_STATUS_VARIANT, CONTROL_APPLICABILITY_VARIANT,
            TASK_STATUS_VARIANT, TASK_SEVERITY_VARIANT, POLICY_STATUS_VARIANT,
            POLICY_APPROVAL_VARIANT, VENDOR_STATUS_VARIANT, VENDOR_CRITICALITY_VARIANT,
            VENDOR_ASSESSMENT_VARIANT,
        ];
        for (const map of allMaps) {
            for (const variant of Object.values(map)) {
                expect(allowed.has(variant)).toBe(true);
            }
        }
    });
});
