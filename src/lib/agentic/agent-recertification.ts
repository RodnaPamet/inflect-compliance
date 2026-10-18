/**
 * Agent recertification (step 3a, #3674) — the pure half.
 *
 * An AGENT access review recertifies registered agents. For each agent a
 * workflow that uses read tools only assembles a REVIEWER PACK from stored
 * rows, the pack proposes the NARROWING its evidence supports, and a person
 * decides every subject. This module owns everything about that which needs no
 * database: the shape of the evidence the read tool returns, the narrowing
 * rule, the pack plan, and the closing evidence document and its bytes.
 *
 * PURE and server-free, so the workflow's SYNTHESIS step can call it, the
 * usecase can call it again to check the step's answer, and a test can call it
 * with nothing but literals.
 *
 * ── Client-reachable, so no Node built-in ────────────────────────────────
 *
 * A client component reaches this module: `RuleBuilderModal` imports the
 * workflow registry, which imports every workflow definition, and the pack
 * workflow's SYNTHESIS step calls `planAgentReviewPacks`. A `node:crypto`
 * import here broke `next build`; a bare `crypto` would compile only by
 * bundling a browser polyfill into the processes page. So the HASHES live in
 * `agent-recertification-hash.ts`, which only the server imports, and the plan
 * carries none: the usecase hashes each pack's sections when it writes them.
 * `tests/guards/client-reachable-modules-import-no-node-builtins.test.ts`
 * fails if a Node built-in becomes reachable from the registry again.
 *
 * ── The narrowing rule, and the two ways it could lie ──────────────────
 *
 * A grant is proposed for deletion when it was held for the WHOLE observation
 * window and no `AgentBehaviourWindow` recorded a call to it inside that
 * window. Both halves are there because each alone says something false:
 *
 *   - "No call recorded" alone would propose deleting a grant made yesterday,
 *     which has had no chance to be used. A grant younger than the window is
 *     reported as `TOO_RECENT` and proposes nothing.
 *   - The window bounds the claim. "Unused" means unused between `windowStart`
 *     and `windowEnd`, and the pack records both, so the claim a reviewer
 *     accepts is the claim the evidence makes and no wider.
 *
 * A narrowing only ever DELETES a grant. There is no rule here, or anywhere in
 * the campaign, that proposes adding one or raising a card.
 */
import { z } from 'zod';

import { canonicalJson } from '@/lib/canonical-json';

/** How far back observed use is read: the 90 days before the campaign froze. */
export const USE_WINDOW_DAYS = 90;

/** Agents per pack-preparation run. One run's context must fit `MAX_CONTEXT_BYTES`. */
export const PACK_PAGE_SIZE = 20;

/** The most agents one campaign freezes; read one past to know it was cut off. */
export const MAX_AGENT_SUBJECTS = 500;

/** The one reason a narrowing is proposed. */
export const NARROWING_BASIS = 'NO_RECORDED_CALL_IN_WINDOW';

/** The workflow that prepares the packs. */
export const AGENT_RECERTIFICATION_PACK_WORKFLOW = 'agent-recertification-pack';

/** The read tool its one READ step calls. */
export const AGENT_RECERTIFICATION_EVIDENCE_TOOL = 'get_agent_recertification_evidence';

/** The pack run's `subject` input meaning "every subject but the running agent's own". */
export const PACK_SUBJECT_ALL_BUT_SELF = '*';

const MS_PER_DAY = 86_400_000;

/**
 * Which `AgentProposalKind` each built-in propose tool queues — how a pack
 * attributes "proposals and their outcomes" to the GRANT that made them
 * possible. Mirrors `PROPOSE_TOOLS` in `src/lib/mcp/tools/propose-tools.ts`,
 * which cannot be imported here without pulling every propose usecase into the
 * read path; `tests/unit/agent-recertification.test.ts` pins the two equal.
 */
export const PROPOSAL_KIND_BY_PROPOSE_TOOL: Readonly<Record<string, string>> = {
    propose_risks: 'RISK',
    propose_controls: 'CONTROL',
    draft_policy: 'POLICY',
    propose_finding: 'FINDING',
};

/** The observation window ending at `end` (the campaign's creation). */
export function observationWindow(end: Date): { start: Date; end: Date } {
    return { start: new Date(end.getTime() - USE_WINDOW_DAYS * MS_PER_DAY), end };
}

// ── The evidence the read tool returns ───────────────────────────────────

const Iso = z.string().min(1);
const NullableIso = Iso.nullable();
const StatusCounts = z.record(z.string(), z.number().int().min(0));

