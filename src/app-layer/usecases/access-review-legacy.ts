/**
 * Step 5b: recertifying one legacy application, from a reconciled snapshot.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS REUSES THE CONNECTED-APP DECISION TABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `LEGACY_APP` decisions land in `AccessReviewConnectedDecision`, with
 * `subjectRef` as `connectionId:accountKey` and `connectedAccountId` NULL — a
 * legacy account has no `ConnectedIdentityAccount` row, because nothing syncs
 * one and nothing ever will: the legacy client has no write operation.
 *
 * A third decision model would mean a third implementation of reminders,
 * closing, the evidence PDF and the decision list. The table already carries a
 * free-form `snapshotJson` and is unique on `(accessReviewId, subjectRef)`,
 * which is exactly the grain a frozen legacy subject needs.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FIVE REFUSALS, EACH NAMED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A campaign is a claim that somebody certified a known population at a known
 * moment. Every refusal below is a way that claim could be false:
 *
 *   NO_SNAPSHOT            nothing has been pulled from this application
 *   SNAPSHOT_STALE         the pull is older than the freshness window, so the
 *                          reviewer would certify a state that has since drifted
 *   SNAPSHOT_INCOMPLETE    the pull did not cover the whole population, so
 *                          "every account was reviewed" would be false
 *   NOT_RECONCILED         no resolution exists, so no subject can carry who it
 *                          belongs to — and a campaign of unattributed logins is
 *                          a list, not a certification
 *   NO_SUBJECTS            zero accounts. An empty campaign that CLOSES is the
 *                          worst outcome here: it produces evidence that
 *                          everything was reviewed, truthfully, about nothing
 *
 * They are checked in that order on purpose — each presupposes the one before,
 * and reporting the later failure of an earlier cause sends somebody to fix the
 * wrong thing.
 *
 * @module app-layer/usecases/access-review-legacy
 */

import { z } from 'zod';

import { badRequest } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { LEGACY_MCP_PROVIDER_ID } from '@/app-layer/integrations/providers/legacy-mcp';
import { OBSERVATION_FRESHNESS_MS } from '@/app-layer/usecases/identity-write-target';
import {
    DEFAULT_DORMANT_DAYS,
    findingsFor,
    populationContext,
    type FindingSubject,
} from '@/lib/legacy-access/findings';
import type { RequestContext } from '../types';
import { logEvent } from '../events/audit';
import { assertCanAdmin } from '../policies/common';
import { AccessReviewRepository } from '../repositories/AccessReviewRepository';

/**
 * The same window the rest of the subsystem uses.
 *
 * Imported rather than chosen: `legacy-reconcile` already refuses a run whose
 * roster is older than this, so a campaign with a looser window could certify a
 * population the reconciliation itself would have declined to resolve. One
 * freshness notion across the subsystem, or the two eventually disagree about
 * whether the same snapshot is usable.
 */
export const SNAPSHOT_FRESHNESS_MS = OBSERVATION_FRESHNESS_MS;

/**
 * The cap, and why it is read one past.
 *
 * `take: N` returning exactly N cannot be told apart from a population of
 * exactly N, so reading one past the cap is the only way to know the list was
 * cut off. A campaign that silently covers a PREFIX while closing as COMPLETE
 * is the failure this detects — the same reasoning, and the same number, as the
 * connected-app flow.
 */
const MAX_SUBJECTS = 5000;

export const CreateLegacyAccessReviewSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    connectionId: z.string().min(1).max(64),
    reviewerUserId: z.string().min(1),
    dueAt: z.coerce.date().optional(),
    periodStartAt: z.coerce.date().optional(),
    periodEndAt: z.coerce.date().optional(),
});

export type LegacyCampaignRefusal =
    | 'NO_SNAPSHOT'
    | 'SNAPSHOT_STALE'
    | 'SNAPSHOT_INCOMPLETE'
    | 'NOT_RECONCILED'
    | 'NO_SUBJECTS';

export const LEGACY_CAMPAIGN_REFUSALS: readonly LegacyCampaignRefusal[] = [
    'NO_SNAPSHOT',
    'SNAPSHOT_STALE',
    'SNAPSHOT_INCOMPLETE',
    'NOT_RECONCILED',
    'NO_SUBJECTS',
];

