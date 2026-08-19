/**
 * Prisma predicates shared between the controls DASHBOARD counts and the
 * controls LIST filters.
 *
 * ## Why these live in one place
 *
 * Each dashboard card is now a drill-down: clicking it lands on `/controls`
 * filtered to the rows it counted. That only tells the truth if the card and
 * the list ask the database the same question — and the failure mode when they
 * do not is silent, because both numbers look plausible on their own.
 *
 * This codebase has the scar. #1924 moved "controls missing evidence" from the
 * readiness report to the dashboard and correctly unified the DEFINITION of
 * "has evidence" via `coverageQualifyingEvidenceWhere`, precisely so the two
 * surfaces could not disagree. What it did not do was remove the report's copy,
 * so a framework-scoped list and a tenant-wide count carried the same label for
 * months. Re-deriving these predicates at the list layer would recreate exactly
 * that, one layer down.
 *
 * So the dashboard's `count` and the repository's `findMany` both import from
 * here. A change to what "due soon" means is one edit, not two that must be
 * kept in step by memory.
 */
import type { Prisma } from '@prisma/client';
import { coverageQualifyingEvidenceWhere } from './coverage-evidence';

/** How far ahead "due soon" reaches. */
export const DUE_SOON_DAYS = 30;

/** The `nextDueAt` cutoff for "due soon", relative to `now`. */
export function dueSoonThreshold(now: Date = new Date()): Date {
    const threshold = new Date(now);
    threshold.setDate(threshold.getDate() + DUE_SOON_DAYS);
    return threshold;
}

/**
 * Applicable controls whose next review falls within the window.
 *
 * Scoped to APPLICABLE deliberately: a control excluded from scope has no
 * meaningful review date, and counting it would inflate a number an operator
 * reads as "work arriving".
 *
 * `nextDueAt: { not: null }` is redundant against `lte` in Prisma — NULL never
 * satisfies a comparison — but it is kept because it states the intent that a
 * control with no schedule is not "due", which is the thing a reader checks.
 */
export function controlsDueSoonWhere(now: Date = new Date()): Prisma.ControlWhereInput {
    return {
        applicability: 'APPLICABLE',
        nextDueAt: { not: null, lte: dueSoonThreshold(now) },
    };
}

/**
 * Controls carrying no qualifying evidence.
 *
 * Three parts, each load-bearing, and each one a way to get a wrong number:
 *
 *   - `status: { not: 'NOT_APPLICABLE' }` keys on STATUS, not the
 *     `applicability` field a sibling scorer uses. Picking the other one makes
 *     this disagree with the readiness report it was derived from.
 *   - `evidence: coverageQualifyingEvidenceWhere(now)` is the shared
 *     APPROVED + unexpired + not-archived + not-deleted rule. Never inline it.
 *   - `tenantId` INSIDE the nested link filter: the soft-delete extension
 *     injects tenant scope and `deletedAt` at the top level only, never inside
 *     a relation filter, so without it a link belonging to another tenant — or
 *     to soft-deleted evidence — would count as evidence.
 */
export function controlsMissingEvidenceWhere(
    tenantId: string,
    now: Date = new Date(),
): Prisma.ControlWhereInput {
    return {
        status: { not: 'NOT_APPLICABLE' },
        NOT: {
            evidenceControlLinks: {
                some: {
                    tenantId,
                    evidence: coverageQualifyingEvidenceWhere(now),
                },
            },
        },
    };
}
