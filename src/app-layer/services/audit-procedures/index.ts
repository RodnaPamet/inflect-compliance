/**
 * THE AUDITOR AGENT'S PROCEDURES, ON THE CONTROL-TEST RUNNER (#3676, step 3c;
 * UC4 of `docs/agentic-iam-roadmap.md`).
 *
 * Library v1 — five procedures of `docs/agentic-audit-procedures.md` — runs as
 * an engine family on the runner that already exists, not on a second one:
 *
 *   ControlTestPlan(INTEGRATION, automationConfig = { procedure, auditorAgentId,
 *                   parameters, sampleSize?, periodLabel? })
 *     → control-test-runner → the INTEGRATION handler → `auditProcedureHandler`
 *     → read the population from raw rows → freeze it → draw (or reuse) the
 *       binding keyed sample → re-perform each sampled unit → conclude
 *     → raise each exception as a `propose_finding` PROPOSAL, as the auditor
 *     → ControlTestRun(PASS | FAIL | INCONCLUSIVE) + Evidence
 *     → ONE AuditWorkpaper citing that evidence, inside the runner's transaction
 *
 * ── IT RUNS AS THE REGISTERED AUDITOR AGENT ─────────────────────────────────
 *
 * The plan names the auditor. Before anything is read the handler refuses —
 * INCONCLUSIVE, no workpaper, no proposal — unless that agent is registered
 * here, marked `isAuditor`, ACTIVE, not stopped by a kill switch at any scope,
 * holding no tool outside `AUDITOR_TOOL_REMIT` (Inflect's read tools and
 * `propose_finding`), and independent of the agents it audits. Every proposal
 * then goes through the tool funnel under the auditor's own identity
 * (`resolveMcpInvocation` → `runProposeTool`), so its grant, its policy card,
 * its kill switch, its circuit breaker, its autonomy ceiling and its card's
 * per-run and per-day budgets apply to each one, and each is pinned to the card
 * version that allowed it. The principal it speaks for is its accountable
 * owner — a second-line member, by the independence rule — resolved from that
 * owner's own membership, never a borrowed ADMIN.
 *
 * ── WHAT IT WRITES, AND WHAT IT NEVER WRITES ────────────────────────────────
 *
 * One workpaper per run, through 3b's writer (`recordAuditWorkpaperInTx`), and
 * one finding proposal per new exception. It writes no `Finding`: the result
 * says `findingsRaisedAs: 'PROPOSALS'`, so the runner does not raise its own;
 * an exception a person must act on reaches them once, as a proposal. Nothing
 * here updates, closes or resolves a finding. An exception the same procedure
 * and period already raised as a proposal that is still live (pending, or
 * decided by a person) is not raised again: its exception names the earlier
 * proposal, and a finding a person created from it is LINKED to the new
 * workpaper.
 *
 * ── ZERO IS NEVER COMPLETE ──────────────────────────────────────────────────
 *
 * An empty population is INCONCLUSIVE `EMPTY_POPULATION`, so the runner's
 * `isAttestingVerdict` does not stamp `Control.lastTested`. A truncated one is
 * never sampled. A PASS is `decideConclusion`'s, never `exceptions === 0`.
 */
import type { PrismaTx } from '@/lib/db-context';
import { deriveSubkey } from '@/lib/security/encryption';
import { resolveKillState } from '@/lib/agentic/kill-switch';
import {
    AUDIT_PROCEDURE_CATALOGUE_VERSION,
    periodBounds,
    periodHasEnded,
    populationDigest,
    sampleEpochFor,
    type RecordAuditWorkpaperInput,
} from '@/lib/agentic/audit-workpaper';
import {
    AUDIT_PROCEDURE_LIBRARY_V1,
    AUDITOR_PROPOSE_TOOL,
    auditSampleSeedPurpose,
    auditSampleSize,
    decideConclusion,
    drawAuditSample,
    exceptionFindingProposal,
    exceptionKey,
    LIBRARY_V1_STATUS,
    latestEndedPeriod,
    parseAuditProcedureConfig,
    periodSettled,
    seedFingerprint,
    toolsOutsideAuditorRemit,
    unsetParameters,
    type AuditProcedurePlanConfig,
    type LibraryV1ProcedureId,
    type UnitJudgement,
} from '@/lib/agentic/audit-procedure-library';
import { resolveMcpInvocation } from '@/lib/mcp/auth';
import { runProposeTool } from '@/lib/mcp/tools/propose-tools';
import { logger } from '@/lib/observability/logger';

