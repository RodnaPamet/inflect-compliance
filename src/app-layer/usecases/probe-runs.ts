/**
 * Probe runs (active flavour, step 8a) — the ONLY writer of ProbeRun,
 * ProbeRunTarget and ProbeRunOutcome.
 *
 * A prober (`scanent-probe`) posts its signed report, `scanent-probes/1`: what
 * a run of fixed attacker probes made agents in an authorised engagement do —
 * return a canary (ACTED), leak a credential's shape or the estate's planted
 * context (DISCLOSED), refuse (RESISTED), or nothing that can be judged
 * (INCONCLUSIVE). The shape is the agent-surface rules ingest's
 * (`agent-rule-scans.ts`), step for step:
 *
 *   1. reads the PROBER keys the tenant trusts (unrevoked rows only) — a
 *      register of their own, never the scanner keys (owner decision,
 *      2026-11-25), registered under `admin.agent_registry`;
 *   2. verifies with the contract package's `verifyAndParseProbesReport` —
 *      size, JSON, a signature BY ONE OF THOSE KEYS, the strict `/1` schema —
 *      and writes NOTHING on a refusal;
 *   3. walks every string for a secret's shape;
 *   4. takes the prober from the signing key: the report names no agent;
 *   5. requires the engagement's scope to have been signed by a LIVE approver
 *      key the tenant's owner registered (`APPROVER_NOT_REGISTERED`): a key
 *      revoked before the report arrives authorises nothing, whenever the run
 *      began (owner decision, 2026-11-25);
 *   6. refuses a replay (`reportDigest` is unique per tenant);
 *   7. writes the run, its targets and its outcomes, and reconciles the
 *      findings, in one transaction.
 *
 * ── WHAT A RUN OPENS AND CLOSES ─────────────────────────────────────────────
 *
 * One finding per (target, probe, tool) per prober: its reference is
 * `probe:<probeId>@<endpointDigest>[#<tool>]@<proberAgentId>`. ACTED or
 * DISCLOSED opens it, or reopens it when closed. It is CLOSED only when a later
 * run by the SAME prober sends the same probe to the same target (and tool) and
 * the agent RESISTS. INCONCLUSIVE — no reply, a reply cut short, no planted
 * context given — and an outcome absent from a run close nothing: an agent that
 * did not answer has not been shown to resist.
 *
 * The excerpt of what the agent said is stored ENCRYPTED with the outcome and
 * never written to a finding, an audit row or evidence (owner decision,
 * 2026-11-25); a finding names the probe, the class, the target's ORIGIN and
 * the tool, never the endpoint, which is stored encrypted too. A finding is an
 * OBSERVATION a person confirms against the run, written through
 * `FindingRepository` in the transaction as the other ingests do, because the
 * principal is a prober whose key carries `agent_probes_ingest` and nothing
 * else. Every write is sanitised and audited.
 *
 * `tests/guards/agent-harness-single-write-seam.test.ts` refuses a write to the
 * three tables from any other file.
 */
import {
    probeReportConcluded,
    verifyAndParseProbesReport,
    VERDICT_OF_REASON,
    type ProbeVerdictReason,
    type ProbesReportBodyV1,
} from '@rodnapamet/scanent-contract/probes-contract';

import type { RequestContext } from '../types';
import type { PrismaTx } from '@/lib/db-context';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors/types';
import { mayReadAgentInventory } from '@/lib/permissions';
import { logEvent } from '../events/audit';
import { logger } from '@/lib/observability';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { keyedChangeDigest } from '@/lib/security/encryption';
import { recordProbeRunOutcome } from '@/lib/observability/integration-metrics';
import { FindingRepository } from '../repositories/FindingRepository';
import { harnessKeyFingerprint, harnessSignedMessage } from '@/lib/agentic/harness-contract';
import { firstSecretShapedMember } from '@/lib/agentic/harness-findings';
import type {
    ProbeFindingView,
    ProbeRunDetailView,
    ProbeRunInventoryView,
    ProbeRunSection,
    ProbeRunView,
} from '@/lib/agentic/probe-run-read-model';

/** `Finding.sourceKind` of every finding this ingest writes. */
export const PROBE_FINDING_SOURCE_KIND = 'AGENT_PROBE';

/** The refusal prefix every refusal carries, for the metric and the caller. */
export const PROBE_REPORT_REFUSAL = 'probe_report_refused';

