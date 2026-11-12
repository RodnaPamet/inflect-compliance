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
 * kind this file holds that nothing offers a way to write one: no LOADABLE
 * propose tool queues it, the recertification attribution names no loadable
 * tool for it, and its brake is on (its `*_IMPLEMENTED` flag is false, so the
 * kind is refused). PROCESS_MAP's stage is DERIVED from its brake, so setting
 * the brake back to false moves it to READ_ONLY with no other edit here.
 */
import { AgentProposalKind as PrismaAgentProposalKind } from '@prisma/client';

import { PROPOSE_TOOLS, loadableProposeTools } from '@/lib/mcp/tools/propose-tools';
import type { McpInvocation } from '@/lib/mcp/authorize';
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
    // #5053: read by every surface since deploy 1, written by
    // `propose_process_map` since deploy 2 — while its brake is released.
    // Derived from the brake, so setting it back to false is the one-line
    // diff the brake promises and this table follows it.
    PROCESS_MAP: PROCESS_MAP_PROPOSALS_IMPLEMENTED ? 'WRITTEN' : 'READ_ONLY',
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

    it('PROCESS_MAP is WRITTEN exactly while its brake is released', () => {
        expect(ROLLOUT.PROCESS_MAP === 'WRITTEN').toBe(BRAKE.PROCESS_MAP);
    });
});

/**
 * An invocation with no agent, no card and no key: the whole catalogue is
 * offered, so the only filter left is the one under test.
 */
function openInvocation(): McpInvocation {
    return {
        ctx: { apiKeyScopes: undefined },
        offeredTools: PROPOSE_TOOLS.map((t) => t.name),
        grantedTools: null,
        policyCard: null,
    } as unknown as McpInvocation;
}

/** The loadable propose tools' names, with the brake forced to `brake`. */
function loadableWithBrake(brake: boolean): string[] {
    let names: string[] = [];
    jest.isolateModules(() => {
        jest.doMock('@/lib/agentic/proposal-kind-rollout', () => ({
            ...jest.requireActual('@/lib/agentic/proposal-kind-rollout'),
            PROCESS_MAP_PROPOSALS_IMPLEMENTED: brake,
        }));
        const mod = require('@/lib/mcp/tools/propose-tools') as typeof import('@/lib/mcp/tools/propose-tools');
        names = mod.loadableProposeTools(openInvocation()).map((t) => t.name);
    });
    return names;
}

describe('a brake withdraws its propose tool as well as refusing its kind (#5053)', () => {
    it('propose_process_map is loadable exactly while PROCESS_MAP_PROPOSALS_IMPLEMENTED is true', () => {
        expect(loadableProposeTools(openInvocation()).map((t) => t.name).includes('propose_process_map')).toBe(
            PROCESS_MAP_PROPOSALS_IMPLEMENTED,
        );
        expect(loadableWithBrake(true)).toContain('propose_process_map');
    });

    it('propose_process_map is withdrawn when the brake is set back to false, and nothing else is', () => {
        const names = loadableWithBrake(false);
        expect(names).not.toContain('propose_process_map');
        expect(names.sort()).toEqual(
            PROPOSE_TOOLS.filter((t) => t.kind !== 'PROCESS_MAP').map((t) => t.name).sort(),
        );
    });
});

// No kind is READ_ONLY today. The block stays for the next one; an empty table
// is not handed to `describe.each`, which refuses it.
const describeReadOnly = READ_ONLY.length > 0 ? describe.each(READ_ONLY.map((k) => [k])) : null;
describeReadOnly?.('a READ_ONLY kind (%s) has no writer', (kind: PrismaAgentProposalKind) => {
    it('carries a brake, and it is engaged (IMPLEMENTED=false)', () => {
        expect(BRAKE[kind]).toBe(false);
    });

    it('is shown with a diff that withholds Approve, and is not called unreadable', () => {
        const diff = withheldProposalDiff(kind);
        expect(diff?.status).toBe('KIND_NOT_APPROVABLE');
        expect(isDiffReviewable(diff!)).toBe(false);
    });

    it('is offered by no LOADABLE propose tool: its tool, if it has one, is withdrawn', () => {
        // A READ_ONLY kind may still have a tool in the catalogue (a brake set
        // back after deploy 2); what matters is that no invocation can load it.
        const kindTools = PROPOSE_TOOLS.filter((t) => t.kind === kind).map((t) => t.name);
        const loadable = loadableProposeTools(openInvocation()).map((t) => t.name);
        expect(kindTools.filter((n) => loadable.includes(n))).toEqual([]);
    });

    it('is attributed by the recertification pack only to a tool that cannot be loaded', () => {
        const loadable = loadableProposeTools(openInvocation()).map((t) => t.name);
        expect(
            Object.entries(PROPOSAL_KIND_BY_PROPOSE_TOOL)
                .filter(([tool, k]) => k === kind && loadable.includes(tool))
                .map(([tool]) => tool),
        ).toEqual([]);
    });
});

/**
 * The brake's refused side, held whatever the flag reads today: a rollback
 * depends on it, and a released brake runs none of it. The body is the real
 * `withheldProposalDiff`; only the brake it reads is passed in.
 */
describe('with the PROCESS_MAP brake engaged, the review diff withholds Approve', () => {
    it('PROCESS_MAP is shown as KIND_NOT_APPROVABLE, which is not reviewable', () => {
        const diff = withheldProposalDiff('PROCESS_MAP', false);
        expect(diff?.status).toBe('KIND_NOT_APPROVABLE');
        expect(isDiffReviewable(diff!)).toBe(false);
    });

    it('and only PROCESS_MAP: every other kind is never withheld by it', () => {
        for (const kind of Object.keys(ROLLOUT).filter((k) => k !== 'PROCESS_MAP')) {
            expect(withheldProposalDiff(kind, false)).toBeNull();
        }
    });

    it('released, nothing is withheld', () => {
        expect(withheldProposalDiff('PROCESS_MAP', true)).toBeNull();
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