export const GrantEvidenceSchema = z.object({
    grantId: z.string().min(1),
    toolName: z.string().min(1),
    grantedByUserId: z.string(),
    grantedAt: Iso,
    /** The latest behaviour window in the observation window that names the tool. */
    lastCalledAt: NullableIso,
    /** True when the grant existed at `windowStart`, so the whole window applies. */
    heldForWholeWindow: z.boolean(),
    /** Proposals of the kind this tool queues, by outcome; null for a non-propose tool. */
    proposals: StatusCounts.nullable(),
});

export const TimeBoundedGrantSchema = z.object({
    journalId: z.string().min(1),
    toolName: z.string(),
    connectionName: z.string(),
    grantedAt: Iso,
    endsAt: NullableIso,
    /** EXPIRED_VERIFIED | OUTLIVED_WINDOW | RUNNING | AWAITING_VERIFICATION | END_UNREADABLE */
    state: z.string(),
    /** True when verified gone and never raised as outliving its end; null while undetermined. */
    expiredOnTime: z.boolean().nullable(),
});

export const SubjectEvidenceSchema = z.object({
    decisionId: z.string().min(1),
    agentId: z.string().min(1),
    grants: z.array(GrantEvidenceSchema),
    /** True when the grant read hit its cap: no narrowing is proposed from a partial list. */
    grantsTruncated: z.boolean(),
    /** Proposals this agent made in the window whose kind maps to no granted tool. */
    otherProposals: z.record(z.string(), StatusCounts),
    cardVersions: z.object({
        since: NullableIso,
        currentVersion: z.number().int().nullable(),
        versions: z.array(z.object({
            version: z.number().int(),
            createdAt: Iso,
            createdByUserId: z.string().nullable(),
            approvalRung: z.string(),
            maxAutonomyLevel: z.number().int(),
            maxDataScope: z.string(),
            permittedToolCount: z.number().int(),
        })),
    }),
    timeBoundedGrants: z.array(TimeBoundedGrantSchema),
    guardFlags: StatusCounts,
    breaker: z.object({
        state: z.string(),
        trippedAt: NullableIso,
        trippedInWindow: z.boolean(),
        trippedSignals: z.array(z.string()),
        closedAt: NullableIso,
    }).nullable(),
    killEngagements: z.array(z.object({
        engagedAt: Iso,
        liftedAt: NullableIso,
        engagedByUserId: z.string(),
        liftedByUserId: z.string().nullable(),
    })),
    harness: z.object({
        level: z.string().nullable(),
        previousLevel: z.string().nullable(),
        /** UP | DOWN | SAME | FIRST_SCAN | NOT_SCANNED */
        drift: z.string(),
        lastSeenAt: NullableIso,
    }),
});

export const RecertificationEvidenceSchema = z.object({
    accessReviewId: z.string().min(1),
    page: z.number().int().min(0),
    pageSize: z.number().int().min(1),
    total: z.number().int().min(0),
    window: z.object({ start: Iso, end: Iso }),
    subjects: z.array(SubjectEvidenceSchema),
});

export type GrantEvidence = z.infer<typeof GrantEvidenceSchema>;
export type SubjectEvidence = z.infer<typeof SubjectEvidenceSchema>;
export type RecertificationEvidence = z.infer<typeof RecertificationEvidenceSchema>;

/** A pack's sections: the subject's evidence without its two identifiers. */
export type PackSections = Omit<SubjectEvidence, 'decisionId' | 'agentId'>;

export function sectionsOf(subject: SubjectEvidence): PackSections {
    // Destructured rather than deleted, so the sections object is a new value
    // and the evidence it came from is untouched.
    const { decisionId: _d, agentId: _a, ...sections } = subject;
    void _d;
    void _a;
    return sections;
}

// ── Narrowing ────────────────────────────────────────────────────────────

export interface NarrowingCandidate {
    readonly grantId: string;
    readonly toolName: string;
    readonly grantedByUserId: string;
    readonly grantedAt: string;
    readonly basis: typeof NARROWING_BASIS;
}

/**
 * The grants this subject's evidence supports deleting. Empty when the grant
 * read was truncated: a narrowing proposed from a partial list would be a
 * claim about the grants nobody read.
 */
export function narrowingsFor(subject: SubjectEvidence): NarrowingCandidate[] {
    if (subject.grantsTruncated) return [];
    return subject.grants
        .filter((g) => g.heldForWholeWindow && g.lastCalledAt === null)
        .map((g): NarrowingCandidate => ({
            grantId: g.grantId,
            toolName: g.toolName,
            grantedByUserId: g.grantedByUserId,
            grantedAt: g.grantedAt,
            basis: NARROWING_BASIS,
        }))
        .sort((a, b) => a.grantId.localeCompare(b.grantId));
}

