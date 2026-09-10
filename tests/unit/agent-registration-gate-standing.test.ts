/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles mirroring a
 * Prisma client. Per-line typing has poor cost/benefit in test doubles; the
 * file-level disable is this repo's standard for the shape. */
/**
 * TABLE A — the gate spine. `standing` × `enforcing`, and nothing else.
 *
 * ## What this file is for
 *
 * `evaluateAgentRegistration` used to answer THREE different situations with
 * the same four nulls — no agent bound, a bound id that resolves to nothing,
 * and an agent that exists but is not ACTIVE — and in a non-enforcing tenant it
 * answered all three with `reason: null` too. So the one caller that consumes
 * this verdict as an AUTHORITY-ASSEMBLY INPUT rather than as a refusal decision
 * (`mcp/auth.ts` `buildMcpInvocation`) could not tell "there is no agent" from
 * "the agent here is stopped", and correctly read the absent narrowing term as
 * no narrowing. That was #2399, and it made suspending an agent WIDEN its
 * credential.
 *
 * `standing` is the field that keeps the seven situations apart, and
 * `governedAgentIdOf` is the single place the SUSPENDED-only rule is spelled.
 * This file pins both, at both settings of the tenant flag.
 *
 * ## Why every assertion is `toEqual` on the WHOLE verdict
 *
 * Field-by-field `toBe` is the failure mode this table exists to avoid. A
 * verdict is seven fields and the defect was a DISAGREEMENT between two of
 * them: `agentId: null` beside a `subjectAgentId` that is not null is the whole
 * point, and `riskTier` regressing while `agentId` stays correct is exactly the
 * shape that hides behind a per-field assertion. An eighth field appearing with
 * the wrong value must also fail here, and only a whole-object compare does
 * that. So: one `toEqual` per cell, no exceptions, and the expected object is
 * written out in full rather than spread from a base.
 *
 * ## The enforcing/non-enforcing pair at the bottom is not a formality
 *
 * `assertRegisteredAgent` throws on `if (!verdict.reason)`. `reason` is
 * therefore the refusal and MUST stay conditional on `enforcing`; `standing` is
 * the unconditional field. A later well-meaning edit that makes `reason`
 * unconditional — the obvious "simplification" now that `standing` carries the
 * discriminator — is a 403 for every tenant that opted out of the register, on
 * a surface that was working. `throwsForEveryNonVouchedStanding` /
 * `returnsForEveryStanding` is the pair that catches it, and it is the single
 * most dangerous mistake available in this diff.
 *
 * Prisma is doubled down to the two reads this module makes: the tenant flag,
 * and the one `registeredAgent.findFirst` at the top of the evaluator. The
 * audit sink is doubled too, because the enforcing half of the pair writes a
 * hash-chained `AUTHZ_DENIED` row on its way to the throw and a real write is
 * not what this file is about.
 */

jest.mock('@/lib/prisma', () => {
    const tenantSecuritySettings = { findUnique: jest.fn() };
    const registeredAgent = { findFirst: jest.fn() };
    const client = { tenantSecuritySettings, registeredAgent };
    return { __esModule: true, default: client, prisma: client };
});

jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue(undefined),
}));

import type { AgentRiskTier, AgentStatus } from '@prisma/client';

import prisma from '@/lib/prisma';
import { appendAuditEntry } from '@/lib/audit';
import {
    assertRegisteredAgent,
    evaluateAgentRegistration,
    governedAgentIdOf,
    type AgentGateDenialReason,
    type AgentGateStanding,
    type AgentGateVerdict,
} from '@/lib/agentic/agent-registration-gate';
import { makeRequestContext } from '../helpers/make-context';

const settingsRead = (prisma as any).tenantSecuritySettings.findUnique as jest.Mock;
const agentRead = (prisma as any).registeredAgent.findFirst as jest.Mock;
const auditRows = appendAuditEntry as unknown as jest.Mock;

const TENANT = 'tenant-1';
/** `A` in the brief's table — the id the register holds for this credential. */
const AGENT = 'agent-A';
const SURFACE = { method: 'POST', path: '/api/mcp' } as const;

/**
 * The row `registeredAgent.findFirst` resolves to, or `null` for a binding the
 * register cannot produce. `status` is typed as `AgentStatus` so the
 * `unknown_status` row below has to spell its cast out loud.
 */