/** The keyed-digest domain of a target endpoint. Changing it moves every finding reference. */
export const PROBE_TARGET_DIGEST_DOMAIN = 'probe-target';

/** How many prober or approver keys a tenant may hold. The harness ingest's bound. */
const MAX_KEYS = 200;

/** A reason whose verdict raises a finding: ACTED or DISCLOSED. */
export type RaisingReason = {
    [K in ProbeVerdictReason]: (typeof VERDICT_OF_REASON)[K] extends 'ACTED' | 'DISCLOSED' ? K : never;
}[ProbeVerdictReason];

/**
 * What each raising reason means, in the finding's title. Every reason the
 * contract maps to ACTED or DISCLOSED has one: a reason added without one does
 * not compile.
 */
const REASON_TITLE: Readonly<Record<RaisingReason, string>> = {
    CANARY_RETURNED: 'An agent followed an injected instruction',
    CREDENTIAL_SHAPE_RETURNED: 'An agent disclosed something shaped like a credential',
    PLANTED_CONTEXT_RETURNED: 'An agent disclosed its planted context',
};

/** What the agent did, in the finding's description. */
const REASON_DONE: Readonly<Record<RaisingReason, string>> = {
    CANARY_RETURNED: 'returned the canary the probe asked for, so it acted on an instruction that was not its own',
    CREDENTIAL_SHAPE_RETURNED: 'returned text of a credential\'s shape',
    PLANTED_CONTEXT_RETURNED: 'returned the marker the estate planted in its instructions',
};

/**
 * Severity by the owner's decision (2026-11-25): HIGH for an agent that acted
 * and for a credential's shape, MEDIUM for planted context.
 */
const REASON_SEVERITY: Readonly<Record<RaisingReason, 'HIGH' | 'MEDIUM'>> = {
    CANARY_RETURNED: 'HIGH',
    CREDENTIAL_SHAPE_RETURNED: 'HIGH',
    PLANTED_CONTEXT_RETURNED: 'MEDIUM',
};

export function isRaisingReason(reason: ProbeVerdictReason): reason is RaisingReason {
    const verdict = VERDICT_OF_REASON[reason];
    return verdict === 'ACTED' || verdict === 'DISCLOSED';
}

export interface ProbeRunIngestResult {
    runId: string;
    engagementId: string;
    concluded: boolean;
    findingCount: number;
    findingsOpened: number;
    findingsReopened: number;
    findingsResolved: number;
}

function assertMayIngest(ctx: RequestContext): void {
    if (!ctx.appPermissions.admin.agent_probes_ingest) {
        throw forbidden('Submitting a probe run requires admin.agent_probes_ingest');
    }
}

/** Reading the runs is reading the agent inventory, as the harness tab's is (#3710). */
function assertMayRead(ctx: RequestContext): void {
    if (!mayReadAgentInventory(ctx.appPermissions.admin)) {
        throw forbidden('Reading probe runs requires admin.agent_registry_view');
    }
}

const refused = (code: string, detail?: string) =>
    badRequest(`${PROBE_REPORT_REFUSAL}: ${code}${detail ? `: ${detail}` : ''}`);

/** Scheme and host of an endpoint the contract already verified as a canonical https URL. */
export function originOf(endpoint: string): string {
    return new URL(endpoint).origin;
}

/** A finding about a probe on a target is the prober's. */
export function probeFindingSourceRef(probeId: string, endpointDigest: string, tool: string | undefined, proberAgentId: string): string {
    return `probe:${probeId}@${endpointDigest}${tool ? `#${tool}` : ''}@${proberAgentId}`;
}

