/**
 * Every tenant-scoped deadline column is either ON the calendar or explicitly
 * excluded with a reason.
 *
 * The calendar's source list was a hand-maintained literal checked only in the
 * direction that cannot regress silently: it verified that each NAMED loader
 * exists. Add a date-bearing entity, forget to project it, and nothing failed —
 * which is exactly what happened twice. `AssetVulnerability.remediationDueAt`
 * is written by the vulnerability usecase AND edited by users through an inline
 * DatePicker; `Audit.schedule` is the day fieldwork starts. Neither appeared on
 * the one surface whose job is "what is due", and neither was in any
 * out-of-scope list.
 *
 * So this guard runs the OTHER way: it enumerates candidates from the Prisma
 * DMMF and requires each to be projected or excluded. A new model with a due
 * date fails on the day it lands, in the diff that adds it, rather than being
 * discovered by a user who set a deadline and could not find it.
 *
 * Excluding is fine — most `expiresAt` columns are credential lifetimes, not
 * compliance obligations. Excluding SILENTLY is not.
 */
import {
    readCalendarUsecase,
    calendarLoaderBlocks,
} from '../helpers/calendar-usecase-source';
import { Prisma } from '@prisma/client';



/**
 * Column names that denote a forward-looking deadline.
 *
 * Deliberately name-based: a `DateTime` column is a deadline because of what it
 * MEANS, and the schema encodes that only in the name. `createdAt`/`completedAt`
 * are receipts of things that happened; these are dates something must happen BY.
 */
const DEADLINE_SUFFIXES = [
    'dueAt',
    'dueDate',
    'expiresAt',
    'validTo',
    'nextReviewAt',
    'nextReviewDate',
    'nextDueAt',
    'nextRunAt',
    'schedule',
    'targetDate',
    'periodEndAt',
    'remediationDueAt',
    'retentionUntil',
];

const isDeadlineName = (n: string) =>
    DEADLINE_SUFFIXES.some((s) => n === s || n.endsWith(s[0].toUpperCase() + s.slice(1)));

/**
 * Columns deliberately NOT on the calendar. Every entry needs a real reason —
 * the ratchet checks the reason is substantive, because "not needed" is how a
 * projection gap gets laundered into a documented decision.
 */
const EXCLUSIONS: Record<string, string> = {
    // ── Credential + session lifetimes: not compliance obligations. Nobody
    //    "meets" an API key expiry; it is a security property of the secret,
    //    surfaced on the admin screens that manage the secret itself.
    'TenantApiKey.expiresAt':
        'API-key lifetime — a credential property managed on the admin API-keys screen, not a deadline anyone works toward.',
    'TenantDeviceToken.expiresAt':
        'Device-token lifetime — credential rotation, surfaced with the device, not a compliance deadline.',
    'UserSession.expiresAt':
        'Session lifetime — Epic C.3 session hardening; expiry is enforced automatically and has no owner to remind.',
    'TenantInvite.expiresAt':
        'Invite-token lifetime — a leaked-token bound, not work to be done; the admin members screen shows pending invites.',
    'AuditPackShare.expiresAt':
        'Share-link lifetime — a bounded exposure window on an unauthenticated URL; the pack detail lists its shares.',
    'TrustCenterAccessRequest.expiresAt':
        'Gated-document access grant lifetime — a permission window, not an obligation with an owner.',

    // ── Scheduling machinery rather than an obligation.
    'ReportSchedule.nextRunAt':
        'Cron bookkeeping — when the scheduler will next emit a report. Nobody is accountable for it arriving; the job is.',

    // ── Range bounds whose OTHER end is already projected.
    'AccessReview.periodEndAt':
        'The review campaign period bound; `AccessReview.dueAt` is the actual deadline and IS projected as access-review-due.',

    // ── Retention clocks: the data-lifecycle job acts on these without human
    //    intervention, and Evidence retention already has its own reminder flow.
    'Evidence.retentionUntil':
        'Retention clock driven end-to-end by the data-lifecycle job (reminders → archive → purge); see docs/data-retention.md. Not a manual deadline.',
    'FileRecord.retentionUntil':
        'Retention clock on the stored blob, mirroring its Evidence parent; purged by the same job.',

    // ── Retention clocks on business records. Same category as Evidence
    //    above: the data-lifecycle job purges soft-deleted rows on its own
    //    schedule. No owner acts on these, and putting six more "expiry"
    //    entries on the calendar would bury the deadlines someone must meet.
    'Asset.retentionUntil':
        'Soft-delete retention clock — purged automatically by the data-lifecycle job after 90 days; see docs/data-retention.md.',
    'Control.retentionUntil':
        'Soft-delete retention clock — purged automatically by the data-lifecycle job; not an obligation with an owner.',
    'Policy.retentionUntil':
        'Soft-delete retention clock — purged automatically by the data-lifecycle job; not an obligation with an owner.',
    'Risk.retentionUntil':
        'Soft-delete retention clock — purged automatically by the data-lifecycle job; not an obligation with an owner.',
    'Task.retentionUntil':
        'Soft-delete retention clock — purged automatically by the data-lifecycle job; not an obligation with an owner.',
    'Vendor.retentionUntil':
        'Soft-delete retention clock — purged automatically by the data-lifecycle job; not an obligation with an owner.',

    // ── Derived observations that already surface AS another projected
    //    deadline. Projecting both would double-report one obligation.
    'VendorMonitor.attestationExpiresAt':
        'Observed SOC 2 / cert audit-period end, extracted by the posture sweep. The sweep flips the vendor into reassessment-due, which IS projected as vendor-assessment-review — this column drives that deadline rather than being a second one.',
    'VendorAssessment.externalAccessTokenExpiresAt':
        'Lifetime of the external questionnaire link handed to a vendor contact — a credential window, not work the tenant owes; the assessment own review date is projected.',

    // ── Configuration review cadence with no per-tenant owner today.
    'RiskAppetiteConfig.nextReviewAt':
        'Appetite-config review cadence — a governance setting reviewed with the risk policy itself; no owner column exists to route it to.',
};



