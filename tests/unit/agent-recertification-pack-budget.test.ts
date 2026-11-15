/**
 * #5317 — one page of agent recertification evidence fits the run that holds it.
 *
 * A pack-preparation run holds its page's evidence (the READ step's output) and
 * the plan built from it (the SYNTHESIS step's) in its sealed context, which
 * `sealContext` refuses over `MAX_CONTEXT_BYTES`: the run fails, and with it
 * the campaign's whole preparation. So the per-agent caps of the evidence read,
 * the tool-name bound and `PACK_PAGE_SIZE` are one budget. This test builds the
 * WORST page — every subject with every section at its cap and every row at its
 * largest — seals it with the engine's own `sealContext`, and derives from it
 * the largest page that fits with HEADROOM to spare. That page must BE
 * `PACK_PAGE_SIZE`: a larger one would fail a customer's campaign, a smaller
 * one would run more runs than it needs. A later change to any cap, the bound
 * or the page size fails here rather than in a customer's campaign.
 *
 * Largest row, per field (the assumptions; each is a bound the code holds,
 * except the one marked):
 *   - row ids are cuids, 25 characters;
 *   - a user id is at most 32: a cuid, `sys_<cuid>` (29) or a system actor
 *     such as `system:agent-kill-switch-drill` (30);
 *   - a timestamp is ISO, 24 characters;
 *   - a granted tool name is at most 200 (`AgentToolGrantSchema`), and the
 *     pack carries it through `packToolName`, so at most `TOOL_NAME_IN_PACK`;
 *   - a grant carries proposal counts only when its tool is a propose tool
 *     (`PROPOSAL_KIND_BY_PROPOSE_TOOL`), and an agent holds one grant per
 *     tool (the `(tenantId, agentId, toolName)` unique), so at most that
 *     many grants carry counts, one per proposal status;
 *   - a time-bounded grant's tool is `grant_time_bounded_access`, the only key
 *     of `GRANT_EXPIRY_ARGS`;
 *   - ASSUMED: a connection name serialises to at most 200 bytes. The
 *     integrations route bounds it by nothing; 200 bytes is 100 Cyrillic or
 *     200 Latin characters.
 */
import { AgentProposalKind, SuggestionItemStatus } from '@prisma/client';

import {
    PACK_PAGE_SIZE,
    PROPOSAL_KIND_BY_PROPOSE_TOOL,
    TOOL_NAME_IN_PACK,
    packToolName,
    planAgentReviewPacks,
    type RecertificationEvidence,
    type SubjectEvidence,
} from '@/lib/agentic/agent-recertification';
import { MAX_CONTEXT_BYTES, sealContext } from '@/lib/agentic/context-integrity';
import { ENGINE_CAPS, estimateTokens } from '@/lib/agentic/workflow-types';
import {
    CARD_VERSIONS_PER_AGENT,
    GRANTS_PER_AGENT,
    KILLS_PER_AGENT,
    TIME_BOUNDED_PER_AGENT,
} from '@/app-layer/usecases/agent-recertification-evidence';

const ID = 25;
const USER_ID = 32;
const GRANTABLE_TOOL_NAME = 200;
const CONNECTION_NAME_BYTES = 200;
const TS = '2026-11-14T12:34:56.789Z';

/**
 * The share of `MAX_CONTEXT_BYTES` a worst page may use. The rest is room for
 * what the worst case does not model: the envelope growing, a field added to a
 * section, a count past 999,999.
 */
const HEADROOM = 0.1;
const BUDGET = Math.floor(MAX_CONTEXT_BYTES * (1 - HEADROOM));

/** A distinct id of `len` characters, so no two rows of the page are equal. */
let seq = 0;
const id = (len = ID) => {
    seq += 1;
    return `c${String(seq).padStart(len - 1, '0')}`;
};

const fullCounts = () => Object.fromEntries(Object.values(SuggestionItemStatus).map((s) => [s, 999_999]));
const PROPOSE_TOOLS = Object.keys(PROPOSAL_KIND_BY_PROPOSE_TOOL).length;

/**
 * One subject at every cap. Its grants are `GRANTS_PER_AGENT` of them, the
 * most a read that is not truncated holds, each with the longest name a grant
 * may have, held for the whole window and never called — so every one plans a
 * narrowing, which carries the name a second time. (A truncated read holds the
 * same number of grants and plans no narrowing, so it is lighter.)
 */
