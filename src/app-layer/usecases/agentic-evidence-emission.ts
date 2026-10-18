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
 * `scannedSummary`, no `signature`, no `inputDigest`, no `outputSummary`, and
 * for a harness scan no owner reference, user id, justification, evidence
 * pointer, credential reference, tool server address or agent name. See that
 * module's header for why `Evidence.content` is the wrong place for any of
 * them.
 *
 * ── HARNESS SCANS (#3687): THE ONE KIND WHOSE STATUS IS A CLAIM ────────────
 *
 * Receipts and decision records are emitted `APPROVED` and the emitter never
 * touches their status again: a count of records that exist is true whatever
 * the count is. A month of harness scans is different — its population can be
 * incomplete, and an empty one evidences nothing — so its Evidence status is
 * planned from the artefact's completeness (`harnessArtefactEvidenceStatus`),
 * written on create, and afterwards corrected in ONE direction
 * (`harnessStatusCorrection`): a month whose plan is NEEDS_REVIEW is put back
 * whenever it is found APPROVED, by hand or otherwise, and a NEEDS_REVIEW is
 * raised only when it was the emitter's own verdict. A review decision —
 * SUBMITTED, REJECTED, or a NEEDS_REVIEW the stale-review sweep set on a month
 * that was already complete — stands. Every status the emitter changes writes a
 * `STATUS_CHANGE` audit row. That is what holds "an incomplete scan is never
 * emitted as complete evidence" after the first write, not only at it, without
 * the emitter becoming a second reviewer.
 *
 * A month is also not closed when its last tick runs. The scheduled pass
 * re-emits the PREVIOUS month every day and any older month a scan was
 * ingested into since its artefact was last emitted
 * (`reconcileClosedHarnessPeriods`), then puts back every closed month whose
 * plan is NEEDS_REVIEW and whose Evidence reads APPROVED. Without that, the
 * scan a daily scanner sends after the month's final 06:30 tick — and every
 * report backfilled into a closed month — would never reach the artefact,
 * which would go on calling a month complete whose latest scan was not.
 *
 * The kind is emitted only for a tenant that has registered a scanner key at
 * least once. Before that there is no capability to evidence, and every ASI
 * tenant would collect a monthly "no scan received" artefact for a scanner it
 * cannot run; after it, a month with no scan IS the finding — and so, per
 * scanner, is a scanner that held a trusted key in the month and sent nothing.
 */
import { Prisma } from '@prisma/client';
import { internal } from '@/lib/errors/types';

import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { log } from '@/lib/observability';
import { assertCanWrite } from '@/app-layer/policies/common';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '@/app-layer/events/audit';
import {
    AGENTIC_ARTEFACT_KINDS,
    ARTEFACT_KIND_DECISIONS,
    ARTEFACT_KIND_HARNESS_SCANS,
    ARTEFACT_KIND_RECEIPTS,
    EVIDENCE_TARGETS,
    HARNESS_SCANNER_CAP,
    buildDecisionArtefact,
    buildHarnessScanArtefact,
    buildReceiptArtefact,
    buildWithdrawalNotice,
    harnessArtefactEvidenceStatus,
    harnessDigestFacts,
    harnessStatusCorrection,
    monthlyPeriod,
    sourcePopulationDigest,
    type AgenticArtefactKind,
    type ArtefactPeriod,
    type ArtefactWithdrawalReason,
    type DecisionFact,
    type HarnessPeriodFacts,
    type HarnessPlannedStatus,
    type HarnessScanFact,
    type HarnessTallies,
    type ReceiptFact,
} from '@/lib/agentic/evidence-artefact';
import { parseStoredHarnessSources } from '@/lib/agentic/harness-contract';
import { isHarnessShortfall } from '@/lib/agentic/harness-findings';
import { HARNESS_LEVELS, type HarnessLevel } from '@/lib/agentic/harness-ladder';
import { harnessScanCompleteness, type HarnessStoredReach } from '@/lib/agentic/harness-read-model';
import { frameworkFamilyId } from '@/app-layer/domain/framework-representation';
import type { RequestContext } from '@/app-layer/types';

/** The framework catalogue is a small global table; loaded whole, grouped in memory. */
const FRAMEWORK_CATALOGUE_CAP = 500;
/** Bound on the records one artefact may count. */
const POPULATION_CAP = 20_000;
/** Bound on the harness scans one month's artefact reads; one past it is read to know. */
const HARNESS_SCAN_CAP = 200;
/** Bound on the scanners holding a trusted key one month's artefact reads. A tenant trusts a handful. */
const HARNESS_KEY_HOLDER_CAP = 200;
/** Closed months one tick may re-emit. The previous month is always one of them. */
const CLOSED_PERIOD_CAP = 12;
/** Closed-month artefacts, and late scans into them, one tick reads. */
const CLOSED_ARTEFACT_CAP = 500;
const LATE_SCAN_CAP = 1_000;
/** Approved-but-incomplete harness artefacts one tick puts back. */
const UNSAFE_APPROVAL_CAP = 500;

// ── Result shape ────────────────────────────────────────────────────────────

export type EmissionOutcome = 'created' | 'updated' | 'unchanged' | 'withdrawn';

export interface EmittedArtefact {
    readonly artefactId: string;
    readonly evidenceId: string;
    readonly controlId: string;
    /** Nullable for the same reason `TargetControl.code` is — see there. */
    readonly controlCode: string | null;
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
    /**
     * `Control.code` is OPTIONAL in the schema, so this is nullable and stays
     * nullable — `null` rather than `''`. "This control has no code" and "its
     * code is the empty string" are different facts, and an artefact that
     * renders a blank where an identifier belongs is the kind of quiet
     * wrongness an assessor cannot challenge. The same distinction the ASI
     * coverage work drew for `CoveringControl.code`.
     */
    readonly code: string | null;
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


/**
 * The longest a single externally-supplied label may be in an artefact body.
 *
 * `tally()` bounds the number of DISTINCT values it will render; it does not
 * bound their LENGTH, so one 5 KB tool name inflates the body by 5 KB and forty
 * of them by 200 KB. An `Evidence.content` row is PDF-exported and reachable
 * through an audit-pack share link, so its size is somebody else's problem too.
 */
const LABEL_MAX = 120;

/**
 * Make one externally-supplied label safe to put in an artefact body.
 *
 * These strings are NOT ours. `extractReceiptFields` lifts `toolName` and
 * `decisionVerdict` out of an arbitrary `action_record` supplied by whoever
 * signed the receipt, and the artefact deliberately counts UNVERIFIED receipts —
 * so the Ed25519 signature does not stand in front of this field. A tenant API
 * key with write, or a hostile mediator, chooses these bytes.
 *
 * `Evidence.content` is the widest surface in the product: not in the
 * field-encryption manifest, PDF-exported, reachable through an audit-pack share
 * link, and read by SDK consumers verbatim. CLAUDE.md C.5 is explicit that a
 * write path accepting free text sanitises at the USECASE layer for exactly that
 * reason — render-time sanitisation alone leaves the row dangerous to every
 * other consumer.
 */
function safeLabel(value: string | null | undefined): string {
    const clean = sanitizePlainText(value ?? '').trim();
    if (clean.length === 0) return 'unknown';
    return clean.length > LABEL_MAX ? `${clean.slice(0, LABEL_MAX - 1)}…` : clean;
}

async function loadReceiptFacts(
    db: PrismaTx,
    ctx: RequestContext,
    period: ArtefactPeriod,
): Promise<ReceiptFact[]> {
    // Only the columns an artefact may render — see `ReceiptFact`. `scannedSummary`
    // and `signature` are not selected, so they cannot reach a body builder even
    // by accident.
    const rows = await db.agentActionReceipt.findMany({
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
    // Sanitised and bounded HERE, at the seam between a foreign string and an
    // artefact body — not at render time, which would leave the stored row
    // dangerous to the PDF export and the share link.
    return rows.map((r) => ({
        ...r,
        toolName: safeLabel(r.toolName),
        decisionVerdict: safeLabel(r.decisionVerdict),
    }));
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
        ...r,
        feature: safeLabel(r.feature),
        provider: safeLabel(r.provider),
        guardVerdict: r.guardVerdict === null ? null : safeLabel(r.guardVerdict),
    }));
}

type MutableTallies = {
    count: number;
    levels: Record<HarnessLevel, number>;
    reach: Record<HarnessStoredReach, number>;
    belowBar: number;
    notInRegister: number;
};

function emptyTallies(): MutableTallies {
    const levels = {} as Record<HarnessLevel, number>;
    for (const l of HARNESS_LEVELS) levels[l] = 0;
    return { count: 0, levels, reach: { READ_ONLY: 0, WRITE_OR_EXTERNAL: 0, UNKNOWN: 0 }, belowBar: 0, notInRegister: 0 };
}

/**
 * The month's verified harness scans, as the facts an artefact may render.
 *
 * Read from the tables directly, under the emitter's own tenant transaction,
 * rather than through `listHarnessScans`, which carries the register-read gate
 * of a human surface; the emitter's caller is the job. Only the columns
 * `HarnessScanFact` renders are selected — no `signature`, no `verdictsJson`,
 * no `toolsJson`, no `ownerRef` — so they cannot reach a builder by accident.
 *
 * "Latest" is by `asOf`, the moment a report describes, with the ingest's
 * tiebreak (`createdAt`, then `id`), the same order the harness matrix uses: a
 * backfilled older report does not pose as the month's current reading.
 */
async function loadHarnessFacts(
    db: PrismaTx,
    ctx: RequestContext,
    period: ArtefactPeriod,
): Promise<HarnessPeriodFacts> {
    const rows = await db.agentHarnessScan.findMany({
        where: { tenantId: ctx.tenantId, asOf: { gte: period.start, lt: period.end } },
        select: {
            id: true,
            scanRef: true,
            scannerAgentId: true,
            scannerVersion: true,
            asOf: true,
            reportDigest: true,
            complete: true,
            agentCount: true,
            sourcesJson: true,
        },
        orderBy: [{ asOf: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: HARNESS_SCAN_CAP + 1,
    });
    const scansTruncated = rows.length > HARNESS_SCAN_CAP;
    const scans = rows.slice(0, HARNESS_SCAN_CAP);

    // Each scanner's latest scan is its first occurrence in that order.
    const latestByScanner = new Map<string, string>();
    for (const s of scans) {
        if (!latestByScanner.has(s.scannerAgentId)) latestByScanner.set(s.scannerAgentId, s.id);
    }
    const latestIds = [...latestByScanner.values()];
    const talliedIds = latestIds.slice(0, HARNESS_SCANNER_CAP);
    const scannersTruncated = latestIds.length > HARNESS_SCANNER_CAP;

    // One read for every tallied scan's agents — never one per scan.
    const items = talliedIds.length === 0
        ? []
        : await db.agentHarnessScanItem.findMany({
              where: { tenantId: ctx.tenantId, scanId: { in: talliedIds } },
              select: {
                  scanId: true,
                  level: true,
                  reach: true,
                  discoveredAgent: {
                      select: { registeredAgentId: true, registeredAgent: { select: { deletedAt: true } } },
                  },
              },
              take: POPULATION_CAP + 1,
          });
    const tallyTruncated = items.length > POPULATION_CAP;

    const tallies = new Map<string, MutableTallies>(talliedIds.map((id) => [id, emptyTallies()]));
    if (!tallyTruncated) {
        for (const item of items) {
            const t = tallies.get(item.scanId);
            if (!t) continue;
            t.count += 1;
            t.levels[item.level] += 1;
            t.reach[item.reach] += 1;
            // Reported, never gating: the ladder is report-only.
            if (isHarnessShortfall(item.level, item.reach)) t.belowBar += 1;
            // A register row deleted after the scan linked it leaves a stale
            // link (the FK is NO ACTION), so it counts as not in the register.
            const registered = item.discoveredAgent.registeredAgentId !== null
                && item.discoveredAgent.registeredAgent !== null
                && item.discoveredAgent.registeredAgent.deletedAt === null;
            if (!registered) t.notInRegister += 1;
        }
    }

    const facts: HarnessScanFact[] = scans.map((s) => {
        const sources = parseStoredHarnessSources(s.sourcesJson);
        const t = tallies.get(s.id);
        // A tally is stated only when every stored agent of the scan was read
        // and they agree with the scan's own count. Otherwise it is withheld,
        // which makes the artefact INCOMPLETE rather than a number nobody read.
        const stated: HarnessTallies | null =
            !tallyTruncated && t !== undefined && t.count === s.agentCount
                ? { levels: t.levels, reach: t.reach, belowBar: t.belowBar, notInRegister: t.notInRegister }
                : null;
        return {
            id: s.id,
            scanRef: safeLabel(s.scanRef),
            scannerAgentId: s.scannerAgentId,
            scannerVersion: safeLabel(s.scannerVersion),
            asOf: s.asOf.toISOString(),
            reportDigest: s.reportDigest,
            latestForScanner: latestByScanner.get(s.scannerAgentId) === s.id,
            // The ONE expression for "complete" — the harness matrix renders
            // the same one, so the tab and the evidence cannot disagree.
            completeness: harnessScanCompleteness({
                complete: s.complete,
                agentCount: s.agentCount,
                sourcesReadable: sources !== null,
            }),
            sources:
                sources === null
                    ? null
                    : sources.map((src) => ({ kind: src.kind, status: src.status, rows: src.rows, reason: src.reason })),
            agentCount: s.agentCount,
            tallies: stated,
        };
    });

    // The scanners that held a TRUSTED key at some moment of the period —
    // registered before it ended, not revoked before it began — and reported
    // nothing in it. Compared by scanner, not by key: a scanner that rotated
    // its key mid-month reported through the new one, and its old key's
    // silence is not the scanner's.
    const holders = await db.agentHarnessScannerKey.findMany({
        where: {
            tenantId: ctx.tenantId,
            createdAt: { lt: period.end },
            OR: [{ revokedAt: null }, { revokedAt: { gt: period.start } }],
        },
        select: { agentId: true },
        distinct: ['agentId'],
        orderBy: { agentId: 'asc' },
        take: HARNESS_KEY_HOLDER_CAP + 1,
    });
    const holderIds = holders.slice(0, HARNESS_KEY_HOLDER_CAP).map((h) => h.agentId);
    // Read separately from the capped scan list above, so a scanner whose only
    // scans fell past that cap is not mistaken for a silent one.
    const reporting = holderIds.length === 0
        ? []
        : await db.agentHarnessScan.findMany({
              where: {
                  tenantId: ctx.tenantId,
                  asOf: { gte: period.start, lt: period.end },
                  scannerAgentId: { in: holderIds },
              },
              select: { scannerAgentId: true },
              distinct: ['scannerAgentId'],
              take: holderIds.length,
          });
    const reported = new Set(reporting.map((r) => r.scannerAgentId));

    return {
        scans: facts,
        bounds: { bounds: true, scansTruncated, tallyTruncated, scannersTruncated },
        silent: {
            silentScanners: true,
            agentIds: holderIds.filter((id) => !reported.has(id)).sort(),
            truncated: holders.length > HARNESS_KEY_HOLDER_CAP,
        },
    };
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
    /**
     * The Evidence status the artefact's completeness calls for, or `null`
     * when the emitter judges none. `null` for receipts and decision records:
     * they are created `APPROVED` and their status is left to the review flow
     * afterwards, as it always was. A harness artefact's status IS its
     * completeness claim: written on create, and afterwards corrected by
     * `harnessStatusCorrection` — see the module header.
     */
    readonly evidenceStatus: HarnessPlannedStatus | null;
}

/** A stored planned status, narrowed to the two the emitter writes; anything else reads as none. */
function asPlannedStatus(value: string | null): HarnessPlannedStatus | null {
    return value === 'APPROVED' || value === 'NEEDS_REVIEW' ? value : null;
}

/**
 * One audit row per Evidence status the emitter changes — the same
 * `STATUS_CHANGE` shape the review flow writes, so "who moved this row's
 * status, and why" has one answer on the trail whichever side moved it.
 */
async function logEmitterStatusChange(
    db: PrismaTx,
    ctx: RequestContext,
    change: { evidenceId: string; from: string; to: HarnessPlannedStatus; period: ArtefactPeriod },
): Promise<void> {
    const reason =
        change.to === 'NEEDS_REVIEW'
            ? `The agent harness scans of ${change.period.label} are not complete evidence; an incomplete month does not stand as APPROVED`
            : `The agent harness scans of ${change.period.label} are now complete evidence`;
    await logEvent(db, ctx, {
        action: 'STATUS_CHANGE',
        entityType: 'Evidence',
        entityId: change.evidenceId,
        details: `Agentic evidence emitter: ${change.from} -> ${change.to}`,
        detailsJson: {
            category: 'status_change',
            entityName: 'Evidence',
            fromStatus: change.from,
            toStatus: change.to,
            reason,
        },
    });
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
                select: {
                    id: true,
                    evidenceId: true,
                    sourceDigest: true,
                    status: true,
                    plannedEvidenceStatus: true,
                    // Through the relation, not a second Evidence read: the
                    // status is the artefact's own row's, in the same query.
                    evidence: { select: { status: true } },
                },
            });

            if (existing) {
                // ONE-DIRECTIONAL: an incomplete month found APPROVED is put
                // back; a NEEDS_REVIEW is raised only when it was the emitter's
                // own verdict; a review decision otherwise stands.
                const previousPlanned = asPlannedStatus(existing.plannedEvidenceStatus);
                const correction = plan.evidenceStatus === null
                    ? null
                    : harnessStatusCorrection({
                          planned: plan.evidenceStatus,
                          current: existing.evidence.status,
                          previousPlanned,
                      });
                const planMoved = plan.evidenceStatus !== previousPlanned;
                const unchanged =
                    existing.status === 'CURRENT' &&
                    existing.sourceDigest === plan.digest &&
                    correction === null &&
                    !planMoved;
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
                    data: {
                        title: plan.title,
                        content: plan.content,
                        isArchived: false,
                        ...(correction !== null ? { status: correction } : {}),
                    },
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
                        plannedEvidenceStatus: plan.evidenceStatus,
                    },
                });
                if (correction !== null) {
                    await logEmitterStatusChange(db, ctx, {
                        evidenceId: existing.evidenceId,
                        from: existing.evidence.status,
                        to: correction,
                        period: plan.period,
                    });
                }
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
                throw internal('agentic evidence artefact vanished between attempts');
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
                    status: plan.evidenceStatus ?? 'APPROVED',
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
                    plannedEvidenceStatus: plan.evidenceStatus,
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
    options: { asOf?: Date; kinds?: readonly AgenticArtefactKind[] } = {},
): Promise<EmissionReport> {
    assertCanWrite(ctx);

    const period = monthlyPeriod(options.asOf ?? new Date());
    // Every kind unless the caller narrows it: re-asserting a closed month is
    // a harness concern only, and recounting its receipts is not.
    const wants = (kind: AgenticArtefactKind) => !options.kinds || options.kinds.includes(kind);

    const prepared = await runInTenantContext(ctx, async (db) => {
        const { byKind, anyInstalled } = await resolveTargetControls(db, ctx);
        if (!anyInstalled) {
            return { anyInstalled: false, plans: [] as ArtefactPlan[], actorUserId: null };
        }

        const receiptTargets = wants(ARTEFACT_KIND_RECEIPTS) ? byKind.get(ARTEFACT_KIND_RECEIPTS) ?? [] : [];
        const decisionTargets = wants(ARTEFACT_KIND_DECISIONS) ? byKind.get(ARTEFACT_KIND_DECISIONS) ?? [] : [];
        const harnessTargets = wants(ARTEFACT_KIND_HARNESS_SCANS) ? byKind.get(ARTEFACT_KIND_HARNESS_SCANS) ?? [] : [];
        const needReceipts = receiptTargets.length > 0;
        const needDecisions = decisionTargets.length > 0;
        // Opted in once a scanner key has EVER been registered — revoked keys
        // count, because a tenant that stopped scanning is exactly the tenant
        // whose empty months must be reported, and key rows are never deleted.
        const needHarness =
            harnessTargets.length > 0 &&
            (await db.agentHarnessScannerKey.count({ where: { tenantId: ctx.tenantId } })) > 0;

        const receipts = needReceipts ? await loadReceiptFacts(db, ctx, period) : [];
        const decisions = needDecisions ? await loadDecisionFacts(db, ctx, period) : [];

        const receiptDigest = sourcePopulationDigest(
            ARTEFACT_KIND_RECEIPTS,
            period.start,
            receipts,
        );
        const decisionDigest = sourcePopulationDigest(
            ARTEFACT_KIND_DECISIONS,
            period.start,
            decisions,
        );
        const receiptBody = buildReceiptArtefact(period, receipts, receiptDigest);
        const decisionBody = buildDecisionArtefact(period, decisions, decisionDigest);

        const plans: ArtefactPlan[] = [];
        for (const control of receiptTargets) {
            plans.push({
                kind: ARTEFACT_KIND_RECEIPTS,
                control,
                period,
                digest: receiptDigest,
                recordCount: receipts.length,
                title: `${receiptBody.title} — ${control.code}`,
                content: `Control: ${control.code} (${control.requirementCode})\n${receiptBody.content}`,
                evidenceStatus: null,
            });
        }
        for (const control of decisionTargets) {
            plans.push({
                kind: ARTEFACT_KIND_DECISIONS,
                control,
                period,
                digest: decisionDigest,
                recordCount: decisions.length,
                title: `${decisionBody.title} — ${control.code}`,
                content: `Control: ${control.code} (${control.requirementCode})\n${decisionBody.content}`,
                evidenceStatus: null,
            });
        }

        if (needHarness) {
            const harness = await loadHarnessFacts(db, ctx, period);
            // The bounds are digested with the scans, so a bound tripping (or
            // clearing) rewrites the body as surely as a new scan does.
            const harnessDigest = sourcePopulationDigest(
                ARTEFACT_KIND_HARNESS_SCANS,
                period.start,
                harnessDigestFacts(harness),
            );
            const harnessBody = buildHarnessScanArtefact(period, harness, harnessDigest);
            for (const control of harnessTargets) {
                plans.push({
                    kind: ARTEFACT_KIND_HARNESS_SCANS,
                    control,
                    period,
                    digest: harnessDigest,
                    recordCount: harness.scans.length,
                    title: `${harnessBody.title} — ${control.code}`,
                    content: `Control: ${control.code} (${control.requirementCode})\n${harnessBody.content}`,
                    evidenceStatus: harnessArtefactEvidenceStatus(harnessBody.completeness),
                });
            }
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

// ── Closed harness months ───────────────────────────────────────────────────

export interface ClosedHarnessReconciliation {
    /** The closed months re-emitted, newest first. */
    readonly periodLabels: readonly string[];
    readonly artefacts: readonly EmittedArtefact[];
    /** Evidence ids put back to NEEDS_REVIEW by the closed-month sweep. */
    readonly demotedEvidenceIds: readonly string[];
}

/**
 * Re-assert the harness months the daily tick has moved past.
 *
 * `emitAgenticEvidence` without `asOf` evidences the CURRENT month, so a month
 * is last recomputed by its final 06:30 tick. Two things arrive after that and
 * would otherwise never reach its artefact:
 *
 *   1. the scan a daily scanner sends later on the month's last day, which is
 *      the month's true latest — re-emitting the PREVIOUS month every tick
 *      catches it, along with any report backfilled into it;
 *   2. a report backfilled into an OLDER month — re-emitted when a scan with
 *      `asOf` in that month was ingested after its artefact was last emitted.
 *      Only months that already carry a harness artefact: a month that never
 *      had evidence claims nothing a late scan could make false.
 *
 * Then every harness artefact whose plan is NEEDS_REVIEW and whose Evidence
 * reads APPROVED is put back, whatever its month — a reviewer approving an
 * incomplete October in December is the same unsafe approval as in October.
 *
 * `now` is injected so the months are a function of the caller's argument.
 */
export async function reconcileClosedHarnessPeriods(
    ctx: RequestContext,
    options: { now?: Date } = {},
): Promise<ClosedHarnessReconciliation> {
    assertCanWrite(ctx);
    const now = options.now ?? new Date();
    const current = monthlyPeriod(now);
    const previous = monthlyPeriod(new Date(current.start.getTime() - 1));

    const older = await runInTenantContext(ctx, async (db) => {
        const closed = await db.agenticEvidenceArtefact.findMany({
            where: {
                tenantId: ctx.tenantId,
                kind: ARTEFACT_KIND_HARNESS_SCANS,
                status: 'CURRENT',
                periodStart: { lt: previous.start },
            },
            select: { periodStart: true, lastEmittedAt: true },
            orderBy: { periodStart: 'desc' },
            take: CLOSED_ARTEFACT_CAP,
        });
        if (closed.length === 0) return [];
        // A month's artefacts (one per control) were last emitted together; the
        // earliest stamp is the one a late scan must beat.
        const emittedAt = new Map<number, number>();
        for (const a of closed) {
            const key = a.periodStart.getTime();
            const at = a.lastEmittedAt.getTime();
            emittedAt.set(key, Math.min(emittedAt.get(key) ?? at, at));
        }
        const earliestStart = Math.min(...emittedAt.keys());
        const earliestEmit = Math.min(...emittedAt.values());
        const late = await db.agentHarnessScan.findMany({
            where: {
                tenantId: ctx.tenantId,
                asOf: { gte: new Date(earliestStart), lt: previous.start },
                createdAt: { gt: new Date(earliestEmit) },
            },
            select: { asOf: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: LATE_SCAN_CAP,
        });
        const months = new Set<number>();
        for (const scan of late) {
            const key = monthlyPeriod(scan.asOf).start.getTime();
            const at = emittedAt.get(key);
            if (at !== undefined && scan.createdAt.getTime() > at) months.add(key);
        }
        return [...months];
    });

    const starts = [...new Set([previous.start.getTime(), ...older])].sort((a, b) => b - a);
    if (starts.length > CLOSED_PERIOD_CAP) {
        // Loud, and not lost: the months left out keep their late scans, so the
        // next tick finds them again.
        log('warn', 'Agentic evidence: more closed harness months to re-emit than one tick takes', {
            tenantId: ctx.tenantId,
            months: starts.length,
            cap: CLOSED_PERIOD_CAP,
        });
    }

    const periodLabels: string[] = [];
    const artefacts: EmittedArtefact[] = [];
    for (const start of starts.slice(0, CLOSED_PERIOD_CAP)) {
        const report = await emitAgenticEvidence(ctx, { asOf: new Date(start), kinds: [ARTEFACT_KIND_HARNESS_SCANS] });
        periodLabels.push(report.periodLabel);
        artefacts.push(...report.artefacts);
    }

    const demotedEvidenceIds = await runInTenantContext(ctx, async (db) => {
        // The plan is the emitter's verdict as of each month's last emission,
        // which the loop above has just refreshed for the months it touched.
        const unsafe = await db.agenticEvidenceArtefact.findMany({
            where: {
                tenantId: ctx.tenantId,
                kind: ARTEFACT_KIND_HARNESS_SCANS,
                status: 'CURRENT',
                plannedEvidenceStatus: 'NEEDS_REVIEW',
                evidence: { status: 'APPROVED' },
            },
            select: { evidenceId: true, periodStart: true },
            orderBy: { periodStart: 'desc' },
            take: UNSAFE_APPROVAL_CAP,
        });
        const ids: string[] = [];
        for (const row of unsafe) {
            // Conditional, so a status a reviewer moved again since the read is
            // left alone rather than overwritten.
            const moved = await db.evidence.updateMany({
                where: { id: row.evidenceId, tenantId: ctx.tenantId, status: 'APPROVED' },
                data: { status: 'NEEDS_REVIEW' },
            });
            if (moved.count === 0) continue;
            await logEmitterStatusChange(db, ctx, {
                evidenceId: row.evidenceId,
                from: 'APPROVED',
                to: 'NEEDS_REVIEW',
                period: monthlyPeriod(row.periodStart),
            });
            ids.push(row.evidenceId);
        }
        return ids;
    });

    return { periodLabels, artefacts, demotedEvidenceIds };
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
 * ── WHY THE PREDICATE IS THE TARGET SET AND NOT `deletedAt` ────────────────
 *
 * This looked ONLY for `control: { deletedAt: { not: null } }`, and that is a
 * strictly narrower question than the one the doc-comment above asks. There are
 * two ways a control stops discharging an obligation and only one of them
 * touches the control:
 *
 *   • the control is soft-deleted           → `CONTROL_REMOVED`
 *   • the control is ALIVE, and its         → was invisible here
 *     `ControlRequirementLink` to ASI02
 *     (or the framework itself) is gone
 *
 * `resolveTargetControls` already stops emitting in the second case — it
 * resolves through the link — so the artefact simply stopped being recomputed,
 * with `status` left at `CURRENT`, the `Evidence` un-archived and still joined
 * to the control, and the counts still standing on the control's evidence tab.
 * That is exactly the "control goes on claiming coverage it no longer has"
 * failure the two paragraphs above say this function exists to prevent, and it
 * was reachable by deleting one join row.
 *
 * So the predicate is now the SAME resolution the emitter runs, inverted: a
 * CURRENT artefact whose `(controlId, kind)` is absent from the resolved target
 * set no longer has a basis. Three things about that are load-bearing:
 *
 *   1. `(controlId, kind)` — NOT `controlId`. One control can target one kind
 *      and not the other (a control mapped to ASI02 collects receipts; the same
 *      control unmapped from ASI09 must lose only its decision artefact). A
 *      controlId-only membership test would withdraw both or neither.
 *   2. `anyInstalled === false` withdraws NOTHING for this reason. That flag
 *      means no `Framework` row in the whole catalogue carries a target family
 *      urn — a statement about the deployment, not about the tenant, and it is
 *      indistinguishable from a catalogue the read did not see (the read is
 *      capped and unordered). Acting on it would archive every tenant's entire
 *      history on one pass of a job that runs unattended. `CONTROL_REMOVED`
 *      still applies, because a soft-delete is a per-row fact this pass
 *      observed directly.
 *   3. A `kind` this build does not know is skipped. "Absent from the target
 *      set" carries no information about a kind that has no `EVIDENCE_TARGETS`
 *      entry here, and the schema comment on `kind` says the vocabulary is one
 *      a follow-up widens — so during a rolling deploy an older container would
 *      otherwise withdraw everything a newer one had just emitted.
 *
 * The soft-delete check runs FIRST, so a control that is both deleted and
 * unmapped reports `CONTROL_REMOVED`: they are different facts and the notice
 * text says which happened.
 *
 * `SOURCE_UNVERIFIABLE` is the third trigger: an artefact that counted receipts
 * which have since been found unverifiable. Re-emission fixes the ORDINARY case
 * (the counts recompute and the artefact keeps going), so withdrawal is reserved
 * for the case where the whole population is gone.
 */
export async function withdrawStaleAgenticEvidence(
    ctx: RequestContext,
): Promise<WithdrawnArtefact[]> {
    assertCanWrite(ctx);

    const withdrawn: WithdrawnArtefact[] = [];

    const { candidates, targetKeys, anyInstalled } = await runInTenantContext(ctx, async (db) => {
        // The same resolution the emitter runs, in the same pass, so the two
        // cannot disagree about what a control currently discharges.
        const resolved = await resolveTargetControls(db, ctx);
        const keys = new Set<string>();
        for (const [kind, targets] of resolved.byKind) {
            for (const target of targets) keys.add(targetKey(target.id, kind));
        }

        const rows = await db.agenticEvidenceArtefact.findMany({
            where: { tenantId: ctx.tenantId, status: 'CURRENT' },
            select: {
                id: true,
                evidenceId: true,
                controlId: true,
                kind: true,
                sourceDigest: true,
                periodStart: true,
                periodEnd: true,
                // Read through the relation in the SAME query — the deleted
                // state is per-row, and a read per row in the loop below would
                // be an N+1 over a population capped at 20k.
                control: { select: { deletedAt: true } },
            },
            take: POPULATION_CAP,
        });

        return { candidates: rows, targetKeys: keys, anyInstalled: resolved.anyInstalled };
    });

    if (!anyInstalled && candidates.length > 0) {
        // Loud, because the artefacts are now frozen: nothing recomputes them
        // and nothing withdraws them either. That is the safe answer to an
        // ambiguous catalogue, but it is not a healthy steady state.
        log(
            'warn',
            'Agentic evidence withdrawal skipped the unmapped sweep — no target framework installed',
            { tenantId: ctx.tenantId, currentArtefacts: candidates.length },
        );
    }

    for (const row of candidates) {
        const reason = withdrawalReasonFor(row, targetKeys, anyInstalled);
        if (reason === null) continue;

        const at = new Date();
        const period = monthlyPeriod(row.periodStart);
        const notice = buildWithdrawalNotice(period, reason, at, row.sourceDigest);
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
                    withdrawnReason: reason,
                },
            });
        });
        withdrawn.push({
            artefactId: row.id,
            evidenceId: row.evidenceId,
            reason,
        });
    }

    return withdrawn;
}

/** Membership key for the resolved target set. `kind` is TEXT in the DB, so both sides are strings. */
function targetKey(controlId: string, kind: string): string {
    return `${controlId}::${kind}`;
}

/**
 * Why this artefact's basis no longer holds, or `null` to leave it CURRENT.
 *
 * Extracted so the ORDER of the two questions is one readable thing: a
 * soft-deleted control is `CONTROL_REMOVED` even though it is also, necessarily,
 * absent from the target set (`resolveTargetControls` filters `deletedAt: null`).
 * Reversing these two lines would report every removed control as
 * `OBLIGATION_UNMAPPED` and the notice would tell an assessor the wrong story.
 */
function withdrawalReasonFor(
    row: { controlId: string; kind: string; control: { deletedAt: Date | null } },
    targetKeys: ReadonlySet<string>,
    anyInstalled: boolean,
): ArtefactWithdrawalReason | null {
    if (row.control.deletedAt !== null) return 'CONTROL_REMOVED';
    if (!anyInstalled) return null;
    // A kind with no target declaration in THIS build cannot be judged absent —
    // see point 3 in the function docstring above.
    if (!AGENTIC_ARTEFACT_KINDS.some((k) => k === row.kind)) return null;
    return targetKeys.has(targetKey(row.controlId, row.kind)) ? null : 'OBLIGATION_UNMAPPED';
}