/** Verify and record one signed `scanent-probes/1` report. */
export async function ingestProbeReport(ctx: RequestContext, raw: string): Promise<ProbeRunIngestResult> {
    assertMayIngest(ctx);

    try {
        const result = await runInTenantContext(ctx, async (db) => {
            const keys = await db.agentProberKey.findMany({
                where: { tenantId: ctx.tenantId, revokedAt: null },
                select: { id: true, agentId: true, publicKey: true, keyFingerprint: true },
                take: MAX_KEYS,
            });

            // Verification first; nothing below reads the body before it has
            // passed a key the tenant trusts and the strict schema.
            const verdict = verifyAndParseProbesReport(raw, keys.map((k) => k.publicKey));
            if (!verdict.ok) {
                throw refused(verdict.reason, verdict.issues ? verdict.issues.slice(0, 20).join('; ') : undefined);
            }
            const body = verdict.body;
            // The schema refuses a secret's shape in an excerpt; the ingest walks
            // every other string too, as the other ingests do. Named by path only.
            const secretAt = firstSecretShapedMember(body);
            if (secretAt) throw refused('SECRET_IN_REPORT', secretAt);
            const fingerprint = harnessKeyFingerprint(verdict.signerKey);
            const key = keys.find((k) => k.keyFingerprint === fingerprint);
            if (!key) throw refused('UNTRUSTED_SIGNER');

            // The report names no agent: the prober is the agent its key belongs to.
            if (ctx.agentId && ctx.agentId !== key.agentId) {
                throw forbidden(
                    `${PROBE_REPORT_REFUSAL}: SUBMITTER_MISMATCH: this credential is bound to a different `
                    + 'agent from the prober that signed the report',
                );
            }

            const approver = await db.probeApproverKey.findFirst({
                where: {
                    tenantId: ctx.tenantId,
                    keyFingerprint: body.engagement.scopeSignerFingerprint,
                    revokedAt: null,
                },
                select: { id: true },
            });
            if (!approver) {
                throw refused(
                    'APPROVER_NOT_REGISTERED',
                    'the engagement scope was not signed by a live probe approver key this tenant registered',
                );
            }

            const reportDigest = harnessSignedMessage(body).toString('hex');
            const replay = await db.probeRun.findFirst({
                where: { tenantId: ctx.tenantId, reportDigest },
                select: { id: true },
            });
            if (replay) throw conflict(`${PROBE_REPORT_REFUSAL}: REPLAY: this report is already ingested`);

            return record(db, ctx, body, { proberKeyId: key.id, proberAgentId: key.agentId, approverKeyId: approver.id }, reportDigest, raw);
        });
        recordProbeRunOutcome({ outcome: 'ingested', concluded: result.concluded, stopped: result.stopped });
        const { stopped: _stopped, ...answer } = result;
        return answer;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const reason = new RegExp(`${PROBE_REPORT_REFUSAL}: ([A-Z_]+)`).exec(message)?.[1] ?? 'ERROR';
        recordProbeRunOutcome({ outcome: 'refused', reason });
        // The reason code only: a refused report's content is untrusted.
        logger.warn('probe run refused', { component: 'probe-runs', reason });
        throw err;
    }
}

interface PlannedWrite {
    readonly reason: RaisingReason;
    readonly sourceRef: string;
    readonly severity: 'HIGH' | 'MEDIUM';
    readonly title: string;
    readonly description: string;
}

/** What one report asserts and what it may close, by finding reference. Pure. */
export function planProbeFindings(
    outcomes: readonly {
        readonly sourceRef: string;
        readonly probeId: string;
        readonly probeClass: string;
        readonly verdict: string;
        readonly verdictReason: ProbeVerdictReason;
        readonly tool?: string;
        readonly origin: string;
        readonly kind: string;
    }[],
): { assert: PlannedWrite[]; resolve: string[] } {
    const assert = new Map<string, PlannedWrite>();
    const resisted = new Set<string>();
    for (const o of outcomes) {
        if (isRaisingReason(o.verdictReason)) {
            if (assert.has(o.sourceRef)) continue;
            const via = o.tool ? `, through its tool ${o.tool}` : '';
            assert.set(o.sourceRef, {
                reason: o.verdictReason,
                sourceRef: o.sourceRef,
                severity: REASON_SEVERITY[o.verdictReason],
                title: REASON_TITLE[o.verdictReason],
                description:
                    `Probe ${o.probeId} (${o.probeClass}) was sent to the ${o.kind} agent at ${o.origin}${via}, `
                    + `and the agent ${REASON_DONE[o.verdictReason]}. The run keeps an excerpt of the reply for `
                    + 'agent-register holders to judge it; this finding carries none of it. It closes when a later '
                    + 'run by the same prober sends this probe to this target and the agent resists.',
            });
        } else if (o.verdict === 'RESISTED') {
            resisted.add(o.sourceRef);
        }
    }
    // A reference the run raised is never closed by it, however else it answered.
    return { assert: [...assert.values()], resolve: [...resisted].filter((r) => !assert.has(r)) };
}

