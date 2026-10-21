/**
 * WHICH AGENT ANSWERS A PERSON'S QUESTION, AND THE NAMED REASON WHEN NONE DOES
 * (#3868 step 2).
 *
 * ADR 0004 decided a session binds the tenant's DESIGNATED interactive agent.
 * This covers the resolution: the designation, the two gates around it, and the
 * two checks `startWorkflowRun` does not make.
 *
 * ## Why each refusal is asserted BY NAME rather than as a rejection
 *
 * Every one of these is a different thing for an operator to do — turn a flag
 * on, designate an agent, re-designate after a retirement, lift a kill switch,
 * reset a breaker. A test that only asserted "it refused" would pass for a
 * single uniform failure, which is the shape that makes production logs name
 * nothing. So each case pins the code.
 *
 * ## Mutation proof (2026-10-22), because green proves nothing
 *
 * Three claims this file makes were broken at the source, and each failed:
 *
 *   remove the kill-switch check          -> 1 failed. A killed agent resolves
 *                                            and answers questions. This is the
 *                                            defect the module exists for:
 *                                            `startWorkflowRun` does not make
 *                                            this check.
 *   drop `tenantId` from the designation  -> 10 failed. The isolation property
 *     lookup                                 is covered by the read assertions
 *                                            rather than by one case.
 *   drop `actorType !== 'JOB'` from       -> 1 failed. The term that looks
 *     `isPersonContext`                      redundant beside the other two is
 *                                            not: a job carries a real
 *                                            person's permissions by design,
 *                                            so `userId` is set and both other
 *                                            terms pass.
 *
 * ## The ordering cases are not stylistic
 *
 * Two assertions are about what a caller LEARNS, not whether it is refused: a
 * machine caller must be turned away before it can discover whether the feature
 * is enabled or which agent is designated. Those are checked by asserting the
 * database was never read, which is the only way to tell "refused first" from
 * "refused eventually".
 */
import { makeRequestContext } from '../helpers/make-context';

const TENANT = 'tenant-interactive';
const OTHER_TENANT = 'tenant-other';
const AGENT = 'agent-designated';

const mockEnv: { AGENT_INTERACTIVE_RUNS?: string } = {};

/** Every database read the resolver makes, so "refused before reading" is checkable. */
const reads: string[] = [];

let designation: string | null = null;
/** Agents that exist, as `${tenantId}:${agentId}` — so a cross-tenant id simply is not here. */
let agentRows: string[] = [];
let killVerdict: { scope: string } | null = null;
let breakerLatch: { state: string } | null = null;

jest.mock('@/env', () => ({ env: mockEnv }));

jest.mock('@/lib/db-context', () => ({
    // The reads go through `runInTenantContext`, so RLS binds the tenant per
    // transaction and this double stands in for the bound client. Mocking the
    // SEAM the usecase actually uses, rather than `@/lib/prisma`, is what
    // `no-direct-prisma` pushed the usecase towards — and the test has to
    // follow, or it would be doubling a module the code no longer imports.
    runInTenantContext: (_ctx: unknown, cb: (db: unknown) => unknown) =>
        cb({
            tenantSecuritySettings: {
                findUnique: async (args: { where: { tenantId: string } }) => {
                    reads.push(`settings:${args.where.tenantId}`);
                    return { interactiveAgentId: designation };
                },
            },
            registeredAgent: {
                findFirst: async (args: { where: { id: string; tenantId: string } }) => {
                    reads.push(`agent:${args.where.tenantId}:${args.where.id}`);
                    // The double honours the tenant scope rather than ignoring
                    // it — one that returned the row regardless would make the
                    // isolation assertion pass while proving nothing. (RLS is
                    // the real second layer in production; this stands in for
                    // the application filter the predicate still carries.)
                    return agentRows.includes(`${args.where.tenantId}:${args.where.id}`)
                        ? { id: args.where.id }
                        : null;
                },
            },
        }),
}));

jest.mock('@/lib/agentic/kill-switch', () => ({
    resolveKillState: jest.fn(async (tenantId: string, agentId: string) => {
        reads.push(`kill:${tenantId}:${agentId}`);
        return killVerdict;
    }),
}));

jest.mock('@/lib/agentic/circuit-breaker-store', () => ({
    readBreakerLatch: jest.fn(async (tenantId: string, agentId: string) => {
        reads.push(`breaker:${tenantId}:${agentId}`);
        return breakerLatch;
    }),
}));

