/**
 * AUDIT WORKPAPERS — the seam that stores, stamps and reads them (#3675, step
 * 3b). The auditor agent that writes them is step 3c; the internal-audit
 * sampling that reviews them is step 3d. This step ships the record and its
 * rules, and no route: the only writer is the auditor agent, which runs on the
 * control-test runner and reaches this module in-process.
 *
 * ## Who may do what
 *
 *   • RECORD a workpaper, or link findings to one: the AUDITOR, never a person.
 *     The context must be a job (`actorType: 'JOB'` — the control-test runner
 *     the auditor's handlers run on) or speak for the auditor agent itself
 *     (`ctx.agentId`). The agent must be a live auditor of this tenant, ACTIVE,
 *     and INDEPENDENT at the moment of writing: a workpaper written while its
 *     author's owner owns an audited agent is the auditee auditing itself, so
 *     the seam refuses it (`AUDITOR_NOT_INDEPENDENT`) rather than storing it
 *     and hoping a reader notices.
 *   • STAMP its review: a PERSON in the second or third line — an ACTIVE
 *     member whose line of defence an OWNER has declared SECOND or THIRD
 *     (#3735), holding `audits.view`, and not the auditor agent's owner. Once, ever (usecase, conditional UPDATE and
 *     trigger).
 *   • READ: `audits.manage` (step 0e's table). A workpaper lists exceptions
 *     about named people's access, and `audits.view` is every role's.
 *
 * ## What is refused, by name
 *
 * `details.reason` is one of `AuditWorkpaperRefusal`
 * (`src/lib/agentic/audit-workpaper.ts`). The contract's own shape rules —
 * codes not prose, an empty population never passing, the epoch fixed by the
 * period — are Zod refusals (400) before anything is read.
 *
 * ## A workpaper links findings and never closes one
 *
 * `AuditWorkpaperFinding` is insert-only, and nothing in this module writes
 * `Finding` at all: it reads a finding to check it exists in the tenant, and
 * inserts a link. Exceptions are raised as finding PROPOSALS by the auditor
 * (step 3c, `propose_finding`), which a person decides; their ids are recorded
 * in `proposalIds`.
 */
