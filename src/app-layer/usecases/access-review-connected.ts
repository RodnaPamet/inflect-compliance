/**
 * Connected-app access reviews (PR-7) — the CONNECTED_APP scope.
 *
 * Reviews connected identity-provider accounts (Okta / Google Workspace /
 * Microsoft Entra ID / Active Directory — PR-2's ConnectedIdentityAccount)
 * rather than tenant memberships. An optional `provider` scopes the campaign to
 * one directory; omit it to review every synced directory. Kept in a
 * SEPARATE module writing to AccessReviewConnectedDecision so the mature
 * member-review flow (access-review.ts) is 100% untouched.
 *
 * On close, a REVOKE/MODIFY emits a remediation Task (we do not write back to
 * the IdP automatically — deprovisioning is a gated, out-of-band action).
 */
import { z } from 'zod';
import { RequestContext } from '../types';
import { AccessReviewRepository } from '../repositories/AccessReviewRepository';
import { assertCanAdmin, assertCanRead } from '../policies/common';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { badRequest, notFound, forbidden, DomainError } from '@/lib/errors/types';
import { generateAccessReviewPdf, type DirectorySnapshotRole, type DirectorySnapshotStatus } from '../reports/pdf/accessReview';
import { collectPdfBuffer } from '../reports/pdf/collect-buffer';
import { getStorageProvider, buildTenantObjectKey } from '@/lib/storage';
import { Readable } from 'node:stream';
import { logger } from '@/lib/observability/logger';

const IDENTITY_PROVIDERS = ['okta', 'google-workspace', 'entra-id', 'active-directory'];
const MAX_SUBJECTS = 5000;

export const CreateConnectedAccessReviewSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    /** Restrict to one provider; omit to review all connected identity accounts. */
    provider: z.enum(['okta', 'google-workspace', 'entra-id', 'active-directory']).optional(),
    reviewerUserId: z.string().min(1),
    dueAt: z.coerce.date().optional(),
    periodStartAt: z.coerce.date().optional(),
    periodEndAt: z.coerce.date().optional(),
});

export interface CreateConnectedResult {
    accessReviewId: string;
    snapshotCount: number;
    /** The directory held more than `MAX_SUBJECTS` accounts; this campaign covers a prefix. */
    snapshotTruncated: boolean;
}