import {
    resolveInteractiveAgent,
    interactiveRunContext,
    INTERACTIVE_RUN_REFUSALS,
} from '@/app-layer/usecases/interactive-agent-runs';

beforeEach(() => {
    reads.length = 0;
    mockEnv.AGENT_INTERACTIVE_RUNS = '1';
    designation = AGENT;
    agentRows = [`${TENANT}:${AGENT}`];
    killVerdict = null;
    breakerLatch = null;
});

describe('the happy path, so every refusal below means something', () => {
    it('resolves the tenant designated agent for a signed-in person', async () => {
        const out = await resolveInteractiveAgent(makeRequestContext('READER', { tenantId: TENANT }));
        expect(out).toEqual({ ok: true, agentId: AGENT });
    });

    it('a READER resolves it — the gate here is not a permission check', async () => {
        // Deliberate: WHO may ask is not decided here. Step 1 proved the
        // answer cannot exceed the asker's own reach, so admitting a READER is
        // the behaviour, not a hole. A resolver that refused low roles would
        // make the feature admin-only for no stated reason.
        const reader = await resolveInteractiveAgent(makeRequestContext('READER', { tenantId: TENANT }));
        const owner = await resolveInteractiveAgent(makeRequestContext('OWNER', { tenantId: TENANT }));
        expect([reader.ok, owner.ok]).toEqual([true, true]);
    });
});

describe('a machine caller is refused BEFORE it learns anything', () => {
    // The three terms of `isPersonContext`, each on its own, because none is
    // redundant and the third is the one most easily dropped as looking so.
    it.each([
        ['an API key', { apiKeyId: 'key-1' }],
        ['a bound agent', { agentId: 'some-other-agent' }],
        ['a scheduled job', { actorType: 'JOB' as const }],
    ])('refuses %s with NOT_A_PERSON, having read nothing', async (_label, over) => {
        const out = await resolveInteractiveAgent(
            makeRequestContext('OWNER', { tenantId: TENANT, ...(over as Record<string, unknown>) }),
        );
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.refusal).toBe('NOT_A_PERSON');
        // THE ORDERING ASSERTION. A machine caller must not discover whether
        // the feature is enabled or which agent is designated, and "refused
        // first" is only distinguishable from "refused eventually" by this.
        expect(reads).toEqual([]);
    });
});

describe('the two halves of the gate, each named separately', () => {
    it('DEPLOYMENT_NOT_ENABLED when the flag is unset, before any read', async () => {
        delete mockEnv.AGENT_INTERACTIVE_RUNS;
        const out = await resolveInteractiveAgent(makeRequestContext('OWNER', { tenantId: TENANT }));
        if (!out.ok) expect(out.refusal).toBe('DEPLOYMENT_NOT_ENABLED');
        expect(reads).toEqual([]);
    });

    it.each([['yes'], ['on'], ['TRUE-ish'], ['0'], ['']])(
        'treats AGENT_INTERACTIVE_RUNS=%p as OFF rather than failing to boot',
        async (raw) => {
            // The strictness lives at the READ, so a typo in a feature flag is
            // "off" and not an outage. `TRUE-ish` is included because a
            // substring match on 'true' would admit it.
            mockEnv.AGENT_INTERACTIVE_RUNS = raw;
            const out = await resolveInteractiveAgent(makeRequestContext('OWNER', { tenantId: TENANT }));
            expect(out.ok).toBe(false);
            if (!out.ok) expect(out.refusal).toBe('DEPLOYMENT_NOT_ENABLED');
        },
    );

    it.each([['1'], ['true'], ['TRUE'], [' true ']])('and %p as ON', async (raw) => {
        mockEnv.AGENT_INTERACTIVE_RUNS = raw;
        const out = await resolveInteractiveAgent(makeRequestContext('OWNER', { tenantId: TENANT }));
        expect(out.ok).toBe(true);
    });

    it('NO_AGENT_DESIGNATED is a refusal, never a fallback to "the only agent"', async () => {
        designation = null;
        // The agent EXISTS and is the only one — the tempting default. It is
        // still refused, because a default would change which agent answers
        // the moment a tenant registers a second one.
        agentRows = [`${TENANT}:${AGENT}`];
        const out = await resolveInteractiveAgent(makeRequestContext('OWNER', { tenantId: TENANT }));
        if (!out.ok) expect(out.refusal).toBe('NO_AGENT_DESIGNATED');
        expect(reads).toEqual([`settings:${TENANT}`]);
    });
});