import { ConflictError, forbidden, notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import type { PrismaTx } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import {
    AUDIT_PROCEDURE_IDS,
    PERIOD_LABEL,
    periodHasEnded,
    RecordAuditWorkpaperSchema,
    sampleMatchesBinding,
    type AuditWorkpaperRefusal,
} from '@/lib/agentic/audit-workpaper';
import { WORKPAPER_STAMP_LINES, independenceReasonText } from '@/lib/agentic/auditor-independence';
import { assertCanRead } from '../policies/common';
import { logEvent } from '../events/audit';
import { AuditWorkpaperRepository } from '../repositories/AuditWorkpaperRepository';
import type { RequestContext } from '../types';
import { evaluateOwnerIndependenceInTx, lockAuditorIndependence } from './auditor-independence';

const LIST_CAP = 200;

function refuse(reason: AuditWorkpaperRefusal, message: string, extra: Record<string, unknown> = {}): never {
    throw new ConflictError(message, { reason, ...extra });
}

/** The auditor, never a person: a job, or a context that speaks for the agent named. */
function assertSpeaksForAuditor(ctx: RequestContext, auditorAgentId: string): void {
    assertCanRead(ctx);
    if (ctx.actorType === 'JOB') return;
    if (ctx.agentId !== undefined && ctx.agentId === auditorAgentId) return;
    throw forbidden(
        'A workpaper is written by the auditor agent, never by a person. Only the auditor agent ' +
            'that produced it, or the job it runs on, may record it or link findings to it.',
    );
}

/**
 * The auditor agent must exist here, be an auditor, be ACTIVE, and be
 * independent now. Takes the independence lock first, so a reconcile beside
 * it serialises.
 */
async function assertAuditorMayWrite(db: PrismaTx, ctx: RequestContext, auditorAgentId: string) {
    await lockAuditorIndependence(db, ctx);
    const agent = await db.registeredAgent.findFirst({
        where: { id: auditorAgentId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true, isAuditor: true, status: true, ownerUserId: true },
    });
    if (!agent) refuse('AUDITOR_NOT_FOUND', 'The auditor agent named on this workpaper is not registered here.');
    if (!agent.isAuditor) {
        refuse('NOT_AN_AUDITOR', 'The agent named on this workpaper is not an auditor agent.');
    }
    if (agent.status !== 'ACTIVE') {
        refuse(
            'AUDITOR_NOT_ACTIVE',
            `The auditor agent is ${agent.status.toLowerCase()}, so it writes no workpaper.`,
        );
    }
    const verdict = await evaluateOwnerIndependenceInTx(db, ctx, {
        ownerUserId: agent.ownerUserId,
        agentId: agent.id,
    });
    if (!verdict.independent) {
        refuse(
            'AUDITOR_NOT_INDEPENDENT',
            'The auditor agent is not independent of the agents it audits (' +
                verdict.reasons.map(independenceReasonText).join('; ') +
                '), so a workpaper it wrote would be the auditee auditing itself. Nothing was stored.',
            { independenceReasons: [...verdict.reasons] },
        );
    }
    return agent;
}

/** Every id must name a row of this tenant. One query per kind. */
async function assertAllExist(
    reason: AuditWorkpaperRefusal,
    label: string,
    ids: readonly string[],
    found: readonly { id: string }[],
): Promise<void> {
    const have = new Set(found.map((r) => r.id));
    const missing = [...new Set(ids)].filter((id) => !have.has(id));
    if (missing.length > 0) {
        refuse(reason, `${missing.length} ${label} named on this workpaper do not exist in this workspace.`, {
            missingCount: missing.length,
        });
    }
}

/**
 * STORE one workpaper — the auditor agent's re-performance of one procedure for
 * one period — with the findings it links. One transaction; nothing is written
 * unless every reference resolves in this tenant.
 */
export async function recordAuditWorkpaper(ctx: RequestContext, input: unknown) {
    const parsed = parseForRecord(ctx, input);
    return runInTenantContext(ctx, (db) => recordParsedInTx(db, ctx, parsed));
}

/**
 * The same write, on a transaction the CALLER already holds — the control-test
 * runner's (#3676). The auditor's handlers run inside the runner's tenant
 * transaction, which holds the `ControlTestRun` the workpaper names: a second
 * transaction could not see that uncommitted run and would refuse
 * `RUN_NOT_FOUND`. Every rule below is the same rule; only the transaction is
 * the caller's.
 */
export async function recordAuditWorkpaperInTx(db: PrismaTx, ctx: RequestContext, input: unknown) {
    const parsed = parseForRecord(ctx, input);
    return recordParsedInTx(db, ctx, parsed);
}

type ParsedWorkpaper = ReturnType<typeof RecordAuditWorkpaperSchema.parse>;

function parseForRecord(ctx: RequestContext, input: unknown): ParsedWorkpaper {
    const parsed = RecordAuditWorkpaperSchema.parse(input);
    assertSpeaksForAuditor(ctx, parsed.auditorAgentId);

    // A period that has not ended is not audited: the only workpaper it can
    // carry says so, with no sample (the catalogue's PERIOD_OPEN precondition).
    if (
        !periodHasEnded(parsed.periodLabel, new Date()) &&
        !(parsed.conclusion === 'INCONCLUSIVE' && parsed.conclusionBasis === 'PERIOD_OPEN' && parsed.sample === null)
    ) {
        refuse(
            'PERIOD_OPEN',
            `The period ${parsed.periodLabel} has not ended, so it cannot be audited yet. A workpaper ` +
                'for it can only be INCONCLUSIVE on PERIOD_OPEN, with no sample.',
        );
    }

    return parsed;
}

async function recordParsedInTx(db: PrismaTx, ctx: RequestContext, parsed: ParsedWorkpaper) {
    const findingIds = [...new Set(parsed.findingIds ?? [])];
    await assertAuditorMayWrite(db, ctx, parsed.auditorAgentId);

    const [run, evidence, proposals, findings] = await Promise.all([
        db.controlTestRun.findFirst({
            where: { id: parsed.controlTestRunId, tenantId: ctx.tenantId },
            select: { id: true },
        }),
        parsed.evidenceRefs.length === 0
            ? Promise.resolve([])
            : db.evidence.findMany({
                  where: { tenantId: ctx.tenantId, id: { in: parsed.evidenceRefs } },
                  select: { id: true },
                  take: parsed.evidenceRefs.length,
              }),
        parsed.proposalIds.length === 0
            ? Promise.resolve([])
            : db.agentProposal.findMany({
                  // A finding proposal the AUDITOR raised: its own id on the row.
                  where: {
                      tenantId: ctx.tenantId,
                      id: { in: parsed.proposalIds },
                      agentId: parsed.auditorAgentId,
                  },
                  select: { id: true },
                  take: parsed.proposalIds.length,
              }),
        findingIds.length === 0
            ? Promise.resolve([])
            : db.finding.findMany({
                  where: { tenantId: ctx.tenantId, id: { in: findingIds }, deletedAt: null },
                  select: { id: true },
                  take: findingIds.length,
              }),
    ]);
    if (!run) refuse('RUN_NOT_FOUND', 'The control-test run named on this workpaper does not exist here.');
    await assertAllExist('EVIDENCE_NOT_FOUND', 'evidence record(s)', parsed.evidenceRefs, evidence);
    await assertAllExist(
        'PROPOSAL_NOT_FOUND',
        'finding proposal(s) raised by this auditor',
        parsed.proposalIds,
        proposals,
    );
    await assertAllExist('FINDING_NOT_FOUND', 'finding(s)', findingIds, findings);

    // THE FIRST SAMPLE IS BINDING. Under the same lock key the trigger takes,
    // so two concurrent first runs serialise and the second is held to the
    // first; this gives the named refusal, the trigger is the backstop.
    if (parsed.sample) {
        await db.$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            `audit-workpaper-sample:${ctx.tenantId}:${parsed.procedureId}:${parsed.periodLabel}`,
        );
        const binding = await AuditWorkpaperRepository.findBindingSample(
            db,
            ctx,
            parsed.procedureId,
            parsed.periodLabel,
        );
        if (
            binding &&
            !sampleMatchesBinding(parsed.sample, {
                sampleEpoch: binding.sampleEpoch as string,
                seedFingerprint: binding.seedFingerprint as string,
                sampledUnitIds: binding.sampledUnitIds,
            })
        ) {
            refuse(
                'SAMPLE_NOT_BINDING',
                `Workpaper ${binding.id} already fixed the sample for ${parsed.procedureId} ` +
                    `${parsed.periodLabel}. A later run reuses that sample and re-evaluates it; ` +
                    'it never draws another.',
                { bindingWorkpaperId: binding.id },
            );
        }
    }

    const created = await AuditWorkpaperRepository.create(db, ctx, {
        procedureId: parsed.procedureId,
        catalogueVersion: parsed.catalogueVersion,
        periodLabel: parsed.periodLabel,
        populationDefinition: sanitizePlainText(parsed.populationDefinition),
        populationCount: parsed.populationCount,
        populationDigest: parsed.populationDigest,
        sampleEpoch: parsed.sample?.epoch ?? null,
        seedFingerprint: parsed.sample?.seedFingerprint ?? null,
        sampleSize: parsed.sample ? parsed.sample.sampledUnitIds.length : null,
        sampledUnitIds: parsed.sample?.sampledUnitIds ?? [],
        ...(parsed.parameters !== undefined ? { parametersJson: parsed.parameters } : {}),
        attributesTested: parsed.attributesTested,
        itemOutcomesJson: parsed.itemOutcomes,
        exceptionsJson: parsed.exceptions,
        exceptionCount: parsed.exceptions.length,
        conclusion: parsed.conclusion,
        conclusionBasis: parsed.conclusionBasis,
        evidenceRefs: [...new Set(parsed.evidenceRefs)],
        proposalIds: [...new Set(parsed.proposalIds)],
        auditorAgentId: parsed.auditorAgentId,
        controlTestRunId: parsed.controlTestRunId,
    });
    const linked = await AuditWorkpaperRepository.linkFindings(db, ctx, created.id, findingIds);

    await logEvent(db, ctx, {
        action: 'AUDIT_WORKPAPER_RECORDED',
        entityType: 'AuditWorkpaper',
        entityId: created.id,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'AuditWorkpaper',
            operation: 'created',
            after: {
                procedureId: parsed.procedureId,
                catalogueVersion: parsed.catalogueVersion,
                periodLabel: parsed.periodLabel,
                conclusion: parsed.conclusion,
                conclusionBasis: parsed.conclusionBasis,
                populationCount: parsed.populationCount,
                sampleSize: parsed.sample ? parsed.sample.sampledUnitIds.length : null,
                exceptionCount: parsed.exceptions.length,
                findingsLinked: linked,
                auditorAgentId: parsed.auditorAgentId,
                controlTestRunId: parsed.controlTestRunId,
            },
        },
    });

    return { id: created.id, createdAt: created.createdAt, findingsLinked: linked };
}