export async function createConnectedAccessReview(ctx: RequestContext, input: unknown): Promise<CreateConnectedResult> {
    assertCanAdmin(ctx);
    const parsed = CreateConnectedAccessReviewSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        // MAX_SUBJECTS + 1, deliberately. `take: N` returning exactly N cannot
        // be told apart from a directory of exactly N accounts, so reading one
        // past the cap is the only way to know the list was cut off — and a
        // campaign that silently covers a PREFIX of the directory while
        // closing as COMPLETE is the failure this detects.
        const found = await db.connectedIdentityAccount.findMany({
            where: { tenantId: ctx.tenantId, status: 'ACTIVE', provider: parsed.provider ? parsed.provider : { in: IDENTITY_PROVIDERS } },
            select: { id: true, provider: true, email: true, displayName: true, isAdmin: true, mfaEnrolled: true, groupsJson: true, connectionId: true, externalUserId: true },
            orderBy: [{ connectionId: 'asc' }, { externalUserId: 'asc' }],
            take: MAX_SUBJECTS + 1,
        });
        if (found.length === 0) {
            // A coded refusal, not a bare 400: "the directory has nobody in
            // scope" and "the sync is broken or never ran" need different
            // answers from the UI, and the second is both the common case and
            // the one that would otherwise produce a complete-looking campaign
            // over zero subjects.
            throw new DomainError(
                'No active connected identity accounts match the requested scope — the campaign would have zero subjects. Connect and sync a directory (Okta / Google Workspace / Microsoft Entra ID / Active Directory) first.',
                'NO_SUBJECTS',
                400,
            );
        }
        const snapshotTruncated = found.length > MAX_SUBJECTS;
        const accounts = snapshotTruncated ? found.slice(0, MAX_SUBJECTS) : found;

        // HR context, READ ONLY. `IdentityAccountLink` is written by the
        // identity sync and the Step 0a guard asserts this module is not one of
        // its writers — so this is a `findMany` and must stay one. One query
        // for the whole snapshot rather than per subject: the link is unique
        // per connected account, so the join is 1:1 and an n+1 here would be
        // 5000 round trips.
        const links = await db.identityAccountLink.findMany({
            where: { tenantId: ctx.tenantId, connectedAccountId: { in: accounts.map((a) => a.id) } },
            select: {
                connectedAccountId: true,
                matchMethod: true,
                contradictedAt: true,
                employee: {
                    select: {
                        id: true,
                        fullName: true,
                        workEmail: true,
                        status: true,
                        department: true,
                        jobTitle: true,
                        manager: { select: { fullName: true, workEmail: true } },
                    },
                },
            },
        });
        const hrByAccount = new Map(links.map((l) => [l.connectedAccountId, l]));

        const review = await AccessReviewRepository.create(db, ctx, {
            name: sanitizePlainText(parsed.name),
            description: parsed.description ? sanitizePlainText(parsed.description) : null,
            scope: 'CONNECTED_APP',
            periodStartAt: parsed.periodStartAt ?? null,
            periodEndAt: parsed.periodEndAt ?? null,
            reviewerUserId: parsed.reviewerUserId,
            dueAt: parsed.dueAt ?? null,
            snapshotTruncated,
        });

        // Freeze each entitlement into snapshotJson so the decision is against
        // the reviewed state, not a later drifted directory.
        await db.accessReviewConnectedDecision.createMany({
            data: accounts.map((a) => {
                const link = hrByAccount.get(a.id);
                return {
                    tenantId: ctx.tenantId,
                    accessReviewId: review.id,
                    connectedAccountId: a.id,
                    // SCOPED TO THE CONNECTION, not to provider + email.
                    //
                    // `AccessReviewConnectedDecision` is unique on
                    // (accessReviewId, subjectRef) and this createMany runs with
                    // `skipDuplicates`, so a subjectRef that collides DROPS a
                    // subject silently. `provider:email` collides exactly when
                    // one tenant holds two connections for one provider — two AD
                    // forests, two Entra tenants — which `IntegrationConnection`
                    // supports by being unique on (tenantId, provider, NAME).
                    // The account's own grain is (tenantId, connectionId,
                    // externalUserId), so that is the grain a subject reference
                    // has to use; anything coarser merges two real people, or
                    // one person's two accounts, into one reviewed row.
                    //
                    // Existing rows keep `provider:email`. Nothing parses a
                    // subjectRef — it is displayed, and the snapshot below
                    // carries provider and email for that — so the two formats
                    // coexist and old campaigns stay readable.
                    subjectRef: `${a.connectionId}:${a.externalUserId}`,
                    snapshotJson: {
                        provider: a.provider,
                        email: a.email,
                        displayName: a.displayName,
                        isAdmin: a.isAdmin,
                        mfaEnrolled: a.mfaEnrolled,
                        groups: a.groupsJson,
                        connectionId: a.connectionId,
                        externalUserId: a.externalUserId,
                        // Null when the account is linked to no worker — a
                        // service account, a contractor the HR feed does not
                        // carry, or an unreconciled one. The reviewer needs to
                        // see WHICH of those it is, so the absence is recorded
                        // explicitly rather than by omitting the key.
                        hr: link
                            ? {
                                employeeId: link.employee.id,
                                fullName: link.employee.fullName,
                                workEmail: link.employee.workEmail,
                                employmentStatus: link.employee.status,
                                department: link.employee.department,
                                jobTitle: link.employee.jobTitle,
                                managerName: link.employee.manager?.fullName ?? null,
                                managerEmail: link.employee.manager?.workEmail ?? null,
                                matchMethod: link.matchMethod,
                                // A pairing a later sync OBSERVED to be
                                // contradicted is not evidence about this
                                // person. Surfaced so a reviewer does not read
                                // stale HR context as current.
                                contradicted: link.contradictedAt !== null,
                            }
                            : null,
                    },
                };
            }),
            skipDuplicates: true,
        });

        await logEvent(db, ctx, {
            action: 'ACCESS_REVIEW_CREATED',
            entityType: 'AccessReview',
            entityId: review.id,
            detailsJson: { category: 'entity_lifecycle', entityName: 'AccessReview', operation: 'create', summary: `Connected-app access review "${review.name}" created with ${accounts.length} account(s)${snapshotTruncated ? ` (TRUNCATED at the ${MAX_SUBJECTS}-subject cap — the directory holds more)` : ''}`, after: { scope: 'CONNECTED_APP', snapshotCount: accounts.length, provider: parsed.provider ?? 'all', snapshotTruncated } },
        });

        return { accessReviewId: review.id, snapshotCount: accounts.length, snapshotTruncated };
    });
}

