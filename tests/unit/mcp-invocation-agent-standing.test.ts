/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles mirroring a
 * Prisma client. Per-line typing has poor cost/benefit in test doubles; the
 * file-level disable is this repo's standard for the shape. */
/**
 * TABLE B — what `buildMcpInvocation` ASSEMBLES, per register standing.
 *
 * ## Why the invocation and not the refusal
 *
 * #2399 was not a missing refusal. It was an assembly defect: the verdict is
 * consumed here as an AUTHORITY-ASSEMBLY INPUT, and for four of the seven
 * register situations it used to be the same four nulls. Absence of a narrowing
 * term is correctly read as no narrowing, so the situation an operator reaches
 * for first — a SUSPENDED agent — came out of this function WIDER than an
 * ACTIVE one: no grant list, no autonomy terms, no policy card.
 *
 * So the assertions below are about the assembled object, driven through the
 * REAL `buildMcpInvocation` with a verdict from the REAL
 * `evaluateAgentRegistration`. Nothing here constructs an `McpInvocation` by
 * hand; a hand-built invocation would pin the funnel's reading of these fields
 * and not the producer's writing of them, and the producer is what changed.
 *
 * ## The load-bearing row is `suspended`
 *
 *   · `grantedTools` is an EMPTY SET, not `null`. Empty DENIES — that is
 *     `listGrantedToolNames`' own stated contract and what `isToolExposed`
 *     already does with it — while `null` ADMITS, because there is no list to
 *     consult. The two are one keystroke apart and mean opposite things.
 *   · `governedAgentId` is present while `agentId` is null. That pair is the
 *     fix: every agent-keyed control reads the former.
 *   · the autonomy ceiling is back to `min(key max, registered rung, tier cap)`
 *     rather than `min([UNCLAMPED])` = 6. A ceiling of 6 is above what any tier
 *     can reach (LOW caps at 4, CRITICAL at 1), so suspending a CRITICAL agent
 *     used to promote it from read-only to propose-capable.
 *   · the policy card IS loaded, keyed off the governed agent. The artefact
 *     existed, had been authored, and was silently not applied.
 *
 * ## The three `null`-grant rows are the regression fence
 *
 * `no_binding`, `draft` and `retired` must keep `grantedTools: null` and an
 * UNCLAMPED ceiling. That is the opt-out promise — a credential bound to no
 * agent is gated by its scopes and its principal exactly as it was before the
 * register existed — and a fix that reached into it would be the #2288
 * composition failure again. `unresolvable` sits with them by the same
 * argument: the register produced no row, so there is nothing to measure
 * against.
 *
 * ## Doubles
 *
 * Prisma is doubled down to the gate's two reads. `resolveAgentAuthority`,
 * `listGrantedToolNames` and `loadPolicyCardInForce` are doubled as MODULES
 * rather than as tables, because two of the three are asserted on as SPIES:
 * "the suspended agent's grant rows are intact and unread" is a decision, and
 * without `not.toHaveBeenCalled()` it is only a comment. `autonomy-ceiling.ts`
 * is NOT doubled — the ceiling arithmetic in Table B is the real function's.
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

// Only `resolveAgentAuthority` is replaced. `PrincipalUnresolvedError` is a
// real class `buildMcpInvocation` tests with `instanceof`, and the role/
// permission intersection helpers are real logic other importers rely on, so
// the rest of the module comes through untouched.
jest.mock('@/lib/agentic/agent-authority', () => {
    const actual = jest.requireActual('@/lib/agentic/agent-authority');
    return { ...actual, resolveAgentAuthority: jest.fn() };
});

jest.mock('@/lib/agentic/agent-tool-exposure', () => ({
    listGrantedToolNames: jest.fn(),
}));

jest.mock('@/lib/agentic/policy-card-store', () => ({
    loadPolicyCardInForce: jest.fn(),
    reserveDailyAction: jest.fn(),
    utcDay: (d: Date) => d.toISOString().slice(0, 10),
}));

import type { AgentRiskTier, AgentStatus } from '@prisma/client';

import prisma from '@/lib/prisma';
import { resolveAgentAuthority } from '@/lib/agentic/agent-authority';
import { listGrantedToolNames } from '@/lib/agentic/agent-tool-exposure';
import { loadPolicyCardInForce } from '@/lib/agentic/policy-card-store';
import {
    evaluateAgentRegistration,
    type AgentGateStanding,
} from '@/lib/agentic/agent-registration-gate';
import { buildMcpInvocation } from '@/lib/mcp/auth';
import type { McpInvocation } from '@/lib/mcp/authorize';
import { DENY_CEILING, UNCLAMPED } from '@/lib/agentic/autonomy-ceiling';
import { MAX_AUTONOMY_BY_TIER } from '@/lib/agentic/agent-risk-scoring';
import type { AgentPolicyCardValue } from '@/lib/agentic/policy-card';
import type { PolicyCardInForce } from '@/lib/agentic/policy-card-evaluation';
import { getPermissionsForRole } from '@/lib/permissions';
import { makeRequestContext } from '../helpers/make-context';

const settingsRead = (prisma as any).tenantSecuritySettings.findUnique as jest.Mock;
const agentRead = (prisma as any).registeredAgent.findFirst as jest.Mock;
const authority = resolveAgentAuthority as unknown as jest.Mock;
const grantsRead = listGrantedToolNames as unknown as jest.Mock;
const cardRead = loadPolicyCardInForce as unknown as jest.Mock;

const TENANT = 'tenant-1';
/** `A` in the brief's table. */
const AGENT = 'agent-A';
const SURFACE = { method: 'POST', path: '/api/mcp' } as const;
/** The one tool this agent is granted, for the vouched row. */
const GRANTED_TOOL = 'list_risks';