function modelOfAccessor(accessor: string): string | undefined {
    return Prisma.dmmf.datamodel.models.find(
        (m) => m.name.charAt(0).toLowerCase() + m.name.slice(1) === accessor,
    )?.name;
}

describe('calendar projection completeness', () => {
    const blocks = calendarLoaderBlocks(readCalendarUsecase());

    /** `Model.field` for every deadline column a loader reads. */
    const projected = new Set<string>();
    for (const block of blocks) {
        const accessor = block.body.match(/\bdb\.(\w+)\.findMany\(/)?.[1];
        if (!accessor) continue;
        const model = modelOfAccessor(accessor);
        if (!model) continue;
        const modelDef = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
        for (const f of modelDef?.fields ?? []) {
            if (f.type !== 'DateTime' || !isDeadlineName(f.name)) continue;
            // Read either in the where (the range filter) or the select.
            if (new RegExp(`\\b${f.name}\\b`).test(block.body)) {
                projected.add(`${model}.${f.name}`);
            }
        }
    }

    /** Every tenant-scoped deadline column in the datamodel. */
    const candidates: string[] = [];
    for (const m of Prisma.dmmf.datamodel.models) {
        if (!m.fields.some((f) => f.name === 'tenantId')) continue;
        for (const f of m.fields) {
            if (f.type === 'DateTime' && isDeadlineName(f.name)) {
                candidates.push(`${m.name}.${f.name}`);
            }
        }
    }

    it('finds loaders and candidates at all', () => {
        // Both halves must be non-empty or the sweep below passes vacuously.
        expect(blocks.length).toBeGreaterThanOrEqual(15);
        expect(candidates.length).toBeGreaterThanOrEqual(20);
        expect(projected.size).toBeGreaterThanOrEqual(10);
    });

    it('every deadline column is projected or excluded with a reason', () => {
        const unaccounted = candidates.filter(
            (c) => !projected.has(c) && !(c in EXCLUSIONS),
        );
        expect(unaccounted).toEqual([]);
    });

    it('the two that were silently missing are now projected', () => {
        // Named so a revert fails with the entity, not just a list diff.
        expect(projected.has('AssetVulnerability.remediationDueAt')).toBe(true);
        expect(projected.has('Audit.schedule')).toBe(true);
    });

    it('every exclusion carries a substantive reason', () => {
        for (const [column, reason] of Object.entries(EXCLUSIONS)) {
            expect(reason.length).toBeGreaterThan(40);
            // "not needed" / "n/a" are how a gap becomes a decision on paper.
            expect(reason).toMatch(/\s/);
            expect(column).toMatch(/^[A-Z]\w+\.\w+$/);
        }
    });

    it('has no stale exclusions', () => {
        // An exclusion for a column that no longer exists, or that is now
        // projected, is dead config that makes the map look more considered
        // than it is.
        const stale = Object.keys(EXCLUSIONS).filter(
            (c) => !candidates.includes(c) || projected.has(c),
        );
        expect(stale).toEqual([]);
    });
});
