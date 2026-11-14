/**
 * #5317 — one page of agent recertification evidence fits the run that holds it.
 *
 * A pack-preparation run holds its page's evidence (the READ step's output) and
 * the plan built from it (the SYNTHESIS step's) in its sealed context, which
 * `sealContext` refuses over `MAX_CONTEXT_BYTES`: the run fails, and with it
 * the campaign's whole preparation. So the per-agent caps of the evidence read
 * and `PACK_PAGE_SIZE` are one budget. This test builds the WORST page — every
 * subject with every section at its cap and every row at its largest — seals
 * it with the engine's own `sealContext`, and fails when it does not fit. A
 * later change to any cap, or to the page size, fails here rather than in a
 * customer's campaign.
 *
 * Largest row, per field (the assumptions; each is a bound the code holds,
 * except the one marked):
 *   - row ids are cuids, 25 characters;
 *   - a user id is at most 32: a cuid, `sys_<cuid>` (29) or a system actor
 *     such as `system:agent-kill-switch-drill` (30);
 *   - a timestamp is ISO, 24 characters;
 *   - a granted tool name is at most 200 (`AgentToolGrantSchema`);
 *   - a time-bounded grant's tool is `grant_time_bounded_access`, the only key
 *     of `GRANT_EXPIRY_ARGS`;
 *   - ASSUMED: a connection name serialises to at most 200 bytes. The
 *     integrations route bounds it by nothing; 200 bytes is 100 Cyrillic or
 *     200 Latin characters.
 */
import {
    PACK_PAGE_SIZE,
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
const TOOL_NAME = 200;
const CONNECTION_NAME_BYTES = 200;
const TS = '2026-11-14T12:34:56.789Z';

/** A distinct id of `len` characters, so no two rows of the page are equal. */
let seq = 0;
const id = (len = ID) => {
    seq += 1;
    return `c${String(seq).padStart(len - 1, '0')}`;
};

const PROPOSAL_STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED', 'EDITED', 'EXPIRED', 'WITHDRAWN'];
const PROPOSAL_KINDS = ['RISK', 'CONTROL', 'POLICY', 'FINDING', 'EXTERNAL_WRITE', 'PROCESS_MAP'];
const fullCounts = () => Object.fromEntries(PROPOSAL_STATUSES.map((s) => [s, 999_999]));

/**
 * One subject at every cap. Grants come `GRANTS_PER_AGENT - 1` of them, each
 * held for the whole window and never called, because that is the largest a
 * grant section gets: at the cap the subject is truncated and plans no
 * narrowing, and below it every unused grant adds a narrowing to the plan.
 * (The other case, a page whose shared grant read filled, is `fullGrantRead`.)
 */
function worstSubject(): SubjectEvidence {
    return {
        decisionId: id(),
        agentId: id(),
        grants: Array.from({ length: GRANTS_PER_AGENT - 1 }, () => ({
            grantId: id(),
            toolName: `mcp__${id()}__${'t'.repeat(TOOL_NAME - ID - 7)}`,
            grantedByUserId: id(USER_ID),
            grantedAt: TS,
            lastCalledAt: null,
            heldForWholeWindow: true,
            proposals: fullCounts(),
        })),
        grantsTruncated: false,
        otherProposals: Object.fromEntries(PROPOSAL_KINDS.map((k) => [k, fullCounts()])),
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
 */
function sealedBytes(evidence: RecertificationEvidence): number {
    const plan = planAgentReviewPacks(evidence);
    const narrowings = plan.packs.reduce((n, p) => n + p.narrowings.length, 0);
    const sealed = sealContext({
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
    });
    // The run's token budget is charged with every step's output too; a
    // context inside its byte cap is far inside it, but say so.
    expect(estimateTokens(evidence) + estimateTokens(plan)).toBeLessThan(ENGINE_CAPS.MAX_TOKENS);
    return sealed.bytes;
}

describe('the worst page of recertification evidence fits its run’s context (#5317)', () => {
    it('a full page of subjects with every section at its cap seals under MAX_CONTEXT_BYTES', () => {
        const evidence = page(Array.from({ length: PACK_PAGE_SIZE }, worstSubject));
        expect(sealedBytes(evidence)).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
    });

    it('so does a page whose shared grant read filled (its subjects plan no narrowing)', () => {
        // The grant read is one read for the page, `PACK_PAGE_SIZE ×
        // GRANTS_PER_AGENT + 1` rows; however they fall, every subject that
        // holds the cap is truncated and plans nothing. Put them all on the
        // first subject, the case where one agent takes the whole read.
        const subjects = Array.from({ length: PACK_PAGE_SIZE }, worstSubject);
        subjects[0] = {
            ...subjects[0],
            grants: Array.from({ length: PACK_PAGE_SIZE * GRANTS_PER_AGENT + 1 }, () => ({
                ...subjects[0].grants[0],
                grantId: id(),
                lastCalledAt: TS,
            })),
            grantsTruncated: true,
        };
        for (const s of subjects.slice(1)) {
            s.grants = [];
        }
        expect(sealedBytes(page(subjects))).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
    });

    it('is a real bound: a page one subject larger would not fit', () => {
        // Otherwise the page size is smaller than it needs to be, and every
        // campaign pays for runs it did not need.
        const evidence = page(Array.from({ length: PACK_PAGE_SIZE + 1 }, worstSubject));
        expect(() => sealedBytes(evidence)).toThrow(/CONTEXT_SIZE_CAP_EXCEEDED/);
    });
});