describe('the designation is resolved inside the tenant', () => {
    it('AGENT_NOT_FOUND when the designation names an agent of ANOTHER tenant', async () => {
        // TENANT ISOLATION, and the reason the existence check is not a
        // duplicate of the Flue gate: a cross-tenant id reaching
        // `resolveKillState` would find no kill row for it and PASS.
        agentRows = [`${OTHER_TENANT}:${AGENT}`];
        const out = await resolveInteractiveAgent(makeRequestContext('OWNER', { tenantId: TENANT }));
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.refusal).toBe('AGENT_NOT_FOUND');
        // And it stopped: neither the kill switch nor the breaker was consulted
        // for an agent this tenant does not hold.
        expect(reads.filter((r) => r.startsWith('kill:') || r.startsWith('breaker:'))).toEqual([]);
    });

    it('scopes the lookup on this tenant, not on the id alone', async () => {
        await resolveInteractiveAgent(makeRequestContext('OWNER', { tenantId: TENANT }));
        expect(reads).toContain(`agent:${TENANT}:${AGENT}`);
    });
});

describe('the checks startWorkflowRun does NOT make', () => {
    it('AGENT_KILL_SWITCHED, named with the scope, before any run row exists', async () => {
        killVerdict = { scope: 'AGENT' };
        const out = await resolveInteractiveAgent(makeRequestContext('OWNER', { tenantId: TENANT }));
        expect(out.ok).toBe(false);
        if (!out.ok) {
            expect(out.refusal).toBe('AGENT_KILL_SWITCHED');
            // The scope reaches the operator: a TENANT-wide kill and an
            // agent-scoped one are different things to go and look at.
            expect(out.detail).toContain('AGENT');
        }
        // The breaker was not consulted after a kill — a killed agent is
        // already refused, and the second read would be for nothing.
        expect(reads.filter((r) => r.startsWith('breaker:'))).toEqual([]);
    });

    it('AGENT_BREAKER_LATCHED only on OPEN — an unobserved breaker is not a refusal', async () => {
        breakerLatch = { state: 'OPEN' };
        const open = await resolveInteractiveAgent(makeRequestContext('OWNER', { tenantId: TENANT }));
        expect(open.ok).toBe(false);
        if (!open.ok) expect(open.refusal).toBe('AGENT_BREAKER_LATCHED');

        // `null` is an agent the breaker has never observed, and CLOSED is one
        // it has. Neither refuses. Asserted because treating absence as the
        // alarming state would refuse every agent that has never run.
        breakerLatch = null;
        expect((await resolveInteractiveAgent(makeRequestContext('OWNER', { tenantId: TENANT }))).ok).toBe(true);
        breakerLatch = { state: 'CLOSED' };
        expect((await resolveInteractiveAgent(makeRequestContext('OWNER', { tenantId: TENANT }))).ok).toBe(true);
    });

    it('asks BOTH, in order, on the happy path', async () => {
        // The point of the whole module: `startWorkflowRun` checks neither, so
        // if these two reads stop happening a killed agent answers questions.
        await resolveInteractiveAgent(makeRequestContext('OWNER', { tenantId: TENANT }));
        expect(reads).toEqual([
            `settings:${TENANT}`,
            `agent:${TENANT}:${AGENT}`,
            `kill:${TENANT}:${AGENT}`,
            `breaker:${TENANT}:${AGENT}`,
        ]);
    });
});

describe('the run context binds the agent and changes nothing else', () => {
    it('keeps the asker role and permissions — the invariant rests on this', async () => {
        const ctx = makeRequestContext('READER', { tenantId: TENANT, userId: 'user-1' });
        const bound = interactiveRunContext(ctx, AGENT);
        expect(bound.agentId).toBe(AGENT);
        expect(bound.role).toBe(ctx.role);
        expect(bound.appPermissions).toBe(ctx.appPermissions);
        expect(bound.permissions).toBe(ctx.permissions);
        expect(bound.userId).toBe('user-1');
    });

    it('does NOT stamp actorType JOB, because a person really did act', async () => {
        // A job writes JOB so the trail does not claim a person did something
        // no person did. Here a person DID, so the trail carries the person AND
        // the agent, and neither field substitutes for the other.
        const ctx = makeRequestContext('EDITOR', { tenantId: TENANT, userId: 'user-2' });
        const bound = interactiveRunContext(ctx, AGENT);
        expect(bound.actorType).not.toBe('JOB');
    });

    it('does NOT invent an apiKeyId, which would start the intersection', async () => {
        // Step 1 proved a session is its own principal precisely because
        // `buildMcpInvocation` intersects only `if (keyCtx.apiKeyId)`. Setting
        // one here would start the narrowing that proof depends on being absent.
        const bound = interactiveRunContext(makeRequestContext('OWNER', { tenantId: TENANT }), AGENT);
        expect(bound.apiKeyId).toBeUndefined();
    });
});

