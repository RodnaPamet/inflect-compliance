/**
 * The DSAR register request an erasure fulfils (#5940, owner decisions
 * 2026-11-25).
 *
 * The operator command takes a REQUEST, never a person: the subject is read
 * from the register row, and the row decides whether the erasure may run. This
 * module holds that decision and the register's SECOND writer.
 *
 * ── WHEN A REQUEST MAY BE FULFILLED ────────────────────────────────────
 *
 * `erasureRequestRefusal` is pure and names one reason per refusal, in this
 * order:
 *
 *   REQUEST_NOT_FOUND       no such row.
 *   NOT_AN_ERASURE          an EXPORT request.
 *   ALREADY_COMPLETED       COMPLETED.
 *   REQUEST_REJECTED        REJECTED.
 *   REQUEST_CANCELED        CANCELED: the subject withdrew it.
 *   NOT_VERIFIED            RECEIVED, or no `verifiedAt`.
 *   COOLING_OFF             fewer than `DSAR_COOLING_OFF_HOURS` since
 *                           `verifiedAt`: the window the person has to cancel.
 *   NOT_IN_PROGRESS         VERIFIED. An admin starts it (VERIFIED →
 *                           IN_PROGRESS) on the register while the person is
 *                           still a member, and stays its accountable
 *                           `handledById`; the erasure then completes it.
 *   SUBJECT_ALREADY_ERASED  `userId` is NULL: another request erased them.
 *
 * Then `evaluateDsarRejection` (`rejectionForSubject`): `LAST_OWNER` from the
 * subject's live memberships. Outstanding balance and legal hold are passed as
 * absent, because the product holds neither for a person; they remain the
 * operator's check, and `OPERATOR_CHECKS` is printed on every plan.
 *
 * ── DUE ────────────────────────────────────────────────────────────────
 *
 * `readDueErasureRequests` is what the production action acts on, since it
 * takes no parameter: an ERASURE request, verified, past its cooling-off, not
 * COMPLETED / REJECTED / CANCELED, whose subject still exists. The action
 * refuses unless exactly one is due. A VERIFIED request is due and then
 * refused `NOT_IN_PROGRESS` by name, so it is never silently skipped.
 *
 * ── THE SECOND WRITER ──────────────────────────────────────────────────
 *
 * `dsar-register.ts` records and advances requests for an admin, inside a
 * tenant. It cannot reach this row any more: the erasure requires every
 * membership removed first, and the register reads a request only through the
 * subject's ACTIVE membership. So `fulfilErasureRequestWithin` writes it from
 * the erasure's own transaction, as the system: IN_PROGRESS → COMPLETED with
 * `completedAt`, `handledById` left as the admin who started it, and no tenant
 * `DSAR_COMPLETED` row (the erasure's `ERASURE_EXECUTED` rows are the record).
 * `tests/guards/dsar-register-writers.test.ts` holds the table to these two.
 *
 * @module app-layer/jobs/dsar-erasure-request
 */
import { DSAR_COOLING_OFF_HOURS, evaluateDsarRejection } from '@/lib/dsar';
import type { DsarRejectionReason } from '@/lib/dsar';
import { ConflictError } from '@/lib/errors/types';

/** The register columns the decision reads. Nothing that could name the person. */
export interface ErasureRequestRow {
    id: string;
    userId: string | null;
    type: string;
    status: string;
    verifiedAt: Date | null;
    completedAt: Date | null;
}

export type ErasureRequestRefusalReason =
    | 'REQUEST_NOT_FOUND'
    | 'NOT_AN_ERASURE'
    | 'ALREADY_COMPLETED'
    | 'REQUEST_REJECTED'
    | 'REQUEST_CANCELED'
    | 'NOT_VERIFIED'
    | 'COOLING_OFF'
    | 'NOT_IN_PROGRESS'
    | 'SUBJECT_ALREADY_ERASED'
    /** `evaluateDsarRejection` refused it; `rejection` names the criterion. */
    | 'REJECTION_CRITERION';