import { resolveMemberContext } from '../../context-system';
import type {
    AutomationHandler,
    AutomationHandlerInput,
    AutomationHandlerResult,
} from '../../jobs/control-test-runner';
import { AuditWorkpaperRepository } from '../../repositories/AuditWorkpaperRepository';
import type { RequestContext } from '../../types';
import { recordAuditWorkpaperInTx } from '../../usecases/audit-workpaper';
import { evaluateOwnerIndependenceInTx } from '../../usecases/auditor-independence';

import { agentAuthorityConformance } from './agent-authority-conformance';
import { leaverTimeliness } from './leaver-timeliness';
import { privilegedAccess } from './privileged-access';
import { recertificationCompleteness } from './recertification-completeness';
import type { PopulationException, PopulationReading, ProcedureModule } from './shared';
import { timeBoundedAccessExpiry } from './time-bounded-access-expiry';

export { parseAuditProcedureConfig };

/** One module per library-v1 procedure. A procedure without one is not in the library. */
export const AUDIT_PROCEDURE_MODULES: Readonly<Record<LibraryV1ProcedureId, ProcedureModule>> = {
    'iam.leaver_timeliness': leaverTimeliness,
    'iam.recertification_completeness': recertificationCompleteness,
    'iam.time_bounded_access_expiry': timeBoundedAccessExpiry,
    'iam.privileged_access': privilegedAccess,
    'agent.authority_conformance': agentAuthorityConformance,
};

/** Prior workpapers of the same procedure and period read for proposals already raised. */
const PRIOR_WORKPAPER_CAP = 50;
/** How many fact lines reach the evidence body before it says "and N more". */
const MAX_FACTS = 60;

/** Why the auditor could not act at all. Nothing is read, proposed or recorded. */
export type AuditorRefusal =
    | 'CONFIG_INVALID'
    | 'AUDITOR_NOT_FOUND'
    | 'NOT_AN_AUDITOR'
    | 'AUDITOR_NOT_ACTIVE'
    | 'AUDITOR_KILLED'
    | 'AUDITOR_REMIT_EXCEEDED'
    | 'AUDITOR_OWNER_NOT_ACTIVE'
    | 'AUDITOR_NOT_INDEPENDENT';

interface AuditorStanding {
    readonly agentId: string;
    readonly ctx: RequestContext;
}

/**
 * Who the auditor is, and whether it may act. Every refusal is named; the
 * order is cheapest and least revealing first, and the kill switch — a
 * person's decision — before the remit and independence, which are
 * configuration.
 */