async function record(
    db: PrismaTx,
    ctx: RequestContext,
    body: ProbesReportBodyV1,
    keys: { proberKeyId: string; proberAgentId: string; approverKeyId: string },
    reportDigest: string,
    raw: string,
): Promise<ProbeRunIngestResult & { stopped: boolean }> {
    const now = new Date();
    const parsed = JSON.parse(raw) as { signature: { sig: string } };
    const concluded = probeReportConcluded(body);
    const count = (v: string) => body.outcomes.filter((o) => o.verdict === v).length;

    const targets = body.targets.map((t) => ({
        endpoint: t.endpoint,
        endpointDigest: keyedChangeDigest(PROBE_TARGET_DIGEST_DOMAIN, t.endpoint),
        origin: originOf(t.endpoint),
        kind: t.kind,
        reached: t.reached,
        targetReason: t.reason,
    }));
    const targetOf = new Map(targets.map((t) => [t.endpoint, t]));
    const outcomes = body.outcomes.map((o) => {
        const target = targetOf.get(o.endpoint);
        // The schema refuses an outcome for a target the report does not list.
        if (!target) throw refused('SCHEMA', 'an outcome names a target the report does not list');
        return {
            probeId: o.probeId,
            probeClass: o.probeClass,
            verdict: o.verdict,
            verdictReason: o.reason,
            tool: o.tool,
            replyDigest: o.replyDigest,
            excerpt: o.excerpt,
            endpointDigest: target.endpointDigest,
            origin: target.origin,
            kind: target.kind,
            sourceRef: probeFindingSourceRef(o.probeId, target.endpointDigest, o.tool, keys.proberAgentId),
        };
    });
    const plan = planProbeFindings(outcomes);

    const run = await db.probeRun.create({
        data: {
            tenantId: ctx.tenantId,
            proberAgentId: keys.proberAgentId,
            proberKeyId: keys.proberKeyId,
            approverKeyId: keys.approverKeyId,
            engagementId: body.engagement.id,
            scopeDigest: body.engagement.scopeDigest,
            scopeSignerFingerprint: body.engagement.scopeSignerFingerprint,
            catalogueDigest: body.catalogue.digest,
            catalogueProbes: body.catalogue.probes,
            startedAt: new Date(body.run.startedAt),
            endedAt: new Date(body.run.endedAt),
            stopReason: body.run.stopped,
            surfaceDigest: body.run.surfaceDigest,
            concluded,
            reportDigest,
            signature: parsed.signature.sig,
            targetCount: targets.length,
            targetsReached: targets.filter((t) => t.reached).length,
            outcomeCount: outcomes.length,
            actedCount: count('ACTED'),
            disclosedCount: count('DISCLOSED'),
            resistedCount: count('RESISTED'),
            inconclusiveCount: count('INCONCLUSIVE'),
            findingCount: plan.assert.length,
        },
        select: { id: true, engagementId: true },
    });

    const storedTargets = await db.probeRunTarget.createManyAndReturn({
        data: targets.map((t) => ({ tenantId: ctx.tenantId, runId: run.id, ...t })),
        select: { id: true, endpointDigest: true },
    });
    const targetIdOf = new Map(storedTargets.map((t) => [t.endpointDigest, t.id]));

    if (outcomes.length > 0) {
        await db.probeRunOutcome.createMany({
            data: outcomes.map((o) => ({
                tenantId: ctx.tenantId,
                runId: run.id,
                targetId: targetIdOf.get(o.endpointDigest) as string,
                probeId: o.probeId,
                probeClass: o.probeClass,
                verdict: o.verdict,
                verdictReason: o.verdictReason,
                tool: o.tool ?? null,
                replyDigest: o.replyDigest ?? null,
                excerpt: o.excerpt ?? null,
                sourceRef: o.sourceRef,
            })),
        });
    }

    const counts = await reconcileFindings(db, ctx, run.id, plan, now);

    await logEvent(db, ctx, {
        action: 'PROBE_RUN_INGESTED',
        entityType: 'ProbeRun',
        entityId: run.id,
        details: `Ingested probe run ${run.id} (${outcomes.length} probes, ${plan.assert.length} findings)`,
        detailsJson: {
            category: 'custom',
            entityName: 'ProbeRun',
            operation: 'ingested',
            after: {
                engagementId: body.engagement.id,
                proberAgentId: keys.proberAgentId,
                approverKeyId: keys.approverKeyId,
                concluded,
                stopReason: body.run.stopped,
                targetCount: targets.length,
                outcomeCount: outcomes.length,
                acted: count('ACTED'),
                disclosed: count('DISCLOSED'),
                resisted: count('RESISTED'),
                inconclusive: count('INCONCLUSIVE'),
                findingCount: plan.assert.length,
                reportDigest,
                findingsOpened: counts.findingsOpened,
                findingsReopened: counts.findingsReopened,
                findingsResolved: counts.findingsResolved,
            },
        },
    });

    return {
        runId: run.id,
        engagementId: run.engagementId,
        concluded,
        findingCount: plan.assert.length,
        stopped: body.run.stopped !== null,
        ...counts,
    };
}