export interface ErasureRequestRefusal {
    reason: ErasureRequestRefusalReason;
    /** Set with `REJECTION_CRITERION`. */
    rejection?: DsarRejectionReason;
}

/** What `evaluateDsarRejection` cannot be told from the product, every time. */
export const OPERATOR_CHECKS: readonly string[] = Object.freeze([
    'outstanding balance: the product holds no balance for a person; the operator checks it',
    'legal hold: the product holds no hold for a person; the operator checks it',
]);

const HOUR_MS = 3_600_000;

/** Whether the cooling-off since `verifiedAt` has elapsed at `now`. */
function cooledOff(verifiedAt: Date, now: Date): boolean {
    return now.getTime() - verifiedAt.getTime() >= DSAR_COOLING_OFF_HOURS * HOUR_MS;
}

/** The register's own refusals, in order. Pure; `null` when the row may be fulfilled. */
export function erasureRequestRefusal(request: ErasureRequestRow | null, now: Date): ErasureRequestRefusal | null {
    if (!request) return { reason: 'REQUEST_NOT_FOUND' };
    if (request.type !== 'ERASURE') return { reason: 'NOT_AN_ERASURE' };
    if (request.status === 'COMPLETED' || request.completedAt !== null) return { reason: 'ALREADY_COMPLETED' };
    if (request.status === 'REJECTED') return { reason: 'REQUEST_REJECTED' };
    if (request.status === 'CANCELED') return { reason: 'REQUEST_CANCELED' };
    if (request.status === 'RECEIVED' || request.verifiedAt === null) return { reason: 'NOT_VERIFIED' };
    if (!cooledOff(request.verifiedAt, now)) return { reason: 'COOLING_OFF' };
    if (request.status !== 'IN_PROGRESS') return { reason: 'NOT_IN_PROGRESS' };
    if (request.userId === null) return { reason: 'SUBJECT_ALREADY_ERASED' };
    return null;
}

/** The slice of a client this module reads and writes through. */
export interface ErasureRequestDb {
    $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}

/** The writes, through the Prisma delegate so the erasure probe observes them. */
export interface ErasureRequestWriteDb {
    dataSubjectRequest: {
        updateMany(args: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
        }): Promise<{ count: number }>;
    };
}

const REQUEST_SQL = `SELECT "id", "userId", "type"::text AS "type", "status"::text AS "status", "verifiedAt", "completedAt"
  FROM "DataSubjectRequest"
 WHERE "id" = $1`;

/** Read one request. The caller's connection must see every row (not `app_user`). */
export async function readErasureRequest(db: ErasureRequestDb, requestId: string): Promise<ErasureRequestRow | null> {
    const rows = await db.$queryRawUnsafe<ErasureRequestRow[]>(REQUEST_SQL, requestId);
    return rows[0] ?? null;
}

const DUE_SQL = `SELECT "id", "userId", "type"::text AS "type", "status"::text AS "status", "verifiedAt", "completedAt"
  FROM "DataSubjectRequest"
 WHERE "type" = 'ERASURE'
   AND "status" IN ('VERIFIED', 'IN_PROGRESS')
   AND "verifiedAt" IS NOT NULL
   AND "verifiedAt" <= $1
   AND "completedAt" IS NULL
   AND "userId" IS NOT NULL
 ORDER BY "verifiedAt", "id"
 LIMIT $2`;

/**
 * The erasure requests that are due at `now`. Reads `limit` rows (default 2:
 * the action needs to know only "none, one, or more than one"). A request
 * whose subject is already erased is not due — it can never be fulfilled — and
 * is left on the register as it stands.
 */
export async function readDueErasureRequests(
    db: ErasureRequestDb,
    now: Date,
    limit = 2,
): Promise<ErasureRequestRow[]> {
    const verifiedBy = new Date(now.getTime() - DSAR_COOLING_OFF_HOURS * HOUR_MS);
    return db.$queryRawUnsafe<ErasureRequestRow[]>(DUE_SQL, verifiedBy, limit);
}

/**
 * Tenants where `userId` is the ONLY active OWNER. By the time an erasure may
 * run this is 0, because `planErasure` refuses while any membership is left;
 * it is still asked, so the rejection rule is applied rather than assumed.
 */