async function resolveAuditorStanding(
    input: AutomationHandlerInput,
    auditorAgentId: string,
    requestId: string,
): Promise<{ ok: true; standing: AuditorStanding } | { ok: false; refusal: AuditorRefusal; detail: string[] }> {
    const { db, tenantId } = input;
    const agent = await db.registeredAgent.findFirst({
        where: { id: auditorAgentId, tenantId, deletedAt: null },
        select: { id: true, isAuditor: true, status: true, ownerUserId: true },
    });
    if (!agent) return { ok: false, refusal: 'AUDITOR_NOT_FOUND', detail: [] };
    if (!agent.isAuditor) return { ok: false, refusal: 'NOT_AN_AUDITOR', detail: [] };
    if (agent.status !== 'ACTIVE') return { ok: false, refusal: 'AUDITOR_NOT_ACTIVE', detail: [`status=${agent.status}`] };

    const kill = await resolveKillState(tenantId, agent.id);
    if (kill) return { ok: false, refusal: 'AUDITOR_KILLED', detail: [`killScope=${kill.scope}`] };

    const grants = await db.registeredAgentTool.findMany({
        where: { tenantId, agentId: agent.id },
        select: { toolName: true },
        take: 500,
    });
    const outside = toolsOutsideAuditorRemit(grants.map((g) => g.toolName));
    if (outside.length > 0) {
        return { ok: false, refusal: 'AUDITOR_REMIT_EXCEEDED', detail: outside.map((t) => `toolOutsideRemit=${t}`) };
    }

    const member = await resolveMemberContext({
        tenantId,
        userId: agent.ownerUserId,
        job: 'audit-procedure',
    });
    if (!member) return { ok: false, refusal: 'AUDITOR_OWNER_NOT_ACTIVE', detail: [] };
    const ctx: RequestContext = {
        ...member,
        requestId,
        // A scheduled act of the auditor agent, attributed to its owner: the
        // trail reads "a job did this, for this agent", never "the owner did".
        actorType: 'JOB',
        agentId: agent.id,
    };

    const verdict = await evaluateOwnerIndependenceInTx(db, ctx, { ownerUserId: agent.ownerUserId, agentId: agent.id });
    if (!verdict.independent) {
        return { ok: false, refusal: 'AUDITOR_NOT_INDEPENDENT', detail: verdict.reasons.map((r) => `reason=${r}`) };
    }
    return { ok: true, standing: { agentId: agent.id, ctx } };
}

/** The per-tenant sampling key. Derived, never stored, never rendered, never logged. */
function seedForTenant(tenantId: string): string {
    return deriveSubkey(auditSampleSeedPurpose(tenantId)).toString('hex');
}

interface RaisedException {
    readonly unitId: string | null;
    readonly code: string;
    /** Raised by a population-level check over every unit, not by a sampled unit. */
    readonly populationLevel: boolean;
    proposalId?: string;
}

interface ProposalOutcome {
    readonly proposed: number;
    readonly reused: number;
    readonly notProposed: number;
    readonly refusal: string | null;
    readonly findingIds: string[];
}

/**
 * Raise each exception as ONE `propose_finding` proposal, as the auditor,
 * through the funnel — or name the live proposal an earlier run of this
 * procedure and period already raised for it. Stops at the first refusal: the
 * auditor's grant, card, budget or kill switch has said no, and asking again
 * for every remaining exception would only write the same denial again. The
 * exceptions not raised are counted, never dropped.
 */