type AgentRow = {
    id: string;
    status: AgentStatus;
    autonomyLevel: number | null;
    riskTier: AgentRiskTier | null;
} | null;

/** One row of Table A: a fixture, and the verdict it must produce. */
interface Cell {
    /** The row's name in the brief's table. */
    label: string;
    standing: AgentGateStanding;
    /** `false` = no `ctx.agentId` at all, which is `no_binding`. */
    bound: boolean;
    row: AgentRow;
    expect: {
        agentId: string | null;
        subjectAgentId: string | null;
        autonomyLevel: number | null;
        riskTier: AgentRiskTier | null;
        /** `reason` when the tenant ENFORCES. It is always `null` when it does not. */
        reasonWhenEnforcing: AgentGateDenialReason | null;
        governed: string | null;
    };
}

/** A live row at rung 3, scored LOW — the brief's fixture for every resolved cell. */
function rowAt(status: AgentStatus, riskTier: AgentRiskTier | null = 'LOW'): AgentRow {
    return { id: AGENT, status, autonomyLevel: 3, riskTier };
}

const TABLE_A: readonly Cell[] = [
    {
        label: 'no_binding — no ctx.agentId',
        standing: 'no_binding',
        bound: false,
        row: null,
        expect: {
            agentId: null,
            subjectAgentId: null,
            autonomyLevel: null,
            riskTier: null,
            reasonWhenEnforcing: 'no_agent_binding',
            governed: null,
        },
    },
    {
        label: 'unresolvable — findFirst resolves to null',
        standing: 'unresolvable',
        bound: true,
        row: null,
        expect: {
            agentId: null,
            // NULL, unlike a stopped agent: the register produced no row, so
            // there is nothing for a control to be measured against.
            subjectAgentId: null,
            autonomyLevel: null,
            riskTier: null,
            reasonWhenEnforcing: 'agent_not_found',
            governed: null,
        },
    },
    {
        label: 'draft — DRAFT, rung 3, LOW',
        standing: 'draft',
        bound: true,
        row: rowAt('DRAFT'),
        expect: {
            agentId: null,
            subjectAgentId: AGENT,
            autonomyLevel: 3,
            riskTier: 'LOW',
            reasonWhenEnforcing: 'agent_not_active',
            // Nobody put a DRAFT agent into service and no supported path can
            // mint a key against one, so it does not govern.
            governed: null,
        },
    },
    {
        label: 'suspended — SUSPENDED, rung 3, LOW',
        standing: 'suspended',
        bound: true,
        row: rowAt('SUSPENDED'),
        expect: {
            agentId: null,
            subjectAgentId: AGENT,
            // The same rung it held while ACTIVE. Whether that number still
            // BINDS is `governedAgentIdOf`'s question, not this field's.
            autonomyLevel: 3,
            riskTier: 'LOW',
            reasonWhenEnforcing: 'agent_not_active',
            // THE LOAD-BEARING CELL. Not vouched for, and governing anyway:
            // suspension is the one status where somebody took a deliberate
            // action about this specific agent.
            governed: AGENT,
        },
    },
    {
        label: 'suspended, unscored — SUSPENDED, rung 3, no tier',
        standing: 'suspended',
        bound: true,
        row: rowAt('SUSPENDED', null),
        expect: {
            agentId: null,
            subjectAgentId: AGENT,
            autonomyLevel: 3,
            // `null` here is UNSCORED, not "no agent". The gate reports it
            // verbatim and callers disambiguate through `governedAgentIdOf`;
            // the two nulls resolve to opposite ceilings downstream.
            riskTier: null,
            reasonWhenEnforcing: 'agent_not_active',
            governed: AGENT,
        },
    },
    {
        label: 'retired — RETIRED, rung 3, LOW',
        standing: 'retired',
        bound: true,
        row: rowAt('RETIRED'),
        expect: {
            agentId: null,
            subjectAgentId: AGENT,
            autonomyLevel: 3,
            riskTier: 'LOW',
            reasonWhenEnforcing: 'agent_not_active',
            // The open asymmetry, pinned as it is rather than as it arguably
            // ought to be. See the note in
            // `docs/implementation-notes/2026-09-10-suspension-is-a-boundary-control.md`.
            governed: null,
        },
    },
    {
        label: "unknown_status — 'ARCHIVED' as AgentStatus",
        standing: 'unknown_status',
        bound: true,
        // A status this build has never been taught. Unrepresentable in the
        // Prisma enum, so the cast is the only way to reach the branch — the
        // same shape `agent-autonomy-ceiling.test.ts` uses for a tier this
        // build does not recognise. It must GOVERN: an unknown status is
        // CONTAINED, not admitted.
        row: rowAt('ARCHIVED' as AgentStatus),
        expect: {
            agentId: null,
            subjectAgentId: AGENT,
            autonomyLevel: 3,
            riskTier: 'LOW',
            reasonWhenEnforcing: 'agent_not_active',
            governed: AGENT,
        },
    },
    {
        label: 'vouched — ACTIVE, rung 3, LOW',
        standing: 'vouched',
        bound: true,
        row: rowAt('ACTIVE'),
        expect: {
            agentId: AGENT,
            subjectAgentId: AGENT,
            autonomyLevel: 3,
            riskTier: 'LOW',
            // Nothing was refused, so there is no reason even when enforcing.
            reasonWhenEnforcing: null,
            governed: AGENT,
        },
    },
];

