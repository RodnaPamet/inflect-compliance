/**
 * SAMPLE-AUDIT APPROVED PROPOSALS — the only measurement of whether approvals
 * MEAN anything.
 *
 * OWASP ASI09. Every other signal the propose-not-commit queue emits describes
 * the SHAPE of the review behaviour — counts, latency, who clicked. None of
 * them can tell a queue that is being read from a queue that is being cleared,
 * and the second one manufactures an auditable record of consent nobody gave
 * while scoring perfectly on all of them.
 *
 * So this pass periodically re-draws already-approved proposals and opens a
 * retrospective review on each. `usecases/agent-proposal-sample-audit.ts`
 * carries the answer path and the disagreement rate. The selection rule and its
 * reasoning live in `src/lib/agentic/proposal-sampling.ts` — read that first;
 * this file is the plumbing around it.
 *
 * ── THIS IS THE ONLY WRITE SEAM for AgentProposalSampleAudit ─────────
 *
 * A human cannot open a sample audit on a proposal of their choosing. If they
 * could, the sample would stop being a sample: the selection could be steered
 * toward approvals somebody already wanted re-examined, and the resulting rate
 * would describe that choice rather than the queue. Same discipline the JML
 * subsystem states as "each table has exactly one write seam".
 *
 * ── Reproducible, but not predictable ────────────────────────────────
 *
 * The seed is `deriveSubkey` over the master KEK, per tenant. It is never
 * stored, never rendered, never logged — only `samplingEpoch` is persisted, and
 * an epoch without the key reveals nothing. A test supplies its own seed
 * through the options bag, which is the entire reason the sampler takes one as
 * an argument rather than reaching for the key itself.
 *
 * The property that survives a reader of this file is the third one in
 * `proposal-sampling.ts`: selection is RANK over a population that includes
 * approvals made after any given one, so even with the seed nobody can know at
 * approval time whether a proposal will be drawn.
 *
 * ── Why one query across every tenant ────────────────────────────────
 *
 * Not for speed. A per-tenant `findMany` inside the tenant loop would be a
 * Prisma READ inside a loop, which the D1 query-shape guardrail refuses — and
 * refuses for the reason it bites here: the loop's length is the number of
 * tenants, so the cost is invisible in every test fixture and unbounded in
 * production. Everything below reads once, groups in memory, and writes.
 */
import type { PrismaClient } from '@prisma/client';

import { appendAuditEntry } from '@/lib/audit';
import { logger } from '@/lib/observability/logger';
import { deriveSubkey } from '@/lib/security/encryption';
import {
    samplingEpochFor,
    selectSample,
    sampleSizeFor,
} from '@/lib/agentic/proposal-sampling';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The statuses that mean "a human approved this".
 *
 * ACCEPTED and EDITED both. An EDITED approval is if anything the more
 * interesting one to re-review — the reviewer engaged enough to change
 * something, so whether the change was RIGHT is a sharper question than whether
 * a nod was — and excluding it would sample only the approvals where nobody
 * touched anything, which is a biased draw in the direction that flatters.
 */
export const APPROVED_STATUSES = ['ACCEPTED', 'EDITED'] as const;

/**
 * How far back a run draws from.
 *
 * 30 days, and the bound is on the PROPOSAL's review date, not on the run. A
 * proposal approved four months ago is not re-drawable, which is deliberate:
 * the point of the measurement is to catch a queue going bad NOW, and a sample
 * that reaches indefinitely backwards dilutes a current problem with a year of
 * history.
 */
export const SAMPLE_LOOKBACK_DAYS = 30;

/**
 * The ceiling on how many candidates one run reads, across all tenants.
 *
 * Ordered by `reviewedAt` DESCENDING, so at the cap the run keeps the MOST
 * RECENT approvals rather than an arbitrary slice — the same reasoning as the
 * lookback. It is a cap on the read, not on any tenant's share: `sampleSizeFor`
 * still bounds each tenant's draw independently.
 */
export const CANDIDATE_READ_LIMIT = 5000;

/** The HKDF purpose string. Versioned; changing it re-randomises every draw. */
const SEED_PURPOSE_PREFIX = 'inflect-agent-proposal-sample-audit-v1';

export interface AgentProposalSampleAuditOptions {
    /** Scope to one tenant. Omitted = system-wide, which is how it is scheduled. */
    tenantId?: string;
    /** Override the "now" anchor — test-only seam. */
    now?: Date;
    /**
     * Override the per-tenant HMAC seed — TEST-ONLY.
     *
     * Present so a test can assert the selection is REPRODUCIBLE without
     * holding the deployment's key, which is the whole tension this subsystem
     * resolves. Never supplied in production: the executor calls this with no
     * seed, so the derivation below is the only path a real run takes.
     */
    seed?: string;
    /** Override the epoch — test-only, same purpose as `seed`. */
    epoch?: string;
}

export interface AgentProposalSampleAuditResult {
    /** Approved, un-sampled proposals in the lookback window. */
    candidates: number;
    /** Tenants that had at least one candidate. */
    tenants: number;
    /** Sample audits this run opened. */
    opened: number;
}

/** The per-tenant seed. Derived, never stored, never logged. */
function seedForTenant(tenantId: string): string {
    return deriveSubkey(`${SEED_PURPOSE_PREFIX}:${tenantId}`).toString('hex');
}