export const PackPlanSchema = z.object({
    accessReviewId: z.string().min(1),
    page: z.number().int().min(0),
    packs: z.array(z.object({
        decisionId: z.string().min(1),
        agentId: z.string().min(1),
        narrowings: z.array(z.object({
            grantId: z.string().min(1),
            toolName: z.string().min(1),
            grantedByUserId: z.string(),
            grantedAt: Iso,
            basis: z.literal(NARROWING_BASIS),
        })),
    })),
});

export type PackPlan = z.infer<typeof PackPlanSchema>;

/**
 * The SYNTHESIS step: one pack per subject and its narrowings. Throws on
 * evidence that does not parse — a step that quietly planned nothing from a
 * malformed read would look like a clean campaign.
 *
 * No hash: the pack's content hash is computed by the server when it writes
 * the pack (`sha256Of` in `agent-recertification-hash.ts`), over the very
 * sections it stores — see the module header for why it is not here.
 */
export function planAgentReviewPacks(evidence: unknown): PackPlan {
    const e = RecertificationEvidenceSchema.parse(evidence);
    return {
        accessReviewId: e.accessReviewId,
        page: e.page,
        packs: e.subjects.map((s) => ({
            decisionId: s.decisionId,
            agentId: s.agentId,
            narrowings: narrowingsFor(s),
        })),
    };
}

// ── The second human's dissent vocabulary ────────────────────────────────

/**
 * Why a second reviewer did not concur with a sampled recertification
 * decision. Stable codes, never free text — the same reason
 * `SAMPLE_AUDIT_DISSENT_CODES` gives. Append; never repurpose a member.
 */
export const RECERT_SAMPLE_DISSENT_CODES = [
    /** The access should have been revoked. */
    'ACCESS_SHOULD_HAVE_BEEN_REVOKED',
    /** A narrowing the pack proposed should have been accepted. */
    'NARROWING_SHOULD_HAVE_BEEN_ACCEPTED',
    /** A narrowing was accepted that the agent needed. */
    'NARROWING_SHOULD_HAVE_BEEN_REJECTED',
    /** The pack's evidence does not support the decision recorded. */
    'DECISION_NOT_SUPPORTED_BY_PACK',
    /** The agent's owner or remit should have been questioned and was not. */
    'OWNERSHIP_OR_REMIT_NOT_QUESTIONED',
] as const;

export type RecertSampleDissentCode = (typeof RECERT_SAMPLE_DISSENT_CODES)[number];

// ── The closing evidence ─────────────────────────────────────────────────

export const AGENT_CAMPAIGN_EVIDENCE_SCHEMA = 'inflect-agent-recertification-evidence/1';

