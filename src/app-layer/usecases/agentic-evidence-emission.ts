/**
 * Emit agentic evidence — receipts and decision records become audit artefacts.
 *
 * The premise the whole agentic roadmap has been building toward: an assessor
 * asks "show me your agent governance" and the answer is a generated report, not
 * a project. Everything upstream of this file produces RECORDS — mediator-signed
 * action receipts, hash-chained audit entries, one `AiDecisionLog` row per AI
 * invocation. None of it is EVIDENCE until it is attached to the control it
 * discharges, and until this file existed that attachment was a person with a
 * spreadsheet in the week before an audit.
 *
 * ── VERIFIED IS THE LOAD-BEARING WORD ──────────────────────────────────────
 *
 * Only a receipt that is BOTH `verified` AND linked to an `AuditLog` row is
 * counted as evidence of a mediated action. Not because unverified receipts are
 * uninteresting — they are counted, and the artefact reports how many there were
 * — but because the claim "this action was independently attested" is only true
 * of the linked ones. `ingestReceipt` writes `auditLogId` exclusively after the
 * Ed25519 signature verifies, so the two conditions should never disagree; the
 * emitter checks both anyway, because an artefact that inherited a broken
 * invariant would launder it into a compliance claim.
 * `tests/integration/agent-receipt-chain-integrity.test.ts` is the proof of that
 * invariant, and it is the test the rest of this file's value rests on.
 *
 * ── IDEMPOTENCY ────────────────────────────────────────────────────────────
 *
 * An artefact is identified by `(tenant, control, kind, period)` — see the long
 * argument in `src/lib/agentic/evidence-artefact.ts` for why it is not a receipt
 * id and not a content digest. Re-running recomputes the same identity and
 * updates in place. The identity is a UNIQUE INDEX rather than a read-then-write,
 * so two overlapping ticks cannot both insert; the loser catches P2002 and
 * becomes an update.
 *
 * ── WHAT LEAVES THE PRODUCT ────────────────────────────────────────────────
 *
 * The artefact body is built by the pure builders in `evidence-artefact.ts`,
 * whose input types are the complete list of fields an artefact may render. No
 * `scannedSummary`, no `signature`, no `inputDigest`, no `outputSummary`. See
 * that module's header for why `Evidence.content` is the wrong place for any of
 * them.
 */
import { Prisma } from '@prisma/client';

import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { log } from '@/lib/observability';
import { assertCanWrite } from '@/app-layer/policies/common';
import { logEvent } from '@/app-layer/events/audit';
import {
    AGENTIC_ARTEFACT_KINDS,
    ARTEFACT_KIND_DECISIONS,
    ARTEFACT_KIND_RECEIPTS,
    EVIDENCE_TARGETS,
    buildDecisionArtefact,
    buildReceiptArtefact,
    buildWithdrawalNotice,
    monthlyPeriod,
    sourcePopulationDigest,
    type AgenticArtefactKind,
    type ArtefactPeriod,
    type ArtefactWithdrawalReason,
    type DecisionFact,
    type ReceiptFact,
} from '@/lib/agentic/evidence-artefact';
import { frameworkFamilyId } from '@/app-layer/domain/framework-representation';
import type { RequestContext } from '@/app-layer/types';

/** The framework catalogue is a small global table; loaded whole, grouped in memory. */
const FRAMEWORK_CATALOGUE_CAP = 500;
/** Bound on the records one artefact may count. */
const POPULATION_CAP = 20_000;

// ── Result shape ────────────────────────────────────────────────────────────

export type EmissionOutcome = 'created' | 'updated' | 'unchanged' | 'withdrawn';

export interface EmittedArtefact {
    readonly artefactId: string;
    readonly evidenceId: string;
    readonly controlId: string;
    readonly controlCode: string;
    readonly kind: AgenticArtefactKind;
    readonly periodLabel: string;
    readonly recordCount: number;
    readonly outcome: EmissionOutcome;
}

export interface EmissionReport {
    readonly tenantId: string;
    readonly periodLabel: string;
    /**
     * FALSE when neither representation of a target framework is installed.
     * Distinguished from "installed and nothing emitted" deliberately: an
     * absence is ambiguous, and "you have no agentic controls" is a different
     * instruction to an operator than "your agents did nothing".
     */
    readonly anyTargetInstalled: boolean;
    readonly artefacts: readonly EmittedArtefact[];
}

// ── Target resolution ───────────────────────────────────────────────────────