export async function runAgentProposalSampleAudit(
    db: PrismaClient,
    options: AgentProposalSampleAuditOptions = {},
): Promise<AgentProposalSampleAuditResult> {
    const now = options.now ?? new Date();
    const epoch = options.epoch ?? samplingEpochFor(now);
    const { tenantId } = options;
    const tenantScope = tenantId ? { tenantId } : {};

    logger.info('agent-proposal sample audit starting', {
        component: 'agent-proposal-sample-audit',
        scope: tenantId ? 'tenant-scoped' : 'system-wide',
        epoch,
        // NAMED at the sink, never spread. `local/no-raw-prompt-logging`
        // cannot read the keys of a spread object, so a conditional spread
        // here is a field bag this repo's own census counts as a hole — and
        // the hole is the shape a prompt would hide in.
        tenantId: tenantId ?? null,
    });

    // ── 1. One read for the eligible population, across every tenant. ──
    //
    // `sampleAudits: { none: {} }` is what makes the run idempotent at the
    // POPULATION level rather than only at the unique index: a proposal already
    // carrying an audit is not a candidate at all, so re-running today does not
    // re-draw yesterday's picks and then discard them.
    const candidates = await db.agentProposal.findMany({
        where: {
            ...tenantScope,
            status: { in: [...APPROVED_STATUSES] },
            reviewedAt: { gte: new Date(now.getTime() - SAMPLE_LOOKBACK_DAYS * MS_PER_DAY) },
            sampleAudits: { none: {} },
        },
        select: { id: true, tenantId: true, agentId: true },
        orderBy: { reviewedAt: 'desc' },
        take: CANDIDATE_READ_LIMIT,
    });

    // ── 2. Group in memory, draw per tenant. Both pure. ──
    const byTenant = new Map<string, { id: string; agentId: string | null }[]>();
    for (const candidate of candidates) {
        const bucket = byTenant.get(candidate.tenantId) ?? [];
        bucket.push({ id: candidate.id, agentId: candidate.agentId });
        byTenant.set(candidate.tenantId, bucket);
    }

    const drawn: { tenantId: string; proposalId: string; agentId: string | null }[] = [];
    for (const [tid, bucket] of byTenant) {
        const seed = options.seed ?? seedForTenant(tid);
        for (const picked of selectSample(bucket, {
            seed,
            epoch,
            count: sampleSizeFor(bucket.length),
        })) {
            drawn.push({ tenantId: tid, proposalId: picked.id, agentId: picked.agentId });
        }
    }

    if (drawn.length === 0) {
        logger.info('agent-proposal sample audit complete', {
            component: 'agent-proposal-sample-audit',
            candidates: candidates.length,
            tenants: byTenant.size,
            opened: 0,
        });
        return { candidates: candidates.length, tenants: byTenant.size, opened: 0 };
    }

    // ── 3. Who to ask. ONE read for every drawn proposal's agent owner. ──
    //
    // `RegisteredAgent.ownerUserId` is NOT NULL, so an agent that resolves has
    // an accountable human by construction. A proposal with no `agentId` — a
    // pre-register row, or a human-driven assistant proposal — resolves to null
    // and the audit is opened unassigned rather than assigned to somebody
    // invented. "Nobody was named" and "this person was named" must not be the
    // same value.
    const agentIds = [...new Set(drawn.map((d) => d.agentId).filter((a): a is string => !!a))];
    const owners = agentIds.length
        ? await db.registeredAgent.findMany({
              where: { id: { in: agentIds } },
              select: { id: true, ownerUserId: true },
          })
        : [];
    const ownerByAgent = new Map(owners.map((o) => [o.id, o.ownerUserId]));

    // ── 4. Open them. `skipDuplicates` leans on the unique index, which is
    // the durable idempotency key a scheduled job needs — BullMQ's jobId
    // dedupe holds only inside the completed-job retention window.
    await db.agentProposalSampleAudit.createMany({
        data: drawn.map((d) => ({
            tenantId: d.tenantId,
            proposalId: d.proposalId,
            samplingEpoch: epoch,
            sampledAt: now,
            assignedToUserId: d.agentId ? (ownerByAgent.get(d.agentId) ?? null) : null,
        })),
        skipDuplicates: true,
    });

    // ── 5. One read back for the ids, then one audit row each. ──
    const created = await db.agentProposalSampleAudit.findMany({
        where: { proposalId: { in: drawn.map((d) => d.proposalId) }, samplingEpoch: epoch },
        select: { id: true, tenantId: true, proposalId: true, assignedToUserId: true },
    });

    for (const audit of created) {
        await appendAuditEntry({
            tenantId: audit.tenantId,
            // Nobody chose this row — the sampler did. Naming an actor would
            // suggest a person picked which approvals to re-examine, which is
            // precisely the property the keyed draw exists to deny them.
            userId: null,
            actorType: 'SYSTEM',
            entity: 'AgentProposalSampleAudit',
            entityId: audit.id,
            action: 'AGENT_PROPOSAL_SAMPLED',
            // Ids and the epoch only. The SEED is absent by construction: an
            // audit row is readable by the same people who review the queue,
            // and a seed in a readable row is a seed that lets a reviewer
            // predict tomorrow's draw.
            detailsJson: {
                category: 'access',
                proposalId: audit.proposalId,
                samplingEpoch: epoch,
                assignedToUserId: audit.assignedToUserId,
            },
            metadataJson: { proposalId: audit.proposalId, samplingEpoch: epoch },
        }).catch(() => undefined);
    }

    logger.info('agent-proposal sample audit complete', {
        component: 'agent-proposal-sample-audit',
        candidates: candidates.length,
        tenants: byTenant.size,
        opened: created.length,
    });

    return { candidates: candidates.length, tenants: byTenant.size, opened: created.length };
}