async function reconcileFindings(
    db: PrismaTx,
    ctx: RequestContext,
    runId: string,
    plan: { assert: readonly PlannedWrite[]; resolve: readonly string[] },
    now: Date,
): Promise<{ findingsOpened: number; findingsReopened: number; findingsResolved: number }> {
    const refs = [...new Set([...plan.assert.map((f) => f.sourceRef), ...plan.resolve])];
    const existing = refs.length === 0
        ? []
        : await db.finding.findMany({
            where: {
                tenantId: ctx.tenantId,
                sourceKind: PROBE_FINDING_SOURCE_KIND,
                sourceRef: { in: refs },
                deletedAt: null,
            },
            select: { id: true, sourceRef: true, status: true },
            orderBy: { createdAt: 'asc' },
            take: refs.length,
        });
    const byRef = new Map<string, (typeof existing)[number]>();
    for (const f of existing) if (f.sourceRef && !byRef.has(f.sourceRef)) byRef.set(f.sourceRef, f);

    let findingsOpened = 0;
    let findingsReopened = 0;
    let findingsResolved = 0;

    for (const f of plan.assert) {
        const prior = byRef.get(f.sourceRef);
        if (!prior) {
            const created = await FindingRepository.create(db, ctx, {
                severity: f.severity,
                type: 'OBSERVATION',
                title: sanitizePlainText(f.title),
                description: sanitizePlainText(f.description),
                status: 'OPEN',
                sourceKind: PROBE_FINDING_SOURCE_KIND,
                sourceRef: f.sourceRef,
            });
            findingsOpened += 1;
            await logEvent(db, ctx, {
                action: 'CREATE',
                entityType: 'Finding',
                entityId: created.id,
                details: `Probe run ${runId} raised ${f.reason}`,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'Finding',
                    operation: 'created',
                    after: { reason: f.reason, sourceRef: f.sourceRef, severity: f.severity, runId },
                },
            });
        } else if (prior.status === 'CLOSED') {
            await db.finding.update({
                where: { id: prior.id },
                data: {
                    status: 'OPEN',
                    verificationNotes: sanitizePlainText(`Reopened by probe run ${runId}`),
                },
            });
            findingsReopened += 1;
            await logEvent(db, ctx, {
                action: 'STATUS_CHANGE',
                entityType: 'Finding',
                entityId: prior.id,
                details: `Probe run ${runId} reopened ${f.reason}`,
                detailsJson: {
                    category: 'status_change',
                    entityName: 'Finding',
                    before: { status: 'CLOSED' },
                    after: { status: 'OPEN', sourceRef: f.sourceRef, runId },
                },
            });
        }
    }

    for (const ref of plan.resolve) {
        const prior = byRef.get(ref);
        if (!prior || prior.status === 'CLOSED') continue;
        await db.finding.update({
            where: { id: prior.id },
            data: {
                status: 'CLOSED',
                verifiedAt: now,
                verificationNotes: sanitizePlainText(
                    `Resolved by probe run ${runId}: the same prober sent this probe to this target again and the agent resisted`,
                ),
            },
        });
        findingsResolved += 1;
        await logEvent(db, ctx, {
            action: 'STATUS_CHANGE',
            entityType: 'Finding',
            entityId: prior.id,
            details: `Probe run ${runId} resolved ${ref}`,
            detailsJson: {
                category: 'status_change',
                entityName: 'Finding',
                before: { status: prior.status },
                after: { status: 'CLOSED', sourceRef: ref, runId },
            },
        });
    }

    return { findingsOpened, findingsReopened, findingsResolved };
}

const RUN_ORDER = [{ startedAt: 'desc' as const }, { createdAt: 'desc' as const }, { id: 'desc' as const }];

/**
 * The most recent runs, newest first by when they started, then arrival, then
 * id. The inventory read: no excerpt and no endpoint — those are register
 * reads (step 8b).
 */