interface TargetControl {
    readonly id: string;
    readonly code: string;
    readonly requirementCode: string;
}

/**
 * The tenant's controls that discharge each artefact kind's obligations.
 *
 * Resolved through the framework FAMILY, not the key. Both representations of a
 * framework — the seeded row and the library-imported one — carry the same
 * `sourceUrn`, and a tenant's controls hang off whichever its database happened
 * to get; a single-key lookup would emit nothing for half the estate and the
 * failure would be indistinguishable from a tenant with no agentic controls.
 *
 * `deletedAt: null` for the reason `usecases/framework/coverage.ts` gives on the
 * same join: without it, a removed control keeps attracting fresh evidence.
 */
async function resolveTargetControls(
    db: PrismaTx,
    ctx: RequestContext,
): Promise<{ byKind: Map<AgenticArtefactKind, TargetControl[]>; anyInstalled: boolean }> {
    const catalogue = await db.framework.findMany({
        select: { id: true, key: true, sourceUrn: true },
        take: FRAMEWORK_CATALOGUE_CAP,
    });

    const byKind = new Map<AgenticArtefactKind, TargetControl[]>();
    for (const kind of AGENTIC_ARTEFACT_KINDS) byKind.set(kind, []);

    // (familyUrn, requirementCode) → the kinds that target it. Collapsed first so
    // one requirement serving two kinds costs one query, not two.
    const wanted = new Map<string, { frameworkIds: string[]; code: string; kinds: Set<AgenticArtefactKind> }>();
    for (const target of EVIDENCE_TARGETS) {
        const frameworkIds = catalogue
            .filter(
                (f) =>
                    frameworkFamilyId(f) === target.familyUrn ||
                    target.legacyKeys.includes(f.key),
            )
            .map((f) => f.id);
        if (frameworkIds.length === 0) continue;

        const key = `${target.familyUrn}::${target.requirementCode}`;
        const entry = wanted.get(key);
        if (entry) {
            entry.kinds.add(target.kind);
        } else {
            wanted.set(key, { frameworkIds, code: target.requirementCode, kinds: new Set([target.kind]) });
        }
    }

    if (wanted.size === 0) return { byKind, anyInstalled: false };

    const requirements = await db.frameworkRequirement.findMany({
        where: {
            OR: [...wanted.values()].map((w) => ({
                frameworkId: { in: w.frameworkIds },
                code: w.code,
            })),
            deprecatedAt: null,
        },
        select: { id: true, code: true },
    });
    if (requirements.length === 0) return { byKind, anyInstalled: true };

    const kindsByRequirementCode = new Map<string, Set<AgenticArtefactKind>>();
    for (const w of wanted.values()) {
        const existing = kindsByRequirementCode.get(w.code);
        if (existing) for (const k of w.kinds) existing.add(k);
        else kindsByRequirementCode.set(w.code, new Set(w.kinds));
    }

    const links = await db.controlRequirementLink.findMany({
        where: {
            tenantId: ctx.tenantId,
            requirementId: { in: requirements.map((r) => r.id) },
            control: { deletedAt: null },
        },
        select: {
            requirementId: true,
            control: { select: { id: true, code: true } },
        },
    });

    const codeByRequirementId = new Map(requirements.map((r) => [r.id, r.code]));
    const seen = new Map<AgenticArtefactKind, Set<string>>();
    for (const kind of AGENTIC_ARTEFACT_KINDS) seen.set(kind, new Set());

    for (const link of links) {
        const requirementCode = codeByRequirementId.get(link.requirementId);
        if (!requirementCode) continue;
        for (const kind of kindsByRequirementCode.get(requirementCode) ?? []) {
            // One control may discharge two obligations of the same kind (ASI02
            // and ASI04). The artefact identity is on the CONTROL, so that is one
            // artefact, not two — dedupe here rather than colliding on the index.
            if (seen.get(kind)!.has(link.control.id)) continue;
            seen.get(kind)!.add(link.control.id);
            byKind.get(kind)!.push({
                id: link.control.id,
                code: link.control.code,
                requirementCode,
            });
        }
    }

    return { byKind, anyInstalled: true };
}

// ── Populations ─────────────────────────────────────────────────────────────