export async function listConnectedDecisions(ctx: RequestContext, accessReviewId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        db.accessReviewConnectedDecision.findMany({
            where: { tenantId: ctx.tenantId, accessReviewId },
            select: { id: true, subjectRef: true, snapshotJson: true, decision: true, decidedAt: true, notes: true, executedAt: true },
            orderBy: { subjectRef: 'asc' },
            take: MAX_SUBJECTS,
        }),
    );
}

export const SubmitConnectedDecisionSchema = z.object({
    decision: z.enum(['CONFIRM', 'REVOKE', 'MODIFY']),
    notes: z.string().max(2000).optional(),
});

export async function submitConnectedDecision(ctx: RequestContext, decisionId: string, input: unknown, now: Date = new Date()) {
    assertCanRead(ctx);
    const parsed = SubmitConnectedDecisionSchema.parse(input);
    return runInTenantContext(ctx, async (db) => {
        // H4 — a CONNECTED_APP verdict becomes SOC 2 evidence and spawns
        // deprovision tasks, so it must carry the SAME reviewer gate as the
        // member flow: only the campaign's assigned reviewer (or a tenant admin)
        // may decide, and never on a CLOSED campaign. Previously this was
        // assertCanRead ONLY — any read-only member could record verdicts.
        const decision = await db.accessReviewConnectedDecision.findFirst({
            where: { id: decisionId, tenantId: ctx.tenantId },
            select: { id: true, decision: true, accessReview: { select: { reviewerUserId: true, status: true, deletedAt: true } } },
        });
        if (!decision || !decision.accessReview || decision.accessReview.deletedAt !== null) throw notFound('Decision not found.');
        if (decision.accessReview.status === 'CLOSED') throw badRequest('This campaign is closed; decisions are immutable.');
        const isAssignedReviewer = decision.accessReview.reviewerUserId === ctx.userId;
        if (!isAssignedReviewer && !ctx.permissions?.canAdmin) {
            throw forbidden('Only the assigned reviewer (or a tenant admin) may submit connected-app decisions.');
        }

        const res = await db.accessReviewConnectedDecision.updateMany({
            where: { id: decisionId, tenantId: ctx.tenantId, decision: null },
            data: { decision: parsed.decision, notes: parsed.notes ? sanitizePlainText(parsed.notes) : null, decidedAt: now, decidedByUserId: ctx.userId },
        });
        if (res.count === 0) throw badRequest('Decision not found or already decided.');
        return { decisionId, decision: parsed.decision };
    });
}

export interface CloseConnectedResult {
    accessReviewId: string;
    executed: number;
    remediationTasks: number;
    /** The campaign covered a prefix of the directory; it cannot claim full coverage. */
    snapshotTruncated: boolean;
    /** The hashed evidence PDF, or null when generation failed (the close still stands). */
    evidenceFileRecordId: string | null;
}