/**
 * The brief's fixture: key max NULL, registered rung 3, tier CRITICAL. Chosen
 * because CRITICAL's cap (1) is BELOW the registered rung (3), so the tier term
 * is the binding one and a ceiling that came out as 3 would prove the tier term
 * had gone missing rather than merely the agent one.
 */
const REGISTERED_RUNG = 3;
const TIER: AgentRiskTier = 'CRITICAL';
/** 1. Read from the scorer rather than typed, so a re-tuned cap moves with it. */
const TIER_CAP = MAX_AUTONOMY_BY_TIER[TIER];

/** A card wide open on every dimension — it is loaded-or-not that is under test. */
const CARD: PolicyCardInForce = (() => {
    const value: AgentPolicyCardValue = {
        permittedTools: [GRANTED_TOOL],
        maxDataScope: 'EXTERNAL_EGRESS',
        maxAutonomyLevel: 6,
        maxActionsPerRun: 1000,
        maxActionsPerDay: 1000,
        escalationTriggers: [],
        approvalRung: 'SINGLE_APPROVER',
    };
    return { cardId: 'card-1', version: 7, value };
})();

type AgentRow = {
    id: string;
    status: AgentStatus;
    autonomyLevel: number | null;
    riskTier: AgentRiskTier | null;
} | null;

function rowAt(status: AgentStatus, riskTier: AgentRiskTier | null = TIER): AgentRow {
    return { id: AGENT, status, autonomyLevel: REGISTERED_RUNG, riskTier };
}

/** The seven fields Table B compares as one object. */
interface Assembled {
    agentId: string | null;
    governedAgentId: string | null;
    agentStanding: AgentGateStanding;
    grantedTools: ReadonlySet<string> | null;
    autonomyCeiling: number;
    policyCard: McpInvocation['policyCard'];
    riskTier: AgentRiskTier | null;
}

function assembledOf(inv: McpInvocation): Assembled {
    return {
        agentId: inv.agentId,
        governedAgentId: inv.governedAgentId,
        agentStanding: inv.agentStanding,
        grantedTools: inv.grantedTools,
        autonomyCeiling: inv.autonomyCeiling,
        policyCard: inv.policyCard,
        riskTier: inv.riskTier,
    };
}

interface Row {
    label: string;
    standing: AgentGateStanding;
    bound: boolean;
    row: AgentRow;
    expect: Assembled;
    /** Whether `RegisteredAgentTool` should have been read at all. */
    grantsConsulted: boolean;
    /** Whether the policy card should have been loaded, and for which agent. */
    cardLoadedFor: string | null;
}

/** The invocation shape every non-governing standing must produce. */
function ungoverned(standing: AgentGateStanding): Assembled {
    return {
        agentId: null,
        governedAgentId: null,
        agentStanding: standing,
        // `null`, not empty. There is no list to consult, and reading this as
        // deny-all would mean turning the register off turns MCP off.
        grantedTools: null,
        // UNCLAMPED, and correct: no agent contributes no term, and a key with
        // no `maxAutonomyLevel` contributes none either.
        autonomyCeiling: UNCLAMPED,
        policyCard: null,
        riskTier: null,
    };
}