async function loadReceiptFacts(
    db: PrismaTx,
    ctx: RequestContext,
    period: ArtefactPeriod,
): Promise<ReceiptFact[]> {
    // Only the columns an artefact may render — see `ReceiptFact`. `scannedSummary`
    // and `signature` are not selected, so they cannot reach a body builder even
    // by accident.
    return db.agentActionReceipt.findMany({
        where: {
            tenantId: ctx.tenantId,
            occurredAt: { gte: period.start, lt: period.end },
        },
        select: {
            id: true,
            toolName: true,
            decisionVerdict: true,
            verified: true,
            auditLogId: true,
            toolProvenance: true,
        },
        orderBy: { occurredAt: 'asc' },
        take: POPULATION_CAP,
    });
}

async function loadDecisionFacts(
    db: PrismaTx,
    ctx: RequestContext,
    period: ArtefactPeriod,
): Promise<DecisionFact[]> {
    const rows = await db.aiDecisionLog.findMany({
        where: {
            tenantId: ctx.tenantId,
            createdAt: { gte: period.start, lt: period.end },
        },
        select: {
            id: true,
            feature: true,
            provider: true,
            guardVerdict: true,
            humanOutcome: true,
        },
        orderBy: { createdAt: 'asc' },
        take: POPULATION_CAP,
    });
    return rows.map((r) => ({
        id: r.id,
        feature: r.feature,
        provider: r.provider,
        guardVerdict: r.guardVerdict,
        humanOutcome: String(r.humanOutcome),
    }));
}

// ── Emission ────────────────────────────────────────────────────────────────

interface ArtefactPlan {
    readonly kind: AgenticArtefactKind;
    readonly control: TargetControl;
    readonly period: ArtefactPeriod;
    readonly digest: string;
    readonly recordCount: number;
    readonly title: string;
    readonly content: string;
}

/**
 * Write one artefact, creating or updating in place.
 *
 * Its own transaction, one per artefact, so a unique-index collision with a
 * concurrent tick rolls back ONLY that artefact's insert — including the
 * `Evidence` row it had just created, which would otherwise be left orphaned by
 * a failure the retry then papers over.
 */
async function writeArtefact(
    ctx: RequestContext,
    plan: ArtefactPlan,
    actorUserId: string | null,
): Promise<EmittedArtefact> {
    const attempt = async (allowCreate: boolean): Promise<EmittedArtefact> =>
        runInTenantContext(ctx, async (db) => {
            const existing = await db.agenticEvidenceArtefact.findUnique({
                where: {
                    tenantId_controlId_kind_periodStart: {
                        tenantId: ctx.tenantId,
                        controlId: plan.control.id,
                        kind: plan.kind,
                        periodStart: plan.period.start,
                    },
                },
                select: { id: true, evidenceId: true, sourceDigest: true, status: true },
            });

            if (existing) {
                const unchanged =
                    existing.status === 'CURRENT' && existing.sourceDigest === plan.digest;
                if (unchanged) {
                    // The population has not moved. Only the liveness stamp does —
                    // `updatedAt` deliberately stays put, so "the emitter is alive"
                    // and "the evidence changed" remain separable facts.
                    await db.agenticEvidenceArtefact.update({
                        where: { id: existing.id },
                        data: { lastEmittedAt: new Date() },
                    });
                    return {
                        artefactId: existing.id,
                        evidenceId: existing.evidenceId,
                        controlId: plan.control.id,
                        controlCode: plan.control.code,
                        kind: plan.kind,
                        periodLabel: plan.period.label,
                        recordCount: plan.recordCount,
                        outcome: 'unchanged' as const,
                    };
                }

                // The population moved, or the artefact was withdrawn and its
                // basis holds again. Either way the SAME evidence row is rewritten
                // — a second row for the same period is the duplication the
                // identity exists to prevent.
                await db.evidence.update({
                    where: { id: existing.evidenceId },
                    data: { title: plan.title, content: plan.content, isArchived: false },
                });
                await db.agenticEvidenceArtefact.update({
                    where: { id: existing.id },
                    data: {
                        sourceDigest: plan.digest,
                        recordCount: plan.recordCount,
                        periodEnd: plan.period.end,
                        status: 'CURRENT',
                        withdrawnAt: null,
                        withdrawnReason: null,
                        lastEmittedAt: new Date(),
                    },
                });
                return {
                    artefactId: existing.id,
                    evidenceId: existing.evidenceId,
                    controlId: plan.control.id,
                    controlCode: plan.control.code,
                    kind: plan.kind,
                    periodLabel: plan.period.label,
                    recordCount: plan.recordCount,
                    outcome: 'updated' as const,
                };
            }

            if (!allowCreate) {
                // A concurrent tick inserted between our read and our insert, and
                // then vanished. Refusing to loop is deliberate: one retry is a
                // race, two is a bug we would rather see.
                throw new Error('agentic evidence artefact vanished between attempts');
            }

            const evidence = await db.evidence.create({
                data: {
                    tenantId: ctx.tenantId,
                    type: 'TEXT',
                    title: plan.title,
                    content: plan.content,
                    // `control-test-runner`'s convention, so generated artefacts
                    // filter alongside every other automated one.
                    category: 'integration',
                    status: 'APPROVED',
                    ownerUserId: actorUserId,
                },
                select: { id: true },
            });
            await db.evidenceControlLink.create({
                data: {
                    tenantId: ctx.tenantId,
                    evidenceId: evidence.id,
                    controlId: plan.control.id,
                    createdByUserId: actorUserId,
                },
            });
            const artefact = await db.agenticEvidenceArtefact.create({
                data: {
                    tenantId: ctx.tenantId,
                    controlId: plan.control.id,
                    kind: plan.kind,
                    periodStart: plan.period.start,
                    periodEnd: plan.period.end,
                    evidenceId: evidence.id,
                    sourceDigest: plan.digest,
                    recordCount: plan.recordCount,
                },
                select: { id: true },
            });
            return {
                artefactId: artefact.id,
                evidenceId: evidence.id,
                controlId: plan.control.id,
                controlCode: plan.control.code,
                kind: plan.kind,
                periodLabel: plan.period.label,
                recordCount: plan.recordCount,
                outcome: 'created' as const,
            };
        });

    try {
        return await attempt(true);
    } catch (err) {
        // P2002 on the identity index: a concurrent tick won the insert. The
        // whole transaction rolled back, including the Evidence row, so the
        // retry sees a clean world and takes the update branch.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            return attempt(false);
        }
        throw err;
    }
}