/** Arrange the two doubled reads for one cell at one setting of the flag. */
function arrange(cell: Cell, enforcing: boolean) {
    settingsRead.mockResolvedValue({ requireRegisteredAgent: enforcing });
    agentRead.mockResolvedValue(cell.row);
    return makeRequestContext('OWNER', {
        tenantId: TENANT,
        apiKeyId: 'key-1',
        apiKeyScopes: ['mcp:read'],
        ...(cell.bound ? { agentId: AGENT } : {}),
    });
}

/** The whole verdict Table A says this cell produces. Seven fields, always. */
function expectedVerdict(cell: Cell, enforcing: boolean): AgentGateVerdict {
    return {
        enforcing,
        agentId: cell.expect.agentId,
        subjectAgentId: cell.expect.subjectAgentId,
        standing: cell.standing,
        autonomyLevel: cell.expect.autonomyLevel,
        riskTier: cell.expect.riskTier,
        reason: enforcing ? cell.expect.reasonWhenEnforcing : null,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('Table A — the whole verdict, per standing, at both settings of the flag', () => {
    describe.each(TABLE_A.map((c) => [c.label, c] as const))('%s', (_label, cell) => {
        it('ENFORCING: the whole verdict, compared as one object', async () => {
            const ctx = arrange(cell, true);
            const verdict = await evaluateAgentRegistration(ctx);
            // toEqual on the WHOLE verdict. See the header: a per-field
            // assertion lets a regression in one field hide behind a correct
            // neighbour, and lets an eighth field arrive unnoticed.
            expect(verdict).toEqual(expectedVerdict(cell, true));
        });

        it('NOT enforcing: the same verdict with `reason` null, and `standing` unchanged', async () => {
            const ctx = arrange(cell, false);
            const verdict = await evaluateAgentRegistration(ctx);
            expect(verdict).toEqual(expectedVerdict(cell, false));
        });

        it('the standing is IDENTICAL at both settings of the flag', async () => {
            const on = await evaluateAgentRegistration(arrange(cell, true));
            const off = await evaluateAgentRegistration(arrange(cell, false));
            // The discriminator is what a non-enforcing caller has to read, so
            // a `standing` that were conditional on `enforcing` would leave
            // `buildMcpInvocation` exactly as wide as #2399 found it.
            expect(off.standing).toBe(on.standing);
            expect(off.subjectAgentId).toBe(on.subjectAgentId);
        });

        it('governedAgentIdOf: the agent whose own controls apply', async () => {
            const verdict = await evaluateAgentRegistration(arrange(cell, true));
            expect(governedAgentIdOf(verdict)).toBe(cell.expect.governed);
        });

        it('governedAgentIdOf does not depend on enforcement either', async () => {
            const verdict = await evaluateAgentRegistration(arrange(cell, false));
            expect(governedAgentIdOf(verdict)).toBe(cell.expect.governed);
        });
    });

    it('covers all seven standings, and every fixture the brief lists', () => {
        // A guard on the table itself: a standing added to the union with no
        // row here would otherwise be silently untested, and the accessor's
        // exhaustive switch is only as good as the cells that drive it.
        expect(new Set(TABLE_A.map((c) => c.standing))).toEqual(
            new Set<AgentGateStanding>([
                'no_binding',
                'unresolvable',
                'draft',
                'suspended',
                'retired',
                'unknown_status',
                'vouched',
            ]),
        );
        expect(TABLE_A).toHaveLength(8);
    });

    it('exactly three standings govern, and `vouched` is not the only one', () => {
        const governing = TABLE_A.filter((c) => c.expect.governed !== null).map((c) => c.standing);
        // Stated as a set so the suspended-unscored duplicate does not make
        // this a count of rows rather than a claim about standings.
        expect(new Set(governing)).toEqual(
            new Set<AgentGateStanding>(['vouched', 'suspended', 'unknown_status']),
        );
    });

    it('a governed agent that is NOT vouched for is a state the table reaches', () => {
        // The pair `agentId: null` + `governed: A` is the whole of #2399. If a
        // later edit collapsed the two questions back into one field, no cell
        // in the table would hold this shape any more.
        const divergent = TABLE_A.filter(
            (c) => c.expect.agentId === null && c.expect.governed !== null,
        ).map((c) => c.label);
        expect(divergent).toEqual([
            'suspended — SUSPENDED, rung 3, LOW',
            'suspended, unscored — SUSPENDED, rung 3, no tier',
            "unknown_status — 'ARCHIVED' as AgentStatus",
        ]);
    });
});

describe('assertRegisteredAgent — the enforcing/non-enforcing pair', () => {
    /**
     * The wrapper throws on `if (!verdict.reason)`. These two suites are the
     * fence around that: making `reason` unconditional would turn the second
     * suite into eight 403s for tenants that opted out.
     */
    const NON_VOUCHED = TABLE_A.filter((c) => c.standing !== 'vouched');

    it.each(NON_VOUCHED.map((c) => [c.label, c] as const))(
        'ENFORCING, %s: throws, and audits exactly one AUTHZ_DENIED row',
        async (_label, cell) => {
            const ctx = arrange(cell, true);
            await expect(assertRegisteredAgent(ctx, SURFACE)).rejects.toThrow();
            expect(auditRows).toHaveBeenCalledTimes(1);
            expect(auditRows.mock.calls[0][0]).toMatchObject({
                action: 'AUTHZ_DENIED',
                detailsJson: expect.objectContaining({
                    gate: 'agent_registration',
                    reason: cell.expect.reasonWhenEnforcing,
                }),
            });
        },
    );

    it('ENFORCING, vouched: returns the verdict and writes nothing', async () => {
        const vouched = TABLE_A.find((c) => c.standing === 'vouched')!;
        const verdict = await assertRegisteredAgent(arrange(vouched, true), SURFACE);
        expect(verdict).toEqual(expectedVerdict(vouched, true));
        expect(auditRows).not.toHaveBeenCalled();
    });

    it.each(TABLE_A.map((c) => [c.label, c] as const))(
        'NOT enforcing, %s: RETURNS the whole verdict and writes nothing',
        async (_label, cell) => {
            const ctx = arrange(cell, false);
            // Not `.resolves.toBeDefined()`: the returned verdict is the thing
            // a non-enforcing caller assembles authority from, so the whole of
            // it is the assertion.
            await expect(assertRegisteredAgent(ctx, SURFACE)).resolves.toEqual(
                expectedVerdict(cell, false),
            );
            expect(auditRows).not.toHaveBeenCalled();
        },
    );

    it('an absent TenantSecuritySettings row ENFORCES', async () => {
        // The fail direction the module's header argues for, restated here
        // because every cell above pins the flag explicitly and would not
        // notice the default flipping.
        settingsRead.mockResolvedValue(null);
        agentRead.mockResolvedValue(rowAt('SUSPENDED'));
        const ctx = makeRequestContext('OWNER', {
            tenantId: TENANT,
            apiKeyId: 'key-1',
            agentId: AGENT,
        });
        await expect(assertRegisteredAgent(ctx, SURFACE)).rejects.toThrow();
    });
});
