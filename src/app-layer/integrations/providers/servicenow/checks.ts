/**
 * ServiceNow change-management control (S2).
 *
 * `change_approved_before_implementation` — of the changes that ACTUALLY
 * LANDED in the period, every one carries an approval record.
 *
 * A PURE FUNCTION over already-read rows, with no client and no network, for
 * the same reason the personnel and device engines are: the interesting cases
 * are population shapes (empty, all-excluded, one unapproved) and they should
 * be writable as three lines of fixture rather than a fetch mock.
 *
 * ═══ WHAT THE POPULATION IS, AND WHY IT IS NOT "ALL CHANGES" ═══
 *
 * The control is about production changes. A change that is still open has not
 * changed production yet, and a cancelled one never will — including either
 * would fail the control for changes that are proceeding normally, and a check
 * that is red for correct behaviour is a check people learn to ignore.
 *
 * So the applicable population is changes whose state maps to CLOSED_COMPLETE.
 *
 * STANDARD CHANGES ARE PRE-APPROVED under ITIL — the approval lives on the
 * template, not the request, so `approval` is legitimately `not_requested` on
 * every one of them. Counting those as violations produces a permanently
 * failing check. But excluding them SILENTLY is the opposite failure: a tenant
 * that reclassifies everything as standard would turn the control green and
 * nothing would say so. They are excluded from the population AND reported as
 * a count, so the number is on the result where someone can see it move.
 *
 * EMERGENCY CHANGES STAY IN. Retrospective approval is normal for them; NO
 * approval is exactly the finding this control exists to make.
 *
 * ═══ FAIL-CLOSED ═══
 *
 * An unrecognised `type` is treated as REQUIRING approval, not as standard.
 * `state` is instance-specific too, and an unrecognised state maps to OPEN,
 * which drops the row from the population rather than counting it as complete.
 * Both defaults cost a false negative on a weird row; the opposite defaults
 * would manufacture a pass.
 *
 * @module integrations/providers/servicenow/checks
 */
import type { CheckResult } from '../../types';
import { mapApproval, mapChangeState, type ChangeApproval } from './mapper';

export const SERVICENOW_CHECKS = ['change_approved_before_implementation'] as const;

/** One change, already unwrapped out of the Table API's value shapes. */
export interface ChangeRecord {
    number: string;
    approval: string;
    state: string;
    type: string;
}

/**
 * Change types whose approval is carried by the template rather than the
 * request. Anything not in this set requires its own approval record.
 */
const PRE_APPROVED_TYPES = new Set(['standard']);

function isPreApproved(type: string): boolean {
    return PRE_APPROVED_TYPES.has(type.trim().toLowerCase());
}

export interface ChangeApprovalOutcome {
    number: string;
    approval: ChangeApproval;
}

export function runServiceNowCheck(
    checkType: string,
    changes: ChangeRecord[],
): CheckResult {
    if (checkType !== 'change_approved_before_implementation') {
        // An unknown check is a routing bug, not a passing control.
        return {
            status: 'ERROR',
            summary: `Unknown ServiceNow check: ${checkType}`,
            details: {},
            errorMessage: `Unknown ServiceNow check: ${checkType}`,
        };
    }

    const implemented = changes.filter((c) => mapChangeState(c.state) === 'CLOSED_COMPLETE');
    const preApproved = implemented.filter((c) => isPreApproved(c.type));
    const applicable = implemented.filter((c) => !isPreApproved(c.type));

    if (applicable.length === 0) {
        // NOT_APPLICABLE, never PASSED. Zero applicable changes means the
        // control was not exercised — an empty window and a clean window are
        // different claims, and only one of them is evidence.
        return {
            status: 'NOT_APPLICABLE',
            summary:
                implemented.length === 0
                    ? 'No changes were implemented in the period.'
                    : `All ${implemented.length} implemented changes in the period were pre-approved standard changes.`,
            details: {
                totalRead: changes.length,
                implemented: implemented.length,
                preApprovedStandard: preApproved.length,
                applicable: 0,
            },
        };
    }

    const outcomes: ChangeApprovalOutcome[] = applicable.map((c) => ({
        number: c.number,
        approval: mapApproval(c.approval),
    }));
    // The RELATIONSHIP per change, not a count comparison. `approved >= total`
    // would pass a window where one change was approved twice and another not
    // at all.
    const unapproved = outcomes.filter((o) => o.approval !== 'APPROVED');

    if (unapproved.length > 0) {
        return {
            status: 'FAILED',
            summary: `${unapproved.length} of ${applicable.length} implemented changes went to production without an approval record.`,
            details: {
                totalRead: changes.length,
                implemented: implemented.length,
                preApprovedStandard: preApproved.length,
                applicable: applicable.length,
                failed: unapproved.length,
                // Bounded: a window with thousands of unapproved changes should
                // not put thousands of rows into a details blob that is read in
                // a UI. The count above is the number that matters.
                examples: unapproved.slice(0, 20),
            },
        };
    }

    return {
        status: 'PASSED',
        summary: `All ${applicable.length} implemented changes in the period carry an approval record.`,
        details: {
            totalRead: changes.length,
            implemented: implemented.length,
            preApprovedStandard: preApproved.length,
            applicable: applicable.length,
            failed: 0,
        },
    };
}