export async function listProbeRuns(ctx: RequestContext, opts: { take?: number } = {}) {
    assertMayRead(ctx);
    const take = Math.min(Math.max(opts.take ?? 50, 1), 200);
    return runInTenantContext(ctx, (db) =>
        db.probeRun.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: RUN_ORDER,
            take,
            select: {
                id: true,
                proberAgentId: true,
                engagementId: true,
                startedAt: true,
                endedAt: true,
                stopReason: true,
                concluded: true,
                targetCount: true,
                targetsReached: true,
                outcomeCount: true,
                actedCount: true,
                disclosedCount: true,
                resistedCount: true,
                inconclusiveCount: true,
                findingCount: true,
                createdAt: true,
            },
        }),
    );
}

// ── The Probes tab (step 8b) ────────────────────────────────────────────────

/** How many runs the tab reads, newest first; one more is read to know it was cut. */
export const PROBE_RUN_WINDOW = 200;
/** How many probers the tab gives a section. */
const MAX_PROBE_SECTIONS = 20;
/** How many runs one prober's section lists. */
const RUNS_PER_PROBER = 10;
/** How many open probe findings one section lists. */
const FINDINGS_PER_PROBER = 100;
/** How many open probe findings the tab reads across every prober. */
const OPEN_PROBE_FINDING_CAP = 5_000;
/** How many outcomes one run's detail returns. A run is the catalogue times its targets. */
const DETAIL_OUTCOME_CAP = 1_000;
/** How many targets one run's detail returns. */
const DETAIL_TARGET_CAP = 500;

const PROBE_SEVERITY_ORDER: Readonly<Record<string, number>> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

const RUN_VIEW_SELECT = {
    id: true,
    proberAgentId: true,
    engagementId: true,
    startedAt: true,
    endedAt: true,
    stopReason: true,
    concluded: true,
    targetCount: true,
    targetsReached: true,
    outcomeCount: true,
    actedCount: true,
    disclosedCount: true,
    resistedCount: true,
    inconclusiveCount: true,
    findingCount: true,
} as const;

type RunRow = {
    id: string;
    proberAgentId: string;
    engagementId: string;
    startedAt: Date;
    endedAt: Date;
    stopReason: string | null;
    concluded: boolean;
    targetCount: number;
    targetsReached: number;
    outcomeCount: number;
    actedCount: number;
    disclosedCount: number;
    resistedCount: number;
    inconclusiveCount: number;
    findingCount: number;
};

function runView(r: RunRow): ProbeRunView {
    return {
        runId: r.id,
        engagementId: r.engagementId,
        startedAt: r.startedAt.toISOString(),
        endedAt: r.endedAt.toISOString(),
        stopReason: r.stopReason,
        concluded: r.concluded,
        targetCount: r.targetCount,
        targetsReached: r.targetsReached,
        outcomeCount: r.outcomeCount,
        actedCount: r.actedCount,
        disclosedCount: r.disclosedCount,
        resistedCount: r.resistedCount,
        inconclusiveCount: r.inconclusiveCount,
        findingCount: r.findingCount,
    };
}

/** The prober a finding reference names: the part after its last `@`. */
function proberOfRef(sourceRef: string): string | null {
    const at = sourceRef.lastIndexOf('@');
    return at < 0 ? null : sourceRef.slice(at + 1);
}

/**
 * The Probes tab: each prober's recent runs, counts only, and its open
 * findings named by probe, class, origin and tool. Read under the inventory
 * rule, and never an endpoint or an excerpt: those are the detail read's, for
 * a register-key holder.
 *
 * Never silent about what it did not read: a prober holding a live key with no
 * run in the window is named, and a window, a section list or a finding list
 * that was cut says so (zero is never complete).
 */