async function raiseExceptions(
    db: PrismaTx,
    standing: AuditorStanding,
    config: AuditProcedurePlanConfig,
    periodLabel: string,
    controlId: string,
    epoch: string | null,
    exceptions: RaisedException[],
): Promise<ProposalOutcome> {
    const tenantId = standing.ctx.tenantId;
    if (exceptions.length === 0) return { proposed: 0, reused: 0, notProposed: 0, refusal: null, findingIds: [] };

    const prior = await db.auditWorkpaper.findMany({
        where: { tenantId, procedureId: config.procedure, periodLabel, auditorAgentId: standing.agentId },
        select: { exceptionsJson: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PRIOR_WORKPAPER_CAP,
    });
    const priorProposal = new Map<string, string>();
    for (const wp of prior) {
        for (const e of (Array.isArray(wp.exceptionsJson) ? wp.exceptionsJson : []) as {
            unitId?: string | null;
            code?: string;
            proposalId?: string;
        }[]) {
            if (typeof e.code !== 'string' || typeof e.proposalId !== 'string') continue;
            const key = exceptionKey(e.unitId ?? null, e.code);
            if (!priorProposal.has(key)) priorProposal.set(key, e.proposalId);
        }
    }
    const priorIds = [...new Set(priorProposal.values())];
    const priorRows =
        priorIds.length === 0
            ? []
            : await db.agentProposal.findMany({
                  where: { tenantId, id: { in: priorIds }, agentId: standing.agentId },
                  select: { id: true, status: true, createdEntityId: true },
                  take: priorIds.length,
              });
    // Live: pending, or decided by a person. An EXPIRED one nobody decided is raised again.
    const live = new Map(priorRows.filter((p) => p.status !== 'EXPIRED').map((p) => [p.id, p] as const));
    const createdFindings = [
        ...new Set(
            priorRows
                .filter((p) => (p.status === 'ACCEPTED' || p.status === 'EDITED') && p.createdEntityId)
                .map((p) => p.createdEntityId as string),
        ),
    ];
    const findings =
        createdFindings.length === 0
            ? []
            : await db.finding.findMany({
                  where: { tenantId, id: { in: createdFindings }, deletedAt: null },
                  select: { id: true },
                  take: createdFindings.length,
              });

    let reused = 0;
    const toRaise: RaisedException[] = [];
    for (const e of exceptions) {
        const earlier = priorProposal.get(exceptionKey(e.unitId, e.code));
        if (earlier && live.has(earlier)) {
            e.proposalId = earlier;
            reused += 1;
        } else {
            toRaise.push(e);
        }
    }

    let proposed = 0;
    let refusal: string | null = null;
    if (toRaise.length > 0) {
        const invocation = await resolveMcpInvocation(standing.ctx);
        for (const e of toRaise) {
            const { item, rationale } = exceptionFindingProposal({
                procedureId: config.procedure,
                periodLabel,
                unitId: e.unitId,
                code: e.code,
                controlId,
                auditorAgentId: standing.agentId,
                epoch: e.populationLevel ? null : epoch,
            });
            try {
                const result = await runProposeTool(invocation, AUDITOR_PROPOSE_TOOL, { items: [item], rationale });
                const text = result.content.find((c) => c.type === 'text');
                const parsed = JSON.parse(text && 'text' in text ? text.text : '{}') as {
                    proposalIds?: string[];
                    quarantinedProposalIds?: string[];
                };
                const id = parsed.proposalIds?.[0] ?? parsed.quarantinedProposalIds?.[0];
                if (!id) {
                    refusal = 'PROPOSAL_NOT_RETURNED';
                    break;
                }
                e.proposalId = id;
                proposed += 1;
            } catch (err) {
                // The funnel wrote its own AUTHZ_DENIED row; this records that the
                // procedure stopped proposing, never the message's content.
                refusal = 'PROPOSE_FINDING_REFUSED';
                logger.warn('audit procedure: finding proposal refused', {
                    component: 'audit-procedures',
                    tenantId,
                    procedureId: config.procedure,
                    agentId: standing.agentId,
                    error: err instanceof Error ? err.name : 'unknown',
                });
                break;
            }
        }
    }

    return {
        proposed,
        reused,
        notProposed: exceptions.filter((e) => e.proposalId === undefined).length,
        refusal,
        findingIds: findings.map((f) => f.id),
    };
}

function refusedResult(
    reason: AuditorRefusal,
    detail: readonly string[],
    procedure: string | null,
    scheduledFor: Date,
): AutomationHandlerResult {
    return {
        result: 'INCONCLUSIVE',
        evidenceTitle: `Audit procedure — ${procedure ?? 'unconfigured'} (INCONCLUSIVE, ${reason})`,
        evidenceContent: [
            `Audit procedure: ${procedure ?? 'unconfigured'}`,
            `Library v1 status: ${LIBRARY_V1_STATUS.status} (internal audit approval ${LIBRARY_V1_STATUS.internalAuditApproval}, ` +
                `provider agreement ${LIBRARY_V1_STATUS.providerAgreement}; ${LIBRARY_V1_STATUS.recordedOn})`,
            '',
            'Verdict: INCONCLUSIVE',
            `Basis: ${reason}`,
            'The auditor agent did not act: nothing was read, proposed or recorded, and no workpaper was written.',
            `Scheduled for: ${scheduledFor.toISOString()}`,
            '',
            ...detail,
        ].join('\n'),
        notes: `Audit procedure not run: ${reason}. No workpaper was written.`,
    };
}

/**
 * The handler. Declines (`null`) a plan whose config names no procedure, so
 * the agentic checks and any other INTEGRATION plan keep their own paths.
 */
export const auditProcedureHandler: AutomationHandler = async (
    input: AutomationHandlerInput,
): Promise<AutomationHandlerResult | null> => {
    const parse = parseAuditProcedureConfig(input.automationConfig);
    if (parse.kind === 'NOT_OURS') return null;
    if (parse.kind === 'INVALID') {
        return refusedResult('CONFIG_INVALID', [`configRefusal=${parse.reason}`], null, input.scheduledFor);
    }
    const config = parse.config;
    const def = AUDIT_PROCEDURE_LIBRARY_V1[config.procedure];
    const now = new Date();

    const resolved = await resolveAuditorStanding(input, config.auditorAgentId, `audit-procedure-${input.runId}`);
    if (!resolved.ok) return refusedResult(resolved.refusal, resolved.detail, config.procedure, input.scheduledFor);
    const { standing } = resolved;
    const db = input.db;

    const periodLabel = config.periodLabel ?? latestEndedPeriod(def.periodKind, now);
    const { start, end } = periodBounds(periodLabel);
    const baseEpoch = sampleEpochFor(config.procedure, periodLabel);

    // ── Preconditions that need no population ───────────────────────────────
    let precondition: string | null = null;
    if (!periodHasEnded(periodLabel, now)) precondition = 'PERIOD_OPEN';
    else if (unsetParameters(config).length > 0) precondition = 'PARAMETER_UNSET';
    else if (def.settleMarginHours !== undefined && !periodSettled(periodLabel, def.settleMarginHours, now)) {
        precondition = 'PERIOD_NOT_SETTLED';
    }

    // ── The population, read once from raw rows ─────────────────────────────
    const reading: PopulationReading | null =
        precondition === null
            ? await AUDIT_PROCEDURE_MODULES[config.procedure].read({
                  db,
                  tenantId: input.tenantId,
                  periodLabel,
                  periodStart: start,
                  periodEnd: end,
                  now,
                  parameters: config.parameters,
              })
            : null;
    const readIds = reading ? [...reading.unitIds].sort() : [];
    const populationExceptions: readonly PopulationException[] =
        reading && !reading.truncated ? reading.populationExceptions : [];
    if (reading && precondition === null) {
        if (reading.truncated) precondition = 'POPULATION_TRUNCATED';
        else if (readIds.length === 0 && populationExceptions.length === 0) precondition = 'EMPTY_POPULATION';
        else precondition = await reading.preconditions();
        if (precondition === null && readIds.length === 0) precondition = 'EMPTY_POPULATION';
    }
    const facts: string[] = [...(reading?.facts ?? [])];

    // ── Freeze, then draw the sample, or reuse the binding one ──────────────
    let populationCount = readIds.length;
    let digest = populationDigest(config.procedure, periodLabel, readIds);
    let sample: RecordAuditWorkpaperInput['sample'] = null;
    let units: UnitJudgement[] = [];
    let bindingFrom: string | null = null;
    if (precondition === null && reading) {
        // Serialise with any other run of this procedure and period: the same
        // key the workpaper writer and its trigger take, so a concurrent first
        // draw waits and is then held to the sample this run fixes.
        await db.$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            `audit-workpaper-sample:${input.tenantId}:${config.procedure}:${periodLabel}`,
        );
        const binding = await AuditWorkpaperRepository.findBindingSample(db, standing.ctx, config.procedure, periodLabel);
        const seed = seedForTenant(input.tenantId);
        if (binding && binding.sampleEpoch && binding.seedFingerprint) {
            bindingFrom = binding.id;
            if (binding.populationCount !== populationCount || binding.populationDigest !== digest) {
                facts.push(
                    `populationChangedSinceBinding=yes bindingCount=${binding.populationCount} readCount=${populationCount}`,
                );
            }
            if (binding.seedFingerprint !== seedFingerprint(seed)) facts.push('seedFingerprintDiffersFromBinding=yes');
            populationCount = binding.populationCount;
            digest = binding.populationDigest;
            sample = {
                epoch: binding.sampleEpoch,
                seedFingerprint: binding.seedFingerprint,
                sampledUnitIds: [...binding.sampledUnitIds],
            };
        } else {
            const sampled = def.subPopulations
                ? def.subPopulations.flatMap((sub) => {
                      const ids = reading.subPopulations?.[sub] ?? [];
                      return drawAuditSample({
                          seed,
                          epoch: sampleEpochFor(config.procedure, periodLabel, sub),
                          unitIds: ids,
                          size: auditSampleSize(ids.length, config.sampleSize),
                      });
                  })
                : drawAuditSample({
                      seed,
                      epoch: baseEpoch,
                      unitIds: readIds,
                      size: def.wholePopulation ? readIds.length : auditSampleSize(readIds.length, config.sampleSize),
                  });
            sample = sampled.length > 0 ? { epoch: baseEpoch, seedFingerprint: seedFingerprint(seed), sampledUnitIds: sampled } : null;
        }
        if (sample) {
            const evaluated = await reading.evaluate(sample.sampledUnitIds);
            units = evaluated.units;
            facts.push(...evaluated.facts);
        }
    }

    const verdict = decideConclusion({
        precondition,
        populationCount,
        populationExceptions: populationExceptions.length,
        sampleSize: sample?.sampledUnitIds.length ?? 0,
        units,
    });

    // ── Every exception, as a finding proposal ──────────────────────────────
    const exceptions: RaisedException[] =
        verdict.conclusion === 'FAIL'
            ? [
                  ...populationExceptions.map((e) => ({ unitId: e.unitId, code: e.code, populationLevel: true })),
                  ...units.flatMap((u) =>
                      u.exceptionCodes.map((code) => ({ unitId: u.unitId, code, populationLevel: false })),
                  ),
              ]
            : [];
    const proposals = await raiseExceptions(
        db,
        standing,
        config,
        periodLabel,
        input.controlId,
        sample?.epoch ?? null,
        exceptions,
    );
    const basis =
        verdict.conclusion === 'FAIL' && proposals.notProposed > 0 ? 'EXCEPTIONS_NOT_ALL_PROPOSED' : verdict.basis;

    const workpaper: Omit<RecordAuditWorkpaperInput, 'evidenceRefs'> = {
        procedureId: config.procedure,
        catalogueVersion: AUDIT_PROCEDURE_CATALOGUE_VERSION,
        periodLabel,
        populationDefinition: def.populationDefinition,
        populationCount,
        populationDigest: digest,
        sample,
        parameters: {
            ...config.parameters,
            ...(config.sampleSize !== null ? { sampleSize: config.sampleSize } : {}),
            ...(def.settleMarginHours !== undefined ? { settleMarginHours: def.settleMarginHours } : {}),
        },
        attributesTested: [...def.attributes],
        itemOutcomes: units.map((u) => ({ unitId: u.unitId, outcome: u.outcome, code: u.code })),
        exceptions: exceptions.map((e) => ({
            unitId: e.unitId,
            code: e.code,
            ...(e.proposalId !== undefined ? { proposalId: e.proposalId } : {}),
        })),
        conclusion: verdict.conclusion,
        conclusionBasis: basis,
        proposalIds: [...new Set(exceptions.map((e) => e.proposalId).filter((id): id is string => !!id))],
        findingIds: proposals.findingIds,
        auditorAgentId: standing.agentId,
        controlTestRunId: input.runId,
    };

    const evidence = renderWorkpaperEvidence({
        config,
        periodLabel,
        verdict: { conclusion: verdict.conclusion, basis },
        populationCount,
        digest,
        sample,
        bindingFrom,
        exceptions: exceptions.length,
        proposals,
        facts,
        readIds,
        scheduledFor: input.scheduledFor,
        auditorAgentId: standing.agentId,
    });

    return {
        result: verdict.conclusion,
        evidenceTitle: `Audit procedure — ${def.title} ${periodLabel} (${verdict.conclusion})`,
        evidenceContent: evidence,
        notes:
            `${config.procedure} ${periodLabel}: ${verdict.conclusion} (${basis}). Population ${populationCount}, ` +
            `sample ${sample?.sampledUnitIds.length ?? 0}, exceptions ${exceptions.length}` +
            (exceptions.length > 0 ? `, raised as finding proposals by the auditor agent` : '') +
            '.',
        findingSummary:
            verdict.conclusion === 'FAIL'
                ? `${exceptions.length} exception(s) in ${config.procedure} for ${periodLabel}: ` +
                  `${proposals.proposed} proposed, ${proposals.reused} already proposed, ${proposals.notProposed} not proposed.`
                : undefined,
        findingsRaisedAs: 'PROPOSALS',
        afterEvidence: async (evidenceId) => {
            await recordAuditWorkpaperInTx(db, standing.ctx, { ...workpaper, evidenceRefs: [evidenceId] });
        },
    };
};