function worstSubject(): SubjectEvidence {
    return {
        decisionId: id(),
        agentId: id(),
        grants: Array.from({ length: GRANTS_PER_AGENT }, (_, i) => {
            const name = packToolName(`mcp__${id()}__${'t'.repeat(GRANTABLE_TOOL_NAME - ID - 7)}`);
            return {
                grantId: id(),
                toolName: name.toolName,
                ...(name.truncated ? { toolNameTruncated: true } : {}),
                grantedByUserId: id(USER_ID),
                grantedAt: TS,
                lastCalledAt: null,
                heldForWholeWindow: true,
                proposals: i < PROPOSE_TOOLS ? fullCounts() : null,
            };
        }),
        grantsTruncated: false,
        otherProposals: Object.fromEntries(Object.values(AgentProposalKind).map((k) => [k, fullCounts()])),
        cardVersions: {
            since: TS,
            currentVersion: 999_999,
            versions: Array.from({ length: CARD_VERSIONS_PER_AGENT }, () => ({
                version: 999_999,
                createdAt: TS,
                createdByUserId: id(USER_ID),
                approvalRung: 'R'.repeat(32),
                maxAutonomyLevel: 9,
                maxDataScope: 'WRITE_TENANT_DATA',
                permittedToolCount: 100,
            })),
        },
        timeBoundedGrants: Array.from({ length: TIME_BOUNDED_PER_AGENT }, () => ({
            journalId: id(),
            toolName: 'grant_time_bounded_access',
            connectionName: 'n'.repeat(CONNECTION_NAME_BYTES),
            grantedAt: TS,
            endsAt: TS,
            state: 'AWAITING_VERIFICATION',
            expiredOnTime: null,
        })),
        timeBoundedTruncated: true,
        guardFlags: { CLEAN: 999_999, FLAGGED: 999_999, QUARANTINED: 999_999 },
        breaker: {
            state: 'HALF_OPEN',
            trippedAt: TS,
            trippedInWindow: true,
            trippedSignals: Array.from({ length: 10 }, (_, i) => `SIGNAL_${i}`.padEnd(40, '_')),
            closedAt: TS,
        },
        killEngagements: Array.from({ length: KILLS_PER_AGENT }, () => ({
            engagedAt: TS,
            liftedAt: TS,
            engagedByUserId: id(USER_ID),
            liftedByUserId: id(USER_ID),
        })),
        killsTruncated: true,
        harness: { level: 'H5', previousLevel: 'H4', drift: 'FIRST_SCAN', lastSeenAt: TS },
    };
}

function page(subjects: SubjectEvidence[]): RecertificationEvidence {
    return {
        accessReviewId: id(),
        page: 1000,
        pageSize: PACK_PAGE_SIZE,
        total: 500,
        window: { start: TS, end: TS },
        subjects,
    };
}

/**
 * The context the pack run seals after its last step: its input, the READ
 * step's output and the SYNTHESIS step's, as the static driver stores them.
 * Null when `sealContext` refuses it outright.
 */
function sealedBytes(evidence: RecertificationEvidence): number | null {
    const plan = planAgentReviewPacks(evidence);
    const narrowings = plan.packs.reduce((n, p) => n + p.narrowings.length, 0);
    let bytes: number;
    try {
        bytes = sealContext({
            tenantId: id(),
            runId: id(),
            seq: 2,
            previousHash: 'a'.repeat(64),
            context: {
                input: { accessReviewId: evidence.accessReviewId, page: String(evidence.page), subject: id() },
                outputs: {
                    evidence,
                    packs: {
                        text: `Prepared ${plan.packs.length} reviewer pack(s) for page ${plan.page}; ${narrowings} narrowing(s) proposed.`,
                        data: plan,
                    },
                },
            },
        }).bytes;
    } catch (err) {
        expect(String(err)).toMatch(/CONTEXT_SIZE_CAP_EXCEEDED/);
        return null;
    }
    // The run's token budget is charged with every step's output too; a
    // context inside its byte cap is far inside it, but say so.
    expect(estimateTokens(evidence) + estimateTokens(plan)).toBeLessThan(ENGINE_CAPS.MAX_TOKENS);
    return bytes;
}

const worstPage = (size: number) => page(Array.from({ length: size }, worstSubject));
const fitsBudget = (size: number) => {
    const bytes = sealedBytes(worstPage(size));
    return bytes !== null && bytes <= BUDGET;
};

describe('the worst page of recertification evidence fits its run’s context (#5317)', () => {
    it('a full page of subjects with every section at its cap seals inside the budget', () => {
        const bytes = sealedBytes(worstPage(PACK_PAGE_SIZE));
        expect(bytes).not.toBeNull();
        expect(bytes!).toBeLessThanOrEqual(BUDGET);
    });

    it('PACK_PAGE_SIZE is the largest page the budget allows at these caps', () => {
        // Worked out here rather than asserted on a number, so the page size
        // this test shows is the one the caps imply.
        let largest = 0;
        while (fitsBudget(largest + 1)) largest += 1;
        expect(largest).toBe(PACK_PAGE_SIZE);
        expect(PACK_PAGE_SIZE).toBeGreaterThan(1);
    });

    it('a grant’s name weighs at most TOOL_NAME_IN_PACK characters in the pack, however long the grant’s is', () => {
        const grant = worstSubject().grants[0];
        expect(grant.toolName).toHaveLength(TOOL_NAME_IN_PACK);
        expect(grant.toolNameTruncated).toBe(true);
        const plan = planAgentReviewPacks(page([worstSubject()]));
        for (const n of plan.packs[0].narrowings) expect(n.toolName.length).toBeLessThanOrEqual(TOOL_NAME_IN_PACK);
    });
});