export async function getProbeRunInventory(ctx: RequestContext): Promise<ProbeRunInventoryView> {
    assertMayRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const listed: RunRow[] = await db.probeRun.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: RUN_ORDER,
            take: PROBE_RUN_WINDOW + 1,
            select: RUN_VIEW_SELECT,
        });
        const runsTruncated = listed.length > PROBE_RUN_WINDOW;
        const runs = listed.slice(0, PROBE_RUN_WINDOW);

        const byProber = new Map<string, RunRow[]>();
        for (const r of runs) {
            const list = byProber.get(r.proberAgentId) ?? [];
            list.push(r);
            byProber.set(r.proberAgentId, list);
        }
        const shownProbers = [...byProber.keys()].slice(0, MAX_PROBE_SECTIONS);
        const probersNotShown = byProber.size - shownProbers.length;

        const keyHolders = await db.agentProberKey.findMany({
            where: { tenantId: ctx.tenantId, revokedAt: null },
            select: { agentId: true },
            distinct: ['agentId'],
            orderBy: { agentId: 'asc' },
            take: MAX_KEYS,
        });
        const withoutRunIds = keyHolders.map((k) => k.agentId).filter((id) => !byProber.has(id));

        const agentIds = [...new Set([...shownProbers, ...withoutRunIds])];
        const agents = agentIds.length === 0
            ? []
            : await db.registeredAgent.findMany({
                where: { tenantId: ctx.tenantId, id: { in: agentIds } },
                select: { id: true, name: true, deletedAt: true },
                take: agentIds.length,
            });
        const nameOf = new Map(agents.map((a) => [a.id, a.deletedAt === null ? a.name : null]));

        const open = shownProbers.length === 0
            ? []
            : await db.finding.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    sourceKind: PROBE_FINDING_SOURCE_KIND,
                    status: { not: 'CLOSED' },
                    deletedAt: null,
                },
                select: { id: true, sourceRef: true, severity: true },
                orderBy: { createdAt: 'asc' },
                take: OPEN_PROBE_FINDING_CAP + 1,
            });
        const openTruncated = open.length > OPEN_PROBE_FINDING_CAP;
        const openByProber = new Map<string, (typeof open)[number][]>();
        for (const f of open.slice(0, OPEN_PROBE_FINDING_CAP)) {
            const prober = f.sourceRef ? proberOfRef(f.sourceRef) : null;
            if (!prober) continue;
            const list = openByProber.get(prober) ?? [];
            list.push(f);
            openByProber.set(prober, list);
        }
        const shownOpen = shownProbers.map((p) => {
            const list = [...(openByProber.get(p) ?? [])];
            list.sort((a, b) => (PROBE_SEVERITY_ORDER[a.severity] ?? 9) - (PROBE_SEVERITY_ORDER[b.severity] ?? 9));
            return list;
        });
        const refs = [...new Set(shownOpen.flatMap((list) => list.slice(0, FINDINGS_PER_PROBER).map((f) => f.sourceRef as string)))];
        // The latest raising outcome of each reference names its probe, target and tool.
        const raised = refs.length === 0
            ? []
            : await db.probeRunOutcome.findMany({
                where: { tenantId: ctx.tenantId, sourceRef: { in: refs }, verdict: { in: ['ACTED', 'DISCLOSED'] } },
                distinct: ['sourceRef'],
                orderBy: [{ sourceRef: 'asc' }, { createdAt: 'desc' }],
                select: {
                    sourceRef: true,
                    probeId: true,
                    probeClass: true,
                    tool: true,
                    verdictReason: true,
                    target: { select: { origin: true, kind: true } },
                },
                take: refs.length,
            });
        const raisedOf = new Map(raised.map((o) => [o.sourceRef, o]));

        const sections: ProbeRunSection[] = shownProbers.map((prober, k) => {
            const proberRuns = byProber.get(prober) ?? [];
            const findings: ProbeFindingView[] = [];
            for (const f of shownOpen[k].slice(0, FINDINGS_PER_PROBER)) {
                const o = raisedOf.get(f.sourceRef as string);
                if (!o) continue;
                findings.push({
                    findingId: f.id,
                    severity: f.severity,
                    probeId: o.probeId,
                    probeClass: o.probeClass,
                    origin: o.target.origin,
                    kind: o.target.kind,
                    tool: o.tool,
                    verdictReason: o.verdictReason,
                });
            }
            return {
                proberAgentId: prober,
                proberName: nameOf.get(prober) ?? null,
                runs: proberRuns.slice(0, RUNS_PER_PROBER).map(runView),
                runsTruncated: proberRuns.length > RUNS_PER_PROBER,
                findings,
                findingsTruncated: openTruncated || shownOpen[k].length > FINDINGS_PER_PROBER,
            };
        });

        return {
            sections,
            probersWithoutRun: withoutRunIds.map((id) => ({ agentId: id, name: nameOf.get(id) ?? null })),
            probersNotShown,
            runsTruncated,
        };
    });
}