function renderWorkpaperEvidence(input: {
    config: AuditProcedurePlanConfig;
    periodLabel: string;
    verdict: { conclusion: string; basis: string };
    populationCount: number;
    digest: string;
    sample: RecordAuditWorkpaperInput['sample'];
    bindingFrom: string | null;
    exceptions: number;
    proposals: ProposalOutcome;
    facts: readonly string[];
    readIds: readonly string[];
    scheduledFor: Date;
    auditorAgentId: string;
}): string {
    const def = AUDIT_PROCEDURE_LIBRARY_V1[input.config.procedure];
    const facts =
        input.facts.length <= MAX_FACTS
            ? input.facts
            : [...input.facts.slice(0, MAX_FACTS), `… and ${input.facts.length - MAX_FACTS} more`];
    const params = Object.entries(input.config.parameters)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
    return [
        `Audit procedure: ${input.config.procedure} (catalogue version ${AUDIT_PROCEDURE_CATALOGUE_VERSION})`,
        def.title,
        `Control identifiers: ${def.controls.join(', ')}`,
        `Library v1 status: ${LIBRARY_V1_STATUS.status} — internal audit approval ${LIBRARY_V1_STATUS.internalAuditApproval}, ` +
            `provider agreement ${LIBRARY_V1_STATUS.providerAgreement}, provider methodology reference ` +
            `${LIBRARY_V1_STATUS.providerMethodologyReference} (${LIBRARY_V1_STATUS.recordedOn})`,
        `Auditor agent: ${input.auditorAgentId}`,
        '',
        `Period: ${input.periodLabel}`,
        `Verdict: ${input.verdict.conclusion}`,
        `Basis: ${input.verdict.basis}`,
        `Population: ${input.populationCount} (digest ${input.digest})`,
        input.sample
            ? `Sample: ${input.sample.sampledUnitIds.length} drawn with epoch ${input.sample.epoch}, seed fingerprint ` +
              `${input.sample.seedFingerprint}` +
              (input.bindingFrom ? `; the binding sample of workpaper ${input.bindingFrom}, reused` : '; drawn by this run')
            : 'Sample: none drawn',
        `Exceptions: ${input.exceptions} (proposed ${input.proposals.proposed}, already proposed ${input.proposals.reused}, ` +
            `not proposed ${input.proposals.notProposed}${input.proposals.refusal ? `, ${input.proposals.refusal}` : ''})`,
        `Parameters: ${params.length > 0 ? params : 'none'}`,
        `Scheduled for: ${input.scheduledFor.toISOString()}`,
        '',
        'Facts:',
        ...facts.map((f) => `  ${f}`),
        '',
        input.bindingFrom
            ? `Population read by this run (${input.readIds.length}); the frozen list is the binding workpaper's evidence:`
            : `Frozen population (${input.readIds.length}):`,
        ...input.readIds.map((id) => `  ${id}`),
    ].join('\n');
}