/** The stored rows the closing evidence is built from — every value a primitive. */
export interface AgentCampaignEvidenceRows {
    readonly campaign: {
        readonly id: string;
        readonly tenantId: string;
        readonly name: string;
        readonly periodStartAt: Date | null;
        readonly periodEndAt: Date | null;
        readonly reviewerUserId: string;
        readonly createdByUserId: string;
        readonly createdAt: Date;
        readonly closedAt: Date | null;
        readonly closedByUserId: string | null;
        readonly snapshotTruncated: boolean;
        readonly preparerAgentId: string | null;
        readonly crossPreparerAgentId: string | null;
    };
    readonly subjects: ReadonlyArray<{
        readonly decisionId: string;
        readonly subjectRef: string;
        readonly subjectAgentId: string | null;
        readonly subjectOwnerUserId: string | null;
        readonly snapshotJson: unknown;
        readonly decision: string | null;
        readonly decidedAt: Date | null;
        readonly decidedByUserId: string | null;
        readonly notes: string | null;
    }>;
    readonly packs: ReadonlyArray<{
        readonly decisionId: string;
        readonly contentHash: string;
        readonly preparedByRunId: string;
        /** NULL for the preparer's own pack when a person prepared it. */
        readonly preparedByAgentId: string | null;
        /** `AGENT_RUN` or `PERSON_STATIC_SELF_PACK` — stated, so the evidence says which pack no agent prepared. */
        readonly preparationBasis: string;
    }>;
    readonly narrowings: ReadonlyArray<{
        readonly id: string;
        readonly decisionId: string;
        readonly grantId: string;
        readonly toolName: string;
        readonly grantedByUserId: string;
        readonly grantedAt: Date;
        readonly basis: string;
        readonly outcome: string;
        readonly decidedAt: Date | null;
        readonly decidedByUserId: string | null;
        readonly executedAt: Date | null;
        readonly executionResult: string | null;
    }>;
    readonly samples: ReadonlyArray<{ readonly decisionId: string; readonly samplingEpoch: string }>;
    /** The obligations the evidence is filed against, as `(family, code)`. */
    readonly obligations: ReadonlyArray<{ readonly familyUrn: string; readonly requirementCode: string }>;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * The closing evidence document. Every collection is SORTED by an id it owns,
 * and every date is an ISO string, so the same stored rows always produce the
 * same bytes — which is the whole of "the hash recomputes from stored rows".
 * (`canonicalJson` sorts keys, not arrays, and renders a `Date` as `{}`.)
 */
export function buildAgentCampaignEvidence(rows: AgentCampaignEvidenceRows) {
    const packByDecision = new Map(rows.packs.map((p) => [p.decisionId, p]));
    const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
    const sampled = [...rows.samples].sort((a, b) => a.decisionId.localeCompare(b.decisionId));
    return {
        schema: AGENT_CAMPAIGN_EVIDENCE_SCHEMA,
        campaign: {
            id: rows.campaign.id,
            tenantId: rows.campaign.tenantId,
            name: rows.campaign.name,
            scope: 'AGENT',
            periodStartAt: iso(rows.campaign.periodStartAt),
            periodEndAt: iso(rows.campaign.periodEndAt),
            reviewerUserId: rows.campaign.reviewerUserId,
            createdByUserId: rows.campaign.createdByUserId,
            createdAt: iso(rows.campaign.createdAt),
            closedAt: iso(rows.campaign.closedAt),
            closedByUserId: rows.campaign.closedByUserId,
            snapshotTruncated: rows.campaign.snapshotTruncated,
            preparerAgentId: rows.campaign.preparerAgentId,
            crossPreparerAgentId: rows.campaign.crossPreparerAgentId,
        },
        subjectCount: rows.subjects.length,
        subjects: [...rows.subjects]
            .sort((a, b) => a.subjectRef.localeCompare(b.subjectRef))
            .map((s) => ({
                decisionId: s.decisionId,
                subjectRef: s.subjectRef,
                subjectAgentId: s.subjectAgentId,
                subjectOwnerUserId: s.subjectOwnerUserId,
                snapshot: s.snapshotJson ?? null,
                decision: s.decision,
                decidedAt: iso(s.decidedAt),
                decidedByUserId: s.decidedByUserId,
                notes: s.notes,
                pack: packByDecision.has(s.decisionId)
                    ? {
                        contentHash: packByDecision.get(s.decisionId)!.contentHash,
                        preparedByRunId: packByDecision.get(s.decisionId)!.preparedByRunId,
                        preparedByAgentId: packByDecision.get(s.decisionId)!.preparedByAgentId,
                        preparationBasis: packByDecision.get(s.decisionId)!.preparationBasis,
                    }
                    : null,
                narrowings: rows.narrowings
                    .filter((n) => n.decisionId === s.decisionId)
                    .map((n) => ({ ...n }))
                    .sort(byId)
                    .map((n) => ({
                        id: n.id,
                        grantId: n.grantId,
                        toolName: n.toolName,
                        grantedByUserId: n.grantedByUserId,
                        grantedAt: iso(n.grantedAt),
                        basis: n.basis,
                        outcome: n.outcome,
                        decidedAt: iso(n.decidedAt),
                        decidedByUserId: n.decidedByUserId,
                        executedAt: iso(n.executedAt),
                        executionResult: n.executionResult,
                    })),
            })),
        sample: {
            epoch: sampled[0]?.samplingEpoch ?? null,
            decisionIds: sampled.map((s) => s.decisionId),
        },
        obligations: [...rows.obligations]
            .map((o) => ({ familyUrn: o.familyUrn, requirementCode: o.requirementCode }))
            .sort((a, b) => `${a.familyUrn}|${a.requirementCode}`.localeCompare(`${b.familyUrn}|${b.requirementCode}`)),
    };
}

export type AgentCampaignEvidence = ReturnType<typeof buildAgentCampaignEvidence>;

/**
 * The bytes the evidence file holds: the canonical JSON of the document. Its
 * hash is `agentCampaignEvidenceHash` in `agent-recertification-hash.ts`.
 */
export function agentCampaignEvidenceBytes(doc: AgentCampaignEvidence): string {
    return canonicalJson(doc);
}