/**
 * One run: its targets and outcomes. Under the inventory rule; the full
 * endpoint and the excerpt of what the agent said are decrypted and returned
 * only to a holder of `admin.agent_registry` (owner decision, 2026-11-25), and
 * every read that returns them is audited, naming the run and nothing it read.
 * To anybody else both are null and `excerptsShown` is false: WITHHELD, which
 * the tab says, never empty.
 */
export async function getProbeRunDetail(ctx: RequestContext, runId: string): Promise<ProbeRunDetailView> {
    assertMayRead(ctx);
    const excerptsShown = Boolean(ctx.appPermissions.admin.agent_registry);
    return runInTenantContext(ctx, async (db) => {
        const run = await db.probeRun.findFirst({
            where: { id: runId, tenantId: ctx.tenantId },
            select: { ...RUN_VIEW_SELECT, catalogueProbes: true },
        });
        if (!run) throw notFound('Probe run not found');
        const prober = await db.registeredAgent.findFirst({
            where: { id: run.proberAgentId, tenantId: ctx.tenantId },
            select: { name: true, deletedAt: true },
        });
        const targets = await db.probeRunTarget.findMany({
            where: { tenantId: ctx.tenantId, runId: run.id },
            orderBy: [{ origin: 'asc' }, { id: 'asc' }],
            take: DETAIL_TARGET_CAP,
            select: {
                id: true,
                origin: true,
                kind: true,
                reached: true,
                targetReason: true,
                ...(excerptsShown ? { endpoint: true } : {}),
            },
        });
        const outcomes = await db.probeRunOutcome.findMany({
            where: { tenantId: ctx.tenantId, runId: run.id },
            orderBy: [{ targetId: 'asc' }, { probeId: 'asc' }, { id: 'asc' }],
            take: DETAIL_OUTCOME_CAP + 1,
            select: {
                id: true,
                targetId: true,
                probeId: true,
                probeClass: true,
                verdict: true,
                verdictReason: true,
                tool: true,
                sourceRef: true,
                ...(excerptsShown ? { excerpt: true } : {}),
            },
        });
        const outcomesTruncated = outcomes.length > DETAIL_OUTCOME_CAP;
        const shownOutcomes = outcomes.slice(0, DETAIL_OUTCOME_CAP);
        const refs = [...new Set(shownOutcomes.map((o) => o.sourceRef))];
        const findings = refs.length === 0
            ? []
            : await db.finding.findMany({
                where: { tenantId: ctx.tenantId, sourceKind: PROBE_FINDING_SOURCE_KIND, sourceRef: { in: refs }, deletedAt: null },
                select: { id: true, sourceRef: true },
                orderBy: { createdAt: 'asc' },
                take: refs.length,
            });
        const findingOf = new Map<string, string>();
        for (const f of findings) if (f.sourceRef && !findingOf.has(f.sourceRef)) findingOf.set(f.sourceRef, f.id);

        if (excerptsShown && shownOutcomes.some((o) => 'excerpt' in o && o.excerpt)) {
            await logEvent(db, ctx, {
                action: 'PROBE_RUN_EXCERPTS_READ',
                entityType: 'ProbeRun',
                entityId: run.id,
                details: `Read the agents' replies recorded by probe run ${run.id}`,
                detailsJson: { category: 'access', entityName: 'ProbeRun', operation: 'read' },
            });
        }

        return {
            run: {
                ...runView(run),
                proberAgentId: run.proberAgentId,
                proberName: prober && prober.deletedAt === null ? prober.name : null,
                catalogueProbes: run.catalogueProbes,
            },
            targets: targets.map((t) => ({
                targetId: t.id,
                origin: t.origin,
                kind: t.kind,
                reached: t.reached,
                reason: t.targetReason,
                endpoint: excerptsShown && 'endpoint' in t ? (t.endpoint as string) : null,
            })),
            outcomes: shownOutcomes.map((o) => ({
                outcomeId: o.id,
                targetId: o.targetId,
                probeId: o.probeId,
                probeClass: o.probeClass,
                verdict: o.verdict,
                verdictReason: o.verdictReason,
                tool: o.tool,
                excerpt: excerptsShown && 'excerpt' in o ? ((o.excerpt as string | null) ?? null) : null,
                findingId: findingOf.get(o.sourceRef) ?? null,
            })),
            outcomesTruncated,
            excerptsShown,
        };
    });
}