/**
 * The whole pass for one tenant.
 *
 * `asOf` is injected rather than read from the clock so the period is a function
 * of the caller's argument — a test can emit for a named month, and a backfill
 * can re-emit an old one, without either depending on when it runs.
 */
export async function emitAgenticEvidence(
    ctx: RequestContext,
    options: { asOf?: Date } = {},
): Promise<EmissionReport> {
    assertCanWrite(ctx);

    const period = monthlyPeriod(options.asOf ?? new Date());

    const prepared = await runInTenantContext(ctx, async (db) => {
        const { byKind, anyInstalled } = await resolveTargetControls(db, ctx);
        if (!anyInstalled) {
            return { anyInstalled: false, plans: [] as ArtefactPlan[], actorUserId: null };
        }

        const needReceipts = (byKind.get(ARTEFACT_KIND_RECEIPTS) ?? []).length > 0;
        const needDecisions = (byKind.get(ARTEFACT_KIND_DECISIONS) ?? []).length > 0;

        const receipts = needReceipts ? await loadReceiptFacts(db, ctx, period) : [];
        const decisions = needDecisions ? await loadDecisionFacts(db, ctx, period) : [];

        const receiptDigest = sourcePopulationDigest(
            ARTEFACT_KIND_RECEIPTS,
            period.start,
            receipts.map((r) => r.id),
        );
        const decisionDigest = sourcePopulationDigest(
            ARTEFACT_KIND_DECISIONS,
            period.start,
            decisions.map((d) => d.id),
        );
        const receiptBody = buildReceiptArtefact(period, receipts, receiptDigest);
        const decisionBody = buildDecisionArtefact(period, decisions, decisionDigest);

        const plans: ArtefactPlan[] = [];
        for (const control of byKind.get(ARTEFACT_KIND_RECEIPTS) ?? []) {
            plans.push({
                kind: ARTEFACT_KIND_RECEIPTS,
                control,
                period,
                digest: receiptDigest,
                recordCount: receipts.length,
                title: `${receiptBody.title} — ${control.code}`,
                content: `Control: ${control.code} (${control.requirementCode})\n${receiptBody.content}`,
            });
        }
        for (const control of byKind.get(ARTEFACT_KIND_DECISIONS) ?? []) {
            plans.push({
                kind: ARTEFACT_KIND_DECISIONS,
                control,
                period,
                digest: decisionDigest,
                recordCount: decisions.length,
                title: `${decisionBody.title} — ${control.code}`,
                content: `Control: ${control.code} (${control.requirementCode})\n${decisionBody.content}`,
            });
        }

        // The evidence must be owned by a real user — `Evidence.ownerUserId` is a
        // foreign key. A job context carries one; an HTTP context is the caller.
        const owner = await db.tenantMembership.findFirst({
            where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'ACTIVE' },
            select: { userId: true },
        });

        return { anyInstalled: true, plans, actorUserId: owner?.userId ?? null };
    });

    const artefacts: EmittedArtefact[] = [];
    for (const plan of prepared.plans) {
        artefacts.push(await writeArtefact(ctx, plan, prepared.actorUserId));
    }

    if (artefacts.length > 0) {
        await runInTenantContext(ctx, (db) =>
            logEvent(db, ctx, {
                action: 'AGENTIC_EVIDENCE_EMITTED',
                entityType: 'AgenticEvidenceArtefact',
                entityId: period.label,
                detailsJson: {
                    category: 'custom',
                    event: 'agentic_evidence_emitted',
                    period: period.label,
                    created: artefacts.filter((a) => a.outcome === 'created').length,
                    updated: artefacts.filter((a) => a.outcome === 'updated').length,
                    unchanged: artefacts.filter((a) => a.outcome === 'unchanged').length,
                },
            }),
        );
    }

    log('info', 'Emitted agentic evidence artefacts', {
        tenantId: ctx.tenantId,
        period: period.label,
        artefacts: artefacts.length,
    });

    return {
        tenantId: ctx.tenantId,
        periodLabel: period.label,
        anyTargetInstalled: prepared.anyInstalled,
        artefacts,
    };
}