/**
 * LINK more findings to a workpaper — a finding that exists only once a person
 * approved the auditor's proposal. Insert-only; the finding is read, never
 * written.
 */
export async function linkFindingsToAuditWorkpaper(
    ctx: RequestContext,
    workpaperId: string,
    findingIds: readonly string[],
) {
    const ids = [...new Set(findingIds)];
    return runInTenantContext(ctx, async (db) => {
        const workpaper = await db.auditWorkpaper.findFirst({
            where: { id: workpaperId, tenantId: ctx.tenantId },
            select: { id: true, auditorAgentId: true },
        });
        if (!workpaper) throw notFound('Workpaper not found');
        assertSpeaksForAuditor(ctx, workpaper.auditorAgentId);
        const found =
            ids.length === 0
                ? []
                : await db.finding.findMany({
                      where: { tenantId: ctx.tenantId, id: { in: ids }, deletedAt: null },
                      select: { id: true },
                      take: ids.length,
                  });
        await assertAllExist('FINDING_NOT_FOUND', 'finding(s)', ids, found);
        const linked = await AuditWorkpaperRepository.linkFindings(db, ctx, workpaper.id, ids);
        if (linked > 0) {
            await logEvent(db, ctx, {
                action: 'AUDIT_WORKPAPER_FINDINGS_LINKED',
                entityType: 'AuditWorkpaper',
                entityId: workpaper.id,
                detailsJson: {
                    category: 'relationship',
                    operation: 'linked',
                    sourceEntity: 'AuditWorkpaper',
                    sourceId: workpaper.id,
                    targetEntity: 'Finding',
                    targetId: ids.join(','),
                    relation: 'links',
                },
            });
        }
        return { workpaperId: workpaper.id, linked };
    });
}