const TABLE_B: readonly Row[] = [
    {
        label: 'no_binding',
        standing: 'no_binding',
        bound: false,
        row: null,
        expect: ungoverned('no_binding'),
        grantsConsulted: false,
        cardLoadedFor: null,
    },
    {
        label: 'unresolvable',
        standing: 'unresolvable',
        bound: true,
        row: null,
        expect: ungoverned('unresolvable'),
        grantsConsulted: false,
        cardLoadedFor: null,
    },
    {
        label: 'draft',
        standing: 'draft',
        bound: true,
        row: rowAt('DRAFT'),
        expect: ungoverned('draft'),
        grantsConsulted: false,
        cardLoadedFor: null,
    },
    {
        label: 'suspended',
        standing: 'suspended',
        bound: true,
        row: rowAt('SUSPENDED'),
        expect: {
            agentId: null,
            // Present while `agentId` is null. The whole of #2399 in one pair.
            governedAgentId: AGENT,
            agentStanding: 'suspended',
            // EMPTY, not null. Empty denies every tool; null would admit the
            // whole catalogue.
            grantedTools: new Set<string>(),
            // min(null, 3, CRITICAL cap 1) = 1. Was `min([UNCLAMPED])` = 6.
            autonomyCeiling: TIER_CAP,
            policyCard: { inForce: CARD, actionsThisRun: 0 },
            riskTier: TIER,
        },
        // The refusal is about the agent's STANDING, not about its grants.
        // Consulting the rows would make a stopped agent's reach depend on a
        // list again — the thing the operator just overrode.
        grantsConsulted: false,
        cardLoadedFor: AGENT,
    },
    {
        label: 'suspended, unscored',
        standing: 'suspended',
        bound: true,
        row: rowAt('SUSPENDED', null),
        expect: {
            agentId: null,
            governedAgentId: AGENT,
            agentStanding: 'suspended',
            grantedTools: new Set<string>(),
            // A governed agent nobody assessed DENIES. `riskTierCeilingFor` is
            // handed `{ riskTier: null }` — an object, not a bare null — which
            // is what keeps "no agent" and "unscored agent" from resolving to
            // the same number.
            autonomyCeiling: DENY_CEILING,
            policyCard: { inForce: CARD, actionsThisRun: 0 },
            riskTier: null,
        },
        grantsConsulted: false,
        cardLoadedFor: AGENT,
    },
    {
        // NOT in the brief's Table B, and added deliberately. `unknown_status`
        // is unrepresentable in the Prisma enum, so Table A reaches it by a
        // cast and stops at `governedAgentIdOf`. But "an unknown status is
        // CONTAINED, not admitted" is a claim about the ASSEMBLED invocation —
        // empty grants, ceiling restored, card applied — and this is the only
        // table where that is observable. The fail direction matches
        // `ceilingForRiskTier`'s for a tier this build does not recognise.
        label: 'unknown_status',
        standing: 'unknown_status',
        bound: true,
        row: rowAt('ARCHIVED' as AgentStatus),
        expect: {
            agentId: null,
            governedAgentId: AGENT,
            agentStanding: 'unknown_status',
            grantedTools: new Set<string>(),
            autonomyCeiling: TIER_CAP,
            policyCard: { inForce: CARD, actionsThisRun: 0 },
            riskTier: TIER,
        },
        grantsConsulted: false,
        cardLoadedFor: AGENT,
    },
    {
        label: 'retired',
        standing: 'retired',
        bound: true,
        row: rowAt('RETIRED'),
        expect: ungoverned('retired'),
        grantsConsulted: false,
        cardLoadedFor: null,
    },
    {
        label: 'vouched',
        standing: 'vouched',
        bound: true,
        row: rowAt('ACTIVE'),
        expect: {
            agentId: AGENT,
            governedAgentId: AGENT,
            agentStanding: 'vouched',
            grantedTools: new Set([GRANTED_TOOL]),
            autonomyCeiling: TIER_CAP,
            policyCard: { inForce: CARD, actionsThisRun: 0 },
            riskTier: TIER,
        },
        // The paired positive. Without it, "not read for suspended" would be
        // satisfied by a build that never reads the grants at all.
        grantsConsulted: true,
        cardLoadedFor: AGENT,
    },
];

function keyContext(bound: boolean) {
    return makeRequestContext('OWNER', {
        tenantId: TENANT,
        userId: 'user-1',
        apiKeyId: 'key-1',
        apiKeyScopes: ['mcp:read', 'mcp:propose'],
        // NULL key ceiling — no key-level narrowing, which is the fixture the
        // brief names and the one the falsified premise in
        // `autonomy-ceiling.ts` was written about.
        apiKeyMaxAutonomy: null,
        ...(bound ? { agentId: AGENT } : {}),
    });
}