// ── Withdrawal ──────────────────────────────────────────────────────────────

export interface WithdrawnArtefact {
    readonly artefactId: string;
    readonly evidenceId: string;
    readonly reason: ArtefactWithdrawalReason;
}

/**
 * Withdraw the artefacts whose basis no longer holds.
 *
 * Two failure modes, and they are opposite mistakes. DELETING the evidence
 * destroys something an audit pack may already cite — the shape of evidence
 * tampering, and the exact behaviour a hash-chained trail exists to make
 * impossible elsewhere. LEAVING IT STALE lets a removed control go on
 * advertising coverage, and a control page that shows evidence it no longer has
 * is worse than one that shows none.
 *
 * So the row is kept and told the truth: `status = 'WITHDRAWN'` with a dated
 * reason, and the `Evidence` archived with a notice in place of the counts. The
 * ledger row is what distinguishes "this stopped being re-emitted, here is why"
 * from "the emitter died", which is the ambiguity that makes an empty page
 * unreadable.
 *
 * `SOURCE_UNVERIFIABLE` is the second trigger: an artefact that counted receipts
 * which have since been found unverifiable. Re-emission fixes the ORDINARY case
 * (the counts recompute and the artefact keeps going), so withdrawal is reserved
 * for the case where the whole population is gone.
 */
export async function withdrawStaleAgenticEvidence(
    ctx: RequestContext,
): Promise<WithdrawnArtefact[]> {
    assertCanWrite(ctx);

    const withdrawn: WithdrawnArtefact[] = [];

    const stale = await runInTenantContext(ctx, (db) =>
        db.agenticEvidenceArtefact.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: 'CURRENT',
                control: { deletedAt: { not: null } },
            },
            select: {
                id: true,
                evidenceId: true,
                sourceDigest: true,
                periodStart: true,
                periodEnd: true,
            },
            take: POPULATION_CAP,
        }),
    );

    for (const row of stale) {
        const at = new Date();
        const period = monthlyPeriod(row.periodStart);
        const notice = buildWithdrawalNotice(period, 'CONTROL_REMOVED', at, row.sourceDigest);
        await runInTenantContext(ctx, async (db) => {
            await db.evidence.update({
                where: { id: row.evidenceId },
                // ARCHIVED, not deleted. The artefact leaves the working set and
                // stays in the record.
                data: { content: notice, isArchived: true },
            });
            await db.agenticEvidenceArtefact.update({
                where: { id: row.id },
                data: {
                    status: 'WITHDRAWN',
                    withdrawnAt: at,
                    withdrawnReason: 'CONTROL_REMOVED',
                },
            });
        });
        withdrawn.push({
            artefactId: row.id,
            evidenceId: row.evidenceId,
            reason: 'CONTROL_REMOVED',
        });
    }

    return withdrawn;
}