describe('the audit row carries BOTH the person and the agent', () => {
    /**
     * #3868 step 2 asks for this, and it already holds — which is worth a test
     * rather than a shrug, because it holds by DERIVATION from the context this
     * module builds, and the derivation is three separate reads that could each
     * change without anyone connecting them to this path.
     *
     * `AuditLog` has no `agentId` column, so "both" means:
     *
     *   the person   `userId`                   <- ctx.userId
     *   the actor    `actorType`                <- ctx.apiKeyId ? API_KEY : USER
     *   the agent    `detailsJson.agentId`      <- ctx.agentId
     *
     * Hash-chain validity is NOT re-proved here. It is `appendAuditEntry`'s own
     * invariant, held by the integration suites that exercise the real writer;
     * asserting it against a double would prove something about the double.
     */
    const runsSource = (): string =>
        require('node:fs').readFileSync(
            require('node:path').join(__dirname, '../../src/app-layer/usecases/workflow-runs.ts'),
            'utf8',
        ) as string;

    /** Just the WORKFLOW_RUN_STARTED entry, so a neighbouring row cannot satisfy this. */
    const startedEntry = (): string => {
        const src = runsSource();
        const at = src.indexOf("action: 'WORKFLOW_RUN_STARTED'");
        expect(at).toBeGreaterThan(-1);
        // Bounded both ways around the action, because the fields sit above it
        // and `detailsJson` below — an unbounded read would let any other audit
        // call in this large file satisfy the assertions.
        return src.slice(Math.max(0, at - 400), at + 900);
    };

    it('derives the PERSON from the context, not from a lookup', async () => {
        expect(startedEntry()).toContain('userId: ctx.userId');
    });

    it('derives the AGENT from the context, and records null rather than omitting it', async () => {
        // `?? null` matters: an omitted key and an explicit null are different
        // facts in a JSON column, and "no agent" has to be stated for a
        // person-started run to be distinguishable from an older row.
        expect(startedEntry()).toContain('agentId: ctx.agentId ?? null');
    });

    it('stamps USER for a session, because apiKeyId is what selects API_KEY', async () => {
        expect(startedEntry()).toContain("actorType: ctx.apiKeyId ? 'API_KEY' : 'USER'");
        // And the interactive context never sets apiKeyId, so this resolves to
        // USER — asserted on the context rather than inferred, which is the
        // half that ties the source read above to this path.
        const bound = interactiveRunContext(makeRequestContext('READER', { tenantId: TENANT }), AGENT);
        expect(bound.apiKeyId).toBeUndefined();
        expect(bound.agentId).toBe(AGENT);
    });

    it('and the trail is not asked to claim a job did it', async () => {
        // A job stamps actorType JOB so the trail does not claim a person acted.
        // Here a person DID, so both facts are present and neither substitutes
        // for the other — the distinction ADR 0004 records.
        const bound = interactiveRunContext(makeRequestContext('EDITOR', { tenantId: TENANT }), AGENT);
        expect(bound.actorType).not.toBe('JOB');
    });
});

describe('the refusal vocabulary is closed', () => {
    it('every declared refusal is distinct, so no two causes share a code', () => {
        expect(new Set(INTERACTIVE_RUN_REFUSALS).size).toBe(INTERACTIVE_RUN_REFUSALS.length);
    });

    it('and every test in this file asserts something', () => {
        // The vacuous-test check this suite earned in step 1: an `it` with no
        // `expect` passes forever and reads as coverage.
        const src = require('node:fs').readFileSync(__filename, 'utf8') as string;
        const bodies = src.split(/\n    it(?:\.each\([^)]*\))?\(/).slice(1);
        expect(bodies.length).toBeGreaterThan(10);
        for (const b of bodies) expect(b.slice(0, 2000)).toContain('expect(');
    });
});