/** Assemble one row through the real gate and the real builder. */
async function assemble(row: Row, enforcing = false): Promise<McpInvocation> {
    settingsRead.mockResolvedValue({ requireRegisteredAgent: enforcing });
    agentRead.mockResolvedValue(row.row);
    const keyCtx = keyContext(row.bound);
    authority.mockResolvedValue({
        ctx: keyCtx,
        principal: {
            userId: keyCtx.userId,
            role: 'OWNER',
            appPermissions: getPermissionsForRole('OWNER'),
            permissions: keyCtx.permissions,
        },
    });
    grantsRead.mockResolvedValue(new Set([GRANTED_TOOL]));
    cardRead.mockResolvedValue(CARD);
    const verdict = await evaluateAgentRegistration(keyCtx);
    return buildMcpInvocation(keyCtx, verdict, SURFACE);
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('Table B — the assembled invocation, per standing', () => {
    describe.each(TABLE_B.map((r) => [r.label, r] as const))('%s', (_label, row) => {
        it('assembles exactly the seven fields Table B names', async () => {
            const inv = await assemble(row);
            // One `toEqual` over the seven together. Field-by-field would let
            // the ceiling regress to UNCLAMPED behind a correct
            // `governedAgentId`, which is the pair that has to move together.
            expect(assembledOf(inv)).toEqual(row.expect);
        });

        it('reads `RegisteredAgentTool` only for the agent the register vouches for', async () => {
            await assemble(row);
            if (row.grantsConsulted) {
                expect(grantsRead).toHaveBeenCalledWith(TENANT, AGENT);
            } else {
                expect(grantsRead).not.toHaveBeenCalled();
            }
        });

        it('loads the policy card for the GOVERNED agent, or not at all', async () => {
            await assemble(row);
            if (row.cardLoadedFor === null) {
                expect(cardRead).not.toHaveBeenCalled();
            } else {
                expect(cardRead).toHaveBeenCalledWith(TENANT, row.cardLoadedFor);
            }
        });

        it('assembles identically whether or not the tenant enforces', async () => {
            const off = assembledOf(await assemble(row, false));
            const on = assembledOf(await assemble(row, true));
            // `reason` is the only field enforcement moves, and
            // `buildMcpInvocation` never reads it. If assembly ever became
            // conditional on the flag, the engine path — which uses the
            // non-throwing evaluator in EVERY tenant — would go back to being
            // as wide as #2399 found it.
            expect(on).toEqual(off);
        });
    });
});

describe('the suspended row, stated as the properties it has to hold', () => {
    const suspended = TABLE_B.find((r) => r.label === 'suspended')!;
    const vouched = TABLE_B.find((r) => r.label === 'vouched')!;

    it('grantedTools is an empty Set — present and empty, not absent', async () => {
        const inv = await assemble(suspended);
        // Three separate claims, because `null` passes a `.size === 0` test by
        // throwing and passes `!grantedTools` by being falsy.
        expect(inv.grantedTools).not.toBeNull();
        expect(inv.grantedTools).toBeInstanceOf(Set);
        expect(inv.grantedTools?.size).toBe(0);
        expect(inv.grantedTools?.has(GRANTED_TOOL)).toBe(false);
    });

    it('the ceiling is the same one the agent had while ACTIVE, not UNCLAMPED', async () => {
        const stopped = await assemble(suspended);
        const active = await assemble(vouched);
        expect(stopped.autonomyCeiling).toBe(active.autonomyCeiling);
        // The regression this pins: UNCLAMPED (6) is strictly above what any
        // tier can reach, so suspension used to promote a CRITICAL agent from
        // read-only to propose-capable.
        expect(stopped.autonomyCeiling).toBeLessThan(UNCLAMPED);
        expect(stopped.autonomyCeiling).toBe(TIER_CAP);
    });

    it('carries the tier so a refusal can name the term that is binding', async () => {
        const inv = await assemble(suspended);
        // A denial reading `ceiling: 1` with no tier beside it sends an
        // operator to the agent's autonomy level, which is not what refused.
        expect(inv.riskTier).toBe(TIER);
    });

    it('applies the card that was authored for it', async () => {
        const inv = await assemble(suspended);
        expect(inv.policyCard).not.toBeNull();
        expect(inv.policyCard?.inForce.version).toBe(CARD.version);
        // Seeded from the run's own step count, so a resumed segment does not
        // get a fresh per-run budget.
        expect(inv.policyCard?.actionsThisRun).toBe(0);
    });

    it('is NOT the same shape as a caller bound to no agent', async () => {
        const stopped = assembledOf(await assemble(suspended));
        const unbound = assembledOf(await assemble(TABLE_B[0]));
        // The four-identical-nulls collapse, asserted as an inequality. This is
        // the one assertion in the file that fails for ANY re-collapse of the
        // two questions, whichever field carries it.
        expect(stopped).not.toEqual(unbound);
        expect(unbound.grantedTools).toBeNull();
        expect(stopped.grantedTools).not.toBeNull();
    });
});

/**
 * The ceiling is a `min` over THREE terms and two of them are agent-side. Table
 * B's own fixture cannot tell them apart: with CRITICAL (cap 1) beside a
 * registered rung of 3 the tier term is strictly lower, so it dominates the
 * `min` and a build that restored ONLY the tier term still produces 1. Proved
 * by hand — reverting `agentAutonomy` to the vouched id alone left all 42 of
 * this file's other tests green.
 *
 * So each agent-side term gets a fixture in which IT is the binding one. That
 * is the only arrangement in which "both terms are present" is an assertion
 * rather than an arithmetic coincidence.
 */
describe('both agent-side ceiling terms reach a suspended agent, proved separately', () => {
    async function ceilingFor(rung: number, tier: AgentRiskTier | null): Promise<number> {
        settingsRead.mockResolvedValue({ requireRegisteredAgent: false });
        agentRead.mockResolvedValue({
            id: AGENT,
            status: 'SUSPENDED' as AgentStatus,
            autonomyLevel: rung,
            riskTier: tier,
        });
        const keyCtx = keyContext(true);
        authority.mockResolvedValue({
            ctx: keyCtx,
            principal: {
                userId: keyCtx.userId,
                role: 'OWNER',
                appPermissions: getPermissionsForRole('OWNER'),
                permissions: keyCtx.permissions,
            },
        });
        grantsRead.mockResolvedValue(new Set([GRANTED_TOOL]));
        cardRead.mockResolvedValue(CARD);
        const verdict = await evaluateAgentRegistration(keyCtx);
        const inv = await buildMcpInvocation(keyCtx, verdict, SURFACE);
        return inv.autonomyCeiling;
    }

    it('the REGISTERED RUNG binds when it is below the tier cap', async () => {
        // LOW caps at 4; the rung is 2. A build that keyed the rung term off
        // the vouched id would drop it and land on the tier cap, 4.
        expect(MAX_AUTONOMY_BY_TIER.LOW).toBeGreaterThan(2);
        expect(await ceilingFor(2, 'LOW')).toBe(2);
    });

    it('the TIER CAP binds when it is below the registered rung', async () => {
        // CRITICAL caps at 1; the rung is 3. A build that keyed the tier term
        // off the vouched id would drop it and land on the rung, 3.
        expect(MAX_AUTONOMY_BY_TIER.CRITICAL).toBeLessThan(REGISTERED_RUNG);
        expect(await ceilingFor(REGISTERED_RUNG, 'CRITICAL')).toBe(
            MAX_AUTONOMY_BY_TIER.CRITICAL,
        );
    });

    it('an UNSCORED tier denies whatever the registered rung says', async () => {
        // The two nulls that must resolve to opposite ceilings. Rung 6 is the
        // top of the ladder, so nothing but the tier term can produce -1.
        expect(await ceilingFor(6, null)).toBe(DENY_CEILING);
    });
});

describe('the opt-out promise — the rows that must NOT narrow', () => {
    const ungovernedRows = TABLE_B.filter((r) => r.expect.governedAgentId === null);

    it('covers no_binding, unresolvable, draft and retired', () => {
        expect(ungovernedRows.map((r) => r.label)).toEqual([
            'no_binding',
            'unresolvable',
            'draft',
            'retired',
        ]);
    });

    it.each(ungovernedRows.map((r) => [r.label, r] as const))(
        '%s: null grants, UNCLAMPED ceiling, no card, no tier',
        async (_label, row) => {
            const inv = await assemble(row);
            // Stated four times rather than by object compare so a reader can
            // see WHICH promise each field is: `null` grants is the exposure
            // opt-out, UNCLAMPED is the ceiling opt-out, and the two are
            // argued separately in `agent-tool-exposure.ts` and
            // `autonomy-ceiling.ts`.
            expect(inv.grantedTools).toBeNull();
            expect(inv.autonomyCeiling).toBe(UNCLAMPED);
            expect(inv.policyCard).toBeNull();
            expect(inv.riskTier).toBeNull();
        },
    );
});