/**
 * STAMP a workpaper reviewed — once. The reviewer is a person in the second or
 * third line (`WORKPAPER_STAMP_LINES`, #3735), who does not own the auditor
 * agent. Step 3d's sampling
 * decides WHICH workpapers a reviewer is assigned; this is the stamp they set.
 */
export async function stampAuditWorkpaperReview(ctx: RequestContext, workpaperId: string) {
    assertCanRead(ctx);
    if (ctx.apiKeyId !== undefined || ctx.agentId !== undefined || ctx.actorType === 'JOB') {
        throw forbidden('A workpaper is reviewed by a person, never by a credential or a job.');
    }
    if (ctx.appPermissions?.audits?.view !== true) {
        throw forbidden('You do not have permission to review audit workpapers.');
    }
    const now = new Date();

    return runInTenantContext(ctx, async (db) => {
        const workpaper = await db.auditWorkpaper.findFirst({
            where: { id: workpaperId, tenantId: ctx.tenantId },
            select: { id: true, reviewedAt: true, reviewedByUserId: true, auditorAgentId: true },
        });
        if (!workpaper) throw notFound('Workpaper not found');
        if (workpaper.reviewedAt !== null) {
            refuse(
                'ALREADY_REVIEWED',
                `This workpaper was stamped reviewed on ${workpaper.reviewedAt.toISOString()}, and the ` +
                    'stamp is set once.',
            );
        }

        const membership = await db.tenantMembership.findFirst({
            where: { tenantId: ctx.tenantId, userId: ctx.userId },
            select: { status: true, lineOfDefence: true },
        });
        if (!membership || membership.status !== 'ACTIVE') {
            refuse('REVIEWER_NOT_ACTIVE_MEMBER', 'Only an active member of this workspace reviews a workpaper.');
        }
        if (membership.lineOfDefence === null) {
            refuse(
                'REVIEWER_LINE_UNDECLARED',
                'Your line of defence is not declared. A workpaper is reviewed by the second or third ' +
                    'line, and an OWNER declares it.',
            );
        }
        if (!WORKPAPER_STAMP_LINES.includes(membership.lineOfDefence)) {
            refuse(
                'REVIEWER_LINE_NOT_ELIGIBLE',
                'A workpaper is reviewed by the second line (risk and compliance) or the third (internal audit).',
            );
        }
        // The auditor's CURRENT owner, read now: ownership may have moved since
        // the workpaper was written, and whoever is accountable for the auditor
        // today does not review its work. An agent no longer in the register
        // has no owner to exclude.
        const auditor = await db.registeredAgent.findFirst({
            where: { id: workpaper.auditorAgentId, tenantId: ctx.tenantId },
            select: { ownerUserId: true },
        });
        if (auditor?.ownerUserId === ctx.userId) {
            refuse('REVIEWER_OWNS_AUDITOR', 'The owner of the auditor agent never reviews its workpapers.');
        }

        const stamped = await AuditWorkpaperRepository.stampReview(db, ctx, workpaper.id, ctx.userId, now);
        if (stamped === 0) {
            refuse('ALREADY_REVIEWED', 'This workpaper was stamped reviewed while this request was in flight.');
        }
        await logEvent(db, ctx, {
            action: 'AUDIT_WORKPAPER_REVIEWED',
            entityType: 'AuditWorkpaper',
            entityId: workpaper.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AuditWorkpaper',
                operation: 'updated',
                changedFields: ['reviewedAt', 'reviewedByUserId'],
                before: { reviewedAt: null },
                after: { reviewedAt: now.toISOString(), reviewedByUserId: ctx.userId },
            },
        });
        return { id: workpaper.id, reviewedAt: now, reviewedByUserId: ctx.userId };
    });
}