/**
 * Close a CONNECTED_APP review. Rejects pending decisions, emits a remediation
 * Task for every REVOKE/MODIFY (deprovisioning is out-of-band, not auto), marks
 * each decision executed, and flips the campaign CLOSED. Delegated to from
 * `closeAccessReview` when the campaign scope is CONNECTED_APP.
 */
/**
 * Close a CONNECTED_APP review in TWO PHASES, and the split is the point.
 *
 * Phase 1 is the transaction: guards, the conditional close claim, remediation
 * tasks, the executed stamps, the close audit row. Phase 2 happens AFTER it
 * commits: render the evidence PDF, hash it, store it, attach the FileRecord.
 *
 * PDF rendering and object-storage I/O must not sit inside the transaction.
 * `runInTenantContext` IS a `$transaction`, so a slow storage backend would
 * hold a tenant-scoped transaction open for the duration of an upload, and a
 * storage timeout would roll back a close the operator was told had happened.
 * The member flow at `access-review.ts` already splits for exactly this reason
 * and phase 2 there is wrapped in a catch that logs and continues; this mirrors
 * it, so a failed artefact leaves a CLOSED campaign with a null evidence link
 * rather than an un-closed campaign.
 */
/**
 * What the remediation task tells the reviewer to do.
 *
 * Scope-aware, because the wording is an INSTRUCTION. "Remove this account in
 * the identity provider" is right for a connected campaign and wrong for a
 * legacy one: nothing of ours writes to a legacy application — the client has
 * no write operation at all — and a task implying otherwise invites somebody to
 * wait for an automation that will never run, which is the worst possible
 * outcome for a revoke.
 *
 * Exported so the wording can be asserted directly. `Task.description` is in
 * the encryption manifest, so an integration test reading the row back gets
 * ciphertext — a test that matched the plaintext there would have been
 * asserting nothing, and one that gave up would leave the most consequential
 * sentence in the subsystem untested.
 */
export function remediationDescription(input: {
    scope: string;
    reviewName: string;
    decision: string | null;
    subjectRef: string;
}): string {
    const head = `Access review "${input.reviewName}" decided ${input.decision} for ${input.subjectRef}.`;
    return input.scope === 'LEGACY_APP'
        ? `${head} Make this change IN THE LEGACY APPLICATION ITSELF and then close this task — `
            + 'Inflect reads that application and never writes to it, so nothing here will '
            + 'action it for you.'
        : `${head} Remove or adjust this account in the identity provider, then close this task.`;
}

/**
 * The campaign-level provenance, from the subjects' own frozen snapshots.
 *
 * Returns null when no subject carries one, which is every CONNECTED_APP
 * campaign — so the PDF's provenance block and its "Attributed by" column stay
 * out of artefacts that have nothing to put in them.
 */
function legacyProvenanceOf(
    decisions: readonly { snapshotJson: unknown }[]
): { snapshotId: string; payloadHash: string; mappingVersion: number; connectionId: string } | null {
    for (const d of decisions) {
        const snap = (d.snapshotJson ?? {}) as Record<string, unknown>;
        const p = snap.provenance as Record<string, unknown> | undefined;
        if (
            p
            && typeof p.snapshotId === 'string'
            && typeof p.payloadHash === 'string'
            && typeof p.mappingVersion === 'number'
            && typeof p.connectionId === 'string'
        ) {
            return {
                snapshotId: p.snapshotId,
                payloadHash: p.payloadHash,
                mappingVersion: p.mappingVersion,
                connectionId: p.connectionId,
            };
        }
    }
    return null;
}

/** How the account was attributed to a person, if it was. */
function resolutionMethodOf(snapshotJson: unknown): string | null {
    const snap = (snapshotJson ?? {}) as Record<string, unknown>;
    const r = snap.resolution as Record<string, unknown> | undefined;
    return r && typeof r.method === 'string' ? r.method : null;
}