export interface CreateLegacyResult {
    readonly accessReviewId: string;
    readonly snapshotId: string;
    readonly executionId: string;
    readonly subjectCount: number;
    readonly snapshotTruncated: boolean;
    /** How many subjects carry each finding, for the creator's confirmation. */
    readonly findingCounts: Readonly<Record<string, number>>;
}

/** Thrown with the code in the message so a caller and a test can both read it. */
function refuse(code: LegacyCampaignRefusal, detail: string): never {
    throw badRequest(`${code}: ${detail}`);
}

export async function createLegacyAccessReview(
    ctx: RequestContext,
    input: unknown,
    now: Date = new Date()
): Promise<CreateLegacyResult> {
    assertCanAdmin(ctx);
    const parsed = CreateLegacyAccessReviewSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        // ── Gate 1-3: a complete, fresh, reconciled snapshot ────────────────
        const snapshot = await db.legacyAccessSnapshot.findFirst({
            where: {
                tenantId: ctx.tenantId,
                connectionId: parsed.connectionId,
            },
            orderBy: { completedAt: 'desc' },
            select: {
                id: true,
                status: true,
                completedAt: true,
                payloadHash: true,
                mappingVersion: true,
                rowCount: true,
            },
        });

        if (!snapshot) {
            refuse('NO_SNAPSHOT', `connection ${parsed.connectionId} has never been pulled`);
        }
        // Order matters: an INCOMPLETE snapshot usually has no completedAt, so
        // asking about freshness first would report staleness for a pull that
        // never finished — and send somebody to re-pull rather than to look at
        // why the pull was torn.
        if (snapshot.status !== 'COMPLETE') {
            refuse(
                'SNAPSHOT_INCOMPLETE',
                `the latest pull is ${snapshot.status}; a campaign over a partial population `
                + 'would certify "every account" about some of them'
            );
        }
        const completedAt = snapshot.completedAt;
        if (!completedAt || completedAt.getTime() < now.getTime() - SNAPSHOT_FRESHNESS_MS) {
            refuse(
                'SNAPSHOT_STALE',
                `the latest COMPLETE pull finished ${completedAt?.toISOString() ?? 'never'}, `
                + `outside the ${SNAPSHOT_FRESHNESS_MS / 86_400_000}-day window`
            );
        }

        // The reconciliation run. LATEST for this snapshot — resolutions are
        // immutable and a second run adds rather than overwrites, so "the
        // reconciled state" is the newest execution's rows.
        const latestResolution = await db.legacyAccountResolution.findFirst({
            where: { tenantId: ctx.tenantId, snapshotId: snapshot.id },
            orderBy: { createdAt: 'desc' },
            select: { executionId: true },
        });
        if (!latestResolution) {
            refuse(
                'NOT_RECONCILED',
                `snapshot ${snapshot.id} has no reconciliation run; its accounts carry no `
                + 'resolution, and a campaign of unattributed logins is a list rather than '
                + 'a certification'
            );
        }
        const executionId = latestResolution.executionId;

        // ── The subjects ───────────────────────────────────────────────────
        const accounts = await db.legacyAccount.findMany({
            where: { tenantId: ctx.tenantId, snapshotId: snapshot.id },
            orderBy: { accountKey: 'asc' },
            take: MAX_SUBJECTS + 1,
            select: {
                accountKey: true,
                displayName: true,
                email: true,
                department: true,
                title: true,
                managerRef: true,
                status: true,
                accountType: true,
                isPrivileged: true,
                lastLoginAt: true,
                sourceCreatedAt: true,
                entitlements: true,
                employeeNumber: true,
            },
        });
        const snapshotTruncated = accounts.length > MAX_SUBJECTS;
        const subjects = snapshotTruncated ? accounts.slice(0, MAX_SUBJECTS) : accounts;

        if (subjects.length === 0) {
            refuse(
                'NO_SUBJECTS',
                `snapshot ${snapshot.id} holds no accounts. An empty campaign that CLOSES `
                + 'produces evidence that everything was reviewed — truthfully, about nothing'
            );
        }

        const resolutions = await db.legacyAccountResolution.findMany({
            where: { tenantId: ctx.tenantId, executionId },
            select: { accountKey: true, outcome: true, method: true, employeeId: true },
        });
        const byKey = new Map(resolutions.map((r) => [r.accountKey, r]));

        const aliases = await db.legacyIdentityAlias.findMany({
            where: { tenantId: ctx.tenantId, connectionId: parsed.connectionId, status: 'ACTIVE' },
            select: { accountKey: true, classification: true, ownerUserId: true, method: true },
        });
        const aliasByKey = new Map(aliases.map((a) => [a.accountKey, a]));

        const employeeIds = [...new Set(resolutions.map((r) => r.employeeId).filter((x): x is string => Boolean(x)))];
        const employees = employeeIds.length
            ? await db.employee.findMany({
                where: { tenantId: ctx.tenantId, id: { in: employeeIds } },
                select: {
                    id: true, fullName: true, workEmail: true, status: true,
                    department: true, jobTitle: true,
                    manager: { select: { fullName: true, workEmail: true } },
                },
            })
            : [];
        const empById = new Map(employees.map((e) => [e.id, e]));

        // What the LAST CLOSED campaign recorded, for the mover check. CLOSED
        // only — not OPEN, not IN_REVIEW: an open campaign is a question in
        // progress, and comparing against it would call a reviewer's unfinished
        // work a personnel move. `AccessReviewStatus` is OPEN | IN_REVIEW |
        // CLOSED; there is no COMPLETED, which the first draft of this assumed.
        const priorReview = await db.accessReview.findFirst({
            where: { tenantId: ctx.tenantId, scope: 'LEGACY_APP', status: 'CLOSED' },
            orderBy: { createdAt: 'desc' },
            select: { id: true },
        });
        const priorCertification = new Map<string, { department: string | null; managerRef: string | null }>();
        if (priorReview) {
            const priorDecisions = await db.accessReviewConnectedDecision.findMany({
                where: { tenantId: ctx.tenantId, accessReviewId: priorReview.id },
                select: { subjectRef: true, snapshotJson: true },
            });
            for (const d of priorDecisions) {
                const snap = (d.snapshotJson ?? {}) as Record<string, unknown>;
                const key = String(snap.accountKey ?? '');
                if (!key) continue;
                priorCertification.set(key, {
                    department: typeof snap.department === 'string' ? snap.department : null,
                    managerRef: typeof snap.managerRef === 'string' ? snap.managerRef : null,
                });
            }
        }

        // ── Findings ───────────────────────────────────────────────────────
        const findingInputs: FindingSubject[] = subjects.map((a) => {
            const r = byKey.get(a.accountKey);
            const al = aliasByKey.get(a.accountKey);
            const emp = r?.employeeId ? empById.get(r.employeeId) : undefined;
            return {
                accountKey: a.accountKey,
                status: a.status,
                lastLoginAt: a.lastLoginAt,
                isPrivileged: a.isPrivileged,
                department: a.department,
                managerRef: a.managerRef,
                outcome: (r?.outcome ?? 'UNMATCHED') as FindingSubject['outcome'],
                employeeId: r?.employeeId ?? null,
                employmentStatus: (emp?.status ?? null) as FindingSubject['employmentStatus'],
                classification: (al?.classification ?? null) as FindingSubject['classification'],
                ownerUserId: al?.ownerUserId ?? null,
            };
        });
        const population = populationContext(findingInputs);
        const findingCtx = {
            now,
            dormantDays: DEFAULT_DORMANT_DAYS,
            ...population,
            priorCertification,
        };
        const findingsByKey = new Map(
            findingInputs.map((s) => [s.accountKey, findingsFor(s, findingCtx)])
        );

        const findingCounts: Record<string, number> = {};
        for (const fs of findingsByKey.values()) {
            for (const f of fs) findingCounts[f] = (findingCounts[f] ?? 0) + 1;
        }

        // ── Create, then freeze ────────────────────────────────────────────
        const review = await AccessReviewRepository.create(db, ctx, {
            name: sanitizePlainText(parsed.name),
            description: parsed.description ? sanitizePlainText(parsed.description) : null,
            scope: 'LEGACY_APP',
            periodStartAt: parsed.periodStartAt ?? null,
            periodEndAt: parsed.periodEndAt ?? null,
            reviewerUserId: parsed.reviewerUserId,
            dueAt: parsed.dueAt ?? null,
            snapshotTruncated,
        });

        await db.accessReviewConnectedDecision.createMany({
            data: subjects.map((a) => {
                const r = byKey.get(a.accountKey);
                const al = aliasByKey.get(a.accountKey);
                const emp = r?.employeeId ? empById.get(r.employeeId) : undefined;
                return {
                    tenantId: ctx.tenantId,
                    accessReviewId: review.id,
                    // NULL: a legacy account has no ConnectedIdentityAccount, and
                    // inventing one would put a row in the directory tables that
                    // the forward-lock guard exists to keep out.
                    connectedAccountId: null,
                    subjectRef: `${parsed.connectionId}:${a.accountKey}`,
                    snapshotJson: {
                        // The canonical fields, as reviewed. Frozen here so a
                        // later pull changes nothing in an open campaign — the
                        // decision is against the state somebody saw.
                        accountKey: a.accountKey,
                        displayName: a.displayName,
                        email: a.email,
                        department: a.department,
                        title: a.title,
                        managerRef: a.managerRef,
                        status: a.status,
                        accountType: a.accountType,
                        isPrivileged: a.isPrivileged,
                        lastLoginAt: a.lastLoginAt?.toISOString() ?? null,
                        sourceCreatedAt: a.sourceCreatedAt?.toISOString() ?? null,
                        entitlements: a.entitlements,
                        employeeNumber: a.employeeNumber,
                        // The resolution: WHO the engine said this is, and how it
                        // knew. The method is in the evidence PDF, so it is stored
                        // rather than re-derived from a run that may since have
                        // been superseded.
                        resolution: {
                            outcome: r?.outcome ?? 'UNMATCHED',
                            method: r?.method ?? 'NO_CANDIDATES',
                            employeeId: r?.employeeId ?? null,
                            executionId,
                        },
                        // A reviewer's standing classification, if any.
                        classification: al
                            ? { kind: al.classification, method: al.method, ownerUserId: al.ownerUserId }
                            : null,
                        // HR context. Null when the account resolved to nobody —
                        // recorded explicitly rather than by omitting the key, so
                        // a reviewer can tell "no employee" from "we did not look".
                        hr: emp
                            ? {
                                employeeId: emp.id,
                                fullName: emp.fullName,
                                workEmail: emp.workEmail,
                                employmentStatus: emp.status,
                                department: emp.department,
                                jobTitle: emp.jobTitle,
                                managerName: emp.manager?.fullName ?? null,
                                managerEmail: emp.manager?.workEmail ?? null,
                            }
                            : null,
                        findings: findingsByKey.get(a.accountKey) ?? [],
                        // The provenance an auditor ties the campaign to.
                        provenance: {
                            snapshotId: snapshot.id,
                            payloadHash: snapshot.payloadHash,
                            mappingVersion: snapshot.mappingVersion,
                            connectionId: parsed.connectionId,
                        },
                    },
                };
            }),
            // The unique is (accessReviewId, subjectRef) and this review was
            // just created, so nothing can collide. Set anyway: a retry that
            // re-entered after a partial write must not fail the whole campaign.
            skipDuplicates: true,
        });

        await logEvent(db, ctx, {
            entityType: 'AccessReview',
            entityId: review.id,
            action: 'LEGACY_ACCESS_REVIEW_CREATED',
            details:
                `Legacy recertification "${review.name}" created over ${subjects.length} account(s) `
                + `from snapshot ${snapshot.id}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AccessReview',
                operation: 'create',
                scope: 'LEGACY_APP',
                connectionId: parsed.connectionId,
                snapshotId: snapshot.id,
                // The hash, so "what the application reported, and when" is in a
                // hash-chained row rather than only in a JSON column.
                payloadHash: snapshot.payloadHash,
                mappingVersion: snapshot.mappingVersion,
                executionId,
                subjectCount: subjects.length,
                snapshotTruncated,
                findingCounts,
            },
        });

        return {
            accessReviewId: review.id,
            snapshotId: snapshot.id,
            executionId,
            subjectCount: subjects.length,
            snapshotTruncated,
            findingCounts,
        };
    });
}
