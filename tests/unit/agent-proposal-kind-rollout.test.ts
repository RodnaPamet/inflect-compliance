/**
 * A NEW `AgentProposalKind` VALUE SHIPS IN TWO DEPLOYS, AND THIS FILE IS WHERE
 * FORGETTING THAT FAILS (#5053).
 *
 * A Prisma client meeting a stored enum value it was not generated with fails
 * the WHOLE read (`tests/integration/agent-driver-unknown-stored-mode.test.ts`
 * measures it for another enum), and the proposal queue reads its rows whole.
 * So if an image that WRITES a new kind is rolled back to one built before the
 * value existed, every read of the tenant's queue fails. The defence is the
 * same two-deploy discipline as `agent-driver-mode-rollout.test.ts`:
 *
 *   deploy 1  READ_ONLY  the value is in the enum and every reader understands
 *                        it, and no writer accepts it;
 *   deploy 2  WRITTEN    a writer accepts it, once the image carrying deploy 1
 *                        is the one production would roll back to.
 *
 * `ROLLOUT` is typed as a `Record` over the GENERATED enum, so a value the
 * schema gains fails `tsc` here until somebody classifies it. For a READ_ONLY
 * kind this file holds that nothing offers a way to write one: no propose tool
 * queues it, the recertification attribution names no tool for it, and its
 * brake is on (its `*_IMPLEMENTED` flag is false, so the kind is refused).
 */
import { AgentProposalKind as PrismaAgentProposalKind } from '@prisma/client';

import { PROPOSE_TOOLS } from '@/lib/mcp/tools/propose-tools';
import { PROPOSAL_KIND_BY_PROPOSE_TOOL } from '@/lib/agentic/agent-recertification';
import { PROCESS_MAP_PROPOSALS_IMPLEMENTED, withheldProposalDiff } from '@/lib/agentic/proposal-kind-rollout';
import { isDiffReviewable } from '@/lib/agentic/proposal-diff-status';

type Stage = 'READ_ONLY' | 'WRITTEN';

/**
 * Every value of `AgentProposalKind`, and how far its rollout has gone. A value
 * the schema gains goes in here as READ_ONLY first.
 */
const ROLLOUT: Readonly<Record<PrismaAgentProposalKind, Stage>> = {
    RISK: 'WRITTEN',
    CONTROL: 'WRITTEN',
    POLICY: 'WRITTEN',
    FINDING: 'WRITTEN',
    // Written by the external-write ladder's PROPOSE_ONLY rung, not a tool.
    EXTERNAL_WRITE: 'WRITTEN',
    // Deploy 1 of #5053: read by every surface, written by nothing.
    PROCESS_MAP: 'READ_ONLY',
};

/** The brake each READ_ONLY kind carries; a READ_ONLY kind without one fails. */
const BRAKE: Partial<Record<PrismaAgentProposalKind, boolean>> = {
    PROCESS_MAP: PROCESS_MAP_PROPOSALS_IMPLEMENTED,
};

const READ_ONLY = (Object.keys(ROLLOUT) as PrismaAgentProposalKind[]).filter(
    (k) => ROLLOUT[k] === 'READ_ONLY',
);

describe('every AgentProposalKind is classified', () => {
    it('ROLLOUT names exactly the generated enum', () => {
        // The type already demands every member; this catches an extra key.
        expect(Object.keys(ROLLOUT).sort()).toEqual(Object.values(PrismaAgentProposalKind).sort());
    });

    it('PROCESS_MAP is READ_ONLY in this release', () => {
        expect(ROLLOUT.PROCESS_MAP).toBe('READ_ONLY');
        expect(READ_ONLY).toContain('PROCESS_MAP');
    });
});

describe.each(READ_ONLY.map((k) => [k]))('a READ_ONLY kind (%s) has no writer', (kind) => {
    it('carries a brake, and it is engaged (IMPLEMENTED=false)', () => {
        expect(BRAKE[kind]).toBe(false);
    });

    it('is shown with a diff that withholds Approve, and is not called unreadable', () => {
        const diff = withheldProposalDiff(kind);
        expect(diff?.status).toBe('KIND_NOT_APPROVABLE');
        expect(isDiffReviewable(diff!)).toBe(false);
    });

    it('is queued by no propose tool', () => {
        expect(PROPOSE_TOOLS.filter((t) => t.kind === kind).map((t) => t.name)).toEqual([]);
    });

    it('is attributed to no propose tool by the recertification pack', () => {
        expect(
            Object.entries(PROPOSAL_KIND_BY_PROPOSE_TOOL)
                .filter(([, k]) => k === kind)
                .map(([tool]) => tool),
        ).toEqual([]);
    });
});

describe('a WRITTEN kind is never withheld', () => {
    it.each((Object.keys(ROLLOUT) as PrismaAgentProposalKind[]).filter((k) => ROLLOUT[k] === 'WRITTEN'))(
        '%s has no withheld diff',
        (kind) => {
            expect(withheldProposalDiff(kind)).toBeNull();
        },
    );
});