export async function closeConnectedAccessReview(ctx: RequestContext, accessReviewId: string, now: Date = new Date()): Promise<CloseConnectedResult> {
    assertCanAdmin(ctx);
    const phase1 = await runInTenantContext(ctx, async (db) => {
        const review = await db.accessReview.findFirst({ where: { id: accessReviewId, tenantId: ctx.tenantId }, select: { id: true, name: true, description: true, scope: true, periodStartAt: true, periodEndAt: true, status: true, deletedAt: true, snapshotTruncated: true, reviewer: { select: { email: true } }, createdBy: { select: { email: true } }, tenant: { select: { name: true } } } });
        if (!review || review.deletedAt !== null) throw notFound('Access review not found');
        if (review.status === 'CLOSED') throw badRequest('Campaign is already closed.');

        const decisions = await db.accessReviewConnectedDecision.findMany({ where: { tenantId: ctx.tenantId, accessReviewId }, select: { id: true, subjectRef: true, decision: true, decidedAt: true, executedAt: true, notes: true, snapshotJson: true }, orderBy: { subjectRef: 'asc' } });

        // ZERO IS NOT COMPLETE.
        //
        // The pending check below is `decisions.filter(d => d.decision === null)`
        // and an empty campaign has zero pending — so before this guard, a
        // CONNECTED_APP review with no subjects at all closed instantly,
        // reporting `executed: 0`, and produced an evidence artefact attesting
        // that every account in scope had been reviewed. Vacuously true of its
        // rows; false of the directory, which is the only reading an auditor
        // cares about. `createConnectedAccessReview` now refuses NO_SUBJECTS at
        // create, so this is the second half of the same rule and it covers the
        // states that refusal cannot: a campaign created before that guard
        // existed, and one whose decisions were deleted by a connection cascade.
        if (decisions.length === 0) {
            throw badRequest('Cannot close: this campaign has no subjects. A review over zero accounts cannot evidence that any access was reviewed — a directory that returns nothing means a broken sync, not an empty application.');
        }

        const pending = decisions.filter((d) => d.decision === null);
        if (pending.length > 0) {
            throw badRequest(`Cannot close: ${pending.length} decision(s) are still pending. Every account must be CONFIRMed, REVOKEd, or MODIFYd before close.`);
        }

        // H4 — atomically CLAIM the close (conditional on not-yet-CLOSED) BEFORE
        // creating any side effects. Two concurrent closes both pass the
        // read-check above, but only one updateMany matches a not-CLOSED row;
        // the loser gets count===0 and bails without duplicate remediation tasks.
        const claim = await db.accessReview.updateMany({
            where: { id: accessReviewId, tenantId: ctx.tenantId, deletedAt: null, status: { not: 'CLOSED' } },
            data: { status: 'CLOSED', closedAt: now, closedByUserId: ctx.userId },
        });
        if (claim.count === 0) {
            // The other close won. It is producing the artefact, so this call
            // must not: `alreadyClosed` short-circuits phase 2 rather than
            // writing a second FileRecord for one campaign.
            return { review, decisions, remediationTasks: 0, closerEmail: '(unknown)', alreadyClosed: true as const };
        }

        let remediationTasks = 0;
        for (const d of decisions) { // guardrail-allow: n+1 — per-decision, bounded by campaign size
            // Skip decisions already executed by a prior (partial) close — idempotent.
            if (d.executedAt) continue;
            if (d.decision === 'REVOKE' || d.decision === 'MODIFY') {
                await db.task.create({
                    data: {
                        tenantId: ctx.tenantId,
                        title: `Deprovision access: ${d.subjectRef}`.slice(0, 250),
                        description: remediationDescription({
                            scope: review.scope,
                            reviewName: review.name,
                            decision: d.decision,
                            subjectRef: d.subjectRef,
                        }),
                        createdByUserId: ctx.userId,
                        source: 'MANUAL',
                    },
                });
                remediationTasks += 1;
            }
            await db.accessReviewConnectedDecision.updateMany({ where: { id: d.id, tenantId: ctx.tenantId, executedAt: null }, data: { executedAt: now, executedByUserId: ctx.userId } });
        }

        await logEvent(db, ctx, {
            action: 'ACCESS_REVIEW_DECISION_EXECUTED',
            entityType: 'AccessReview',
            entityId: accessReviewId,
            // The truncation verdict travels with the CLOSE row, not only the
            // create row: this is the entry an auditor reads to find out what
            // the campaign attested, and a campaign that covered a prefix of
            // the directory must say so at the moment it claims completion.
            detailsJson: { category: 'access', entityName: 'AccessReview', operation: 'close', summary: `Closed connected-app review "${review.name}" — ${decisions.length} decision(s), ${remediationTasks} remediation task(s)${review.snapshotTruncated ? ` — SNAPSHOT TRUNCATED at the ${MAX_SUBJECTS}-subject cap, so this campaign does not cover the whole directory` : ''}`, after: { executed: decisions.length, remediationTasks, snapshotTruncated: review.snapshotTruncated } },
        });

        // Inside the tenant-bound transaction: `db`, not the global prisma
        // client, which a CI guardrail forbids in tenant code.
        const closerRow = await db.user.findUnique({ where: { id: ctx.userId }, select: { email: true } });

        return { review, decisions, remediationTasks, closerEmail: closerRow?.email ?? '(unknown)', alreadyClosed: false as const };
    });

    const result: CloseConnectedResult = {
        accessReviewId,
        executed: phase1.decisions.length,
        remediationTasks: phase1.remediationTasks,
        snapshotTruncated: phase1.review.snapshotTruncated,
        evidenceFileRecordId: null,
    };
    if (phase1.alreadyClosed) return result;

    // ─── Phase 2 — the evidence artefact, outside the transaction ───
    try {
        const pdfDoc = generateAccessReviewPdf({
            tenantName: phase1.review.tenant.name,
            campaignName: phase1.review.name,
            campaignDescription: phase1.review.snapshotTruncated
                ? `PARTIAL COVERAGE — the directory held more than ${MAX_SUBJECTS} active accounts and this campaign reviewed the first ${MAX_SUBJECTS}. It does not evidence that every account was reviewed.${phase1.review.description ? ` — ${phase1.review.description}` : ''}`
                : phase1.review.description ?? null,
            scope: phase1.review.scope,
            periodStartIso: phase1.review.periodStartAt?.toISOString() ?? null,
            periodEndIso: phase1.review.periodEndAt?.toISOString() ?? null,
            reviewerEmail: phase1.review.reviewer.email,
            createdByEmail: phase1.review.createdBy.email,
            closedByEmail: phase1.closerEmail,
            closedAtIso: now.toISOString(),
            // Read off the FIRST subject's frozen snapshot rather than re-queried.
            // Every subject of one campaign carries the same provenance — it was
            // written from one snapshot at create — and re-reading the snapshot
            // row here would reintroduce exactly the drift the freeze removed:
            // the mapping version could have moved since.
            legacyProvenance: legacyProvenanceOf(phase1.decisions),
            decisions: phase1.decisions.map((d) => {
                const snap = (d.snapshotJson ?? {}) as Record<string, unknown>;
                return {
                    subjectUserEmail: typeof snap.email === 'string' ? snap.email : d.subjectRef,
                    subjectUserName: typeof snap.displayName === 'string' ? snap.displayName : null,
                    snapshotRole: (snap.isAdmin === true ? 'DIRECTORY_ADMIN' : 'DIRECTORY_USER') as DirectorySnapshotRole,
                    snapshotMembershipStatus: (snap.mfaEnrolled === true ? 'MFA_ENROLLED' : 'MFA_MISSING') as DirectorySnapshotStatus,
                    decision: d.decision,
                    decidedAtIso: d.decidedAt?.toISOString() ?? null,
                    // Present only for LEGACY_APP, where the attribution was an
                    // INFERENCE. `undefined` elsewhere, which is what keeps the
                    // column out of every member-flow artefact.
                    resolutionMethod: resolutionMethodOf(d.snapshotJson),
                    // Connected notes are a PLAIN column and
                    // `submitConnectedDecision` writes them through
                    // `sanitizePlainText`, so they are safe to render — unlike
                    // the member flow, whose notes are encrypted and therefore
                    // deliberately omitted from its PDF. Sanitised again here
                    // because a row written before that sanitisation existed
                    // would otherwise reach the artefact unfiltered, and a PDF
                    // is the one output nobody re-reads before an auditor does.
                    notes: d.notes ? sanitizePlainText(d.notes) : null,
                    modifiedToRole: null,
                    executionOutcome: d.executedAt ? 'EXECUTED' : 'SKIPPED_PENDING',
                };
            }),
            // `WatermarkMode` is 'DRAFT' | 'FINAL' | 'NONE' and the artefact IS
            // final, so the coverage caveat cannot live in the watermark. It
            // goes in the rendered description instead, and — more importantly
            // — in the hash-chained close audit row, which is the
            // tamper-evident copy. `computeContentHash` is deliberately NOT
            // extended to cover it: that canonical JSON is a published evidence
            // contract, and adding a field would change the hash of every
            // artefact ever generated, invalidating exactly the verification it
            // exists to support.
            watermark: 'FINAL',
        });

        const pdfBuffer = await collectPdfBuffer(pdfDoc);
        const fileName = `access_review_${phase1.review.name.replace(/[^a-z0-9]+/gi, '_')}_${now.toISOString().slice(0, 10)}.pdf`;
        const storage = getStorageProvider();
        const pathKey = buildTenantObjectKey(ctx.tenantId, 'evidence', fileName);
        const writeResult = await storage.write(pathKey, Readable.from(pdfBuffer), { mimeType: 'application/pdf' });

        const fileRecordId = await runInTenantContext(ctx, async (db) => {
            const record = await db.fileRecord.create({
                data: {
                    tenantId: ctx.tenantId,
                    pathKey,
                    originalName: fileName,
                    mimeType: 'application/pdf',
                    sizeBytes: writeResult.sizeBytes,
                    sha256: writeResult.sha256,
                    status: 'STORED',
                    uploadedByUserId: ctx.userId,
                    storedAt: new Date(),
                    storageProvider: storage.name,
                    domain: 'evidence',
                    /// AV scan is irrelevant for self-generated PDFs.
                    scanStatus: 'SKIPPED',
                },
            });
            // Second, unconditional call — the same shape the member flow uses
            // to attach its artefact after phase 1 flipped the status. The
            // TOCTOU guard was the conditional claim above, not this update.
            await AccessReviewRepository.closeCampaign(db, ctx, accessReviewId, now, record.id);
            await logEvent(db, ctx, {
                action: 'ACCESS_REVIEW_EVIDENCE_GENERATED',
                entityType: 'AccessReview',
                entityId: accessReviewId,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'FileRecord',
                    operation: 'create',
                    summary: `Generated connected-app access-review evidence PDF (sha256=${writeResult.sha256})`,
                    after: { fileRecordId: record.id, pathKey, sizeBytes: writeResult.sizeBytes, sha256: writeResult.sha256, snapshotTruncated: phase1.review.snapshotTruncated },
                },
            });
            return record.id;
        });
        result.evidenceFileRecordId = fileRecordId;
    } catch (err) {
        // The close has already committed. Leave it closed with a null
        // evidence link and say so loudly; regeneration is a follow-up, and a
        // thrown error here would tell the operator the close failed when it
        // did not.
        logger.error('access-review.connected_closeout.pdf_generation_failed', {
            component: 'access-review',
            accessReviewId,
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return result;
}