/** The binding sample for a procedure and period, for the auditor's next run to reuse. */
export async function getBindingWorkpaperSample(
    ctx: RequestContext,
    input: { auditorAgentId: string; procedureId: string; periodLabel: string },
) {
    assertSpeaksForAuditor(ctx, input.auditorAgentId);
    if (!(AUDIT_PROCEDURE_IDS as readonly string[]).includes(input.procedureId) || !PERIOD_LABEL.test(input.periodLabel)) {
        return null;
    }
    return runInTenantContext(ctx, (db) =>
        AuditWorkpaperRepository.findBindingSample(db, ctx, input.procedureId, input.periodLabel),
    );
}

/** Reading workpapers takes `audits.manage` (step 0e). */
function assertCanReadWorkpapers(ctx: RequestContext): void {
    assertCanRead(ctx);
    if (ctx.appPermissions?.audits?.manage !== true) {
        throw forbidden(
            "You do not have permission to read audit workpapers. They list exceptions about named " +
                "people's access.",
        );
    }
}

export async function listAuditWorkpapers(
    ctx: RequestContext,
    filters: { procedureId?: string; periodLabel?: string; auditorAgentId?: string } = {},
) {
    assertCanReadWorkpapers(ctx);
    return runInTenantContext(ctx, (db) => AuditWorkpaperRepository.list(db, ctx, filters, LIST_CAP));
}

export async function getAuditWorkpaper(ctx: RequestContext, id: string) {
    assertCanReadWorkpapers(ctx);
    const row = await runInTenantContext(ctx, (db) => AuditWorkpaperRepository.getById(db, ctx, id));
    if (!row) throw notFound('Workpaper not found');
    return row;
}