const SOLE_OWNER_SQL = `SELECT count(*)::int AS "n"
  FROM "TenantMembership" m
 WHERE m."userId" = $1 AND m."role" = 'OWNER' AND m."status" = 'ACTIVE'
   AND NOT EXISTS (
       SELECT 1 FROM "TenantMembership" o
        WHERE o."tenantId" = m."tenantId" AND o."userId" <> m."userId"
          AND o."role" = 'OWNER' AND o."status" = 'ACTIVE'
   )`;

/** `evaluateDsarRejection` for the subject, as the owner decided its inputs. */
export async function rejectionForSubject(db: ErasureRequestDb, userId: string): Promise<DsarRejectionReason | null> {
    const rows = await db.$queryRawUnsafe<{ n: number }[]>(SOLE_OWNER_SQL, userId);
    return evaluateDsarRejection({
        soleOwnerTenantCount: Number(rows[0]?.n ?? 0),
        // Not held by the product for a person (owner decision 2026-11-25):
        // OPERATOR_CHECKS says so on every plan.
        hasOutstandingBalance: false,
        hasLegalHold: false,
    });
}

/** The full decision: the register's refusals, then the rejection criteria. */
export async function decideErasureRequest(
    db: ErasureRequestDb,
    request: ErasureRequestRow | null,
    now: Date,
): Promise<ErasureRequestRefusal | null> {
    const refusal = erasureRequestRefusal(request, now);
    if (refusal) return refusal;
    const rejection = await rejectionForSubject(db, request!.userId!);
    return rejection ? { reason: 'REJECTION_CRITERION', rejection } : null;
}

/** The erasure was refused on its request. Nothing was written. */
export class ErasureRequestRefusedError extends ConflictError {
    readonly requestId: string;
    readonly refusal: ErasureRequestRefusal;

    constructor(requestId: string, refusal: ErasureRequestRefusal) {
        super(
            `dsar-erasure: request ${JSON.stringify(requestId)} refused: ${refusal.reason}`
                + `${refusal.rejection ? ` (${refusal.rejection})` : ''}. Nothing was written.`,
            { requestId, refusal },
        );
        this.name = 'ErasureRequestRefusedError';
        this.requestId = requestId;
        this.refusal = refusal;
    }
}

/**
 * Inside the erasure's transaction, before the User row is deleted: clear the
 * columns of every request of the subject that could still identify them, and
 * complete the request being fulfilled.
 *
 * `fulfilmentNotes` (free text staff wrote about what was done) and
 * `exportUrl` go to NULL on EVERY request of the subject (owner decision
 * 2026-11-25): the type, status, dates and rejection reason stay as the
 * evidence. `userId` itself is nulled by the FK's SET NULL at the delete.
 *
 * The completion is a conditional claim — the row must still be this
 * subject's IN_PROGRESS erasure — so a request moved under the erasure fails
 * the whole transaction rather than being completed from a stale read.
 */
export async function fulfilErasureRequestWithin(
    tx: ErasureRequestWriteDb,
    args: { userId: string; requestId: string | null; now: Date },
): Promise<{ requestsCleared: number; requestCompleted: boolean }> {
    const cleared = await tx.dataSubjectRequest.updateMany({
        where: { userId: args.userId },
        data: { fulfilmentNotes: null, exportUrl: null },
    });
    if (args.requestId === null) return { requestsCleared: cleared.count, requestCompleted: false };

    const completed = await tx.dataSubjectRequest.updateMany({
        where: { id: args.requestId, userId: args.userId, type: 'ERASURE', status: 'IN_PROGRESS' },
        data: { status: 'COMPLETED', completedAt: args.now },
    });
    if (completed.count !== 1) {
        throw new Error(
            `dsar-erasure: request ${JSON.stringify(args.requestId)} was no longer this subject's IN_PROGRESS `
                + 'erasure when the erasure tried to complete it. The whole erasure is rolled back.',
        );
    }
    return { requestsCleared: cleared.count, requestCompleted: true };
}
