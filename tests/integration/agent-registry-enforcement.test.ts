/**
 * The agent-registration gate, both directions, against the real MCP route.
 *
 * The register only means something if something consults it. This is that
 * something: with `TenantSecuritySettings.requireRegisteredAgent` on, a
 * credential that does not name an ACTIVE `RegisteredAgent` cannot reach
 * `/api/mcp` at all — and the refusal lands in the hash-chained audit trail as
 * `AUTHZ_DENIED`, which is what makes it reviewable rather than merely
 * effective.
 *
 * ── What is asserted, and why the 403 alone is not enough ────────────
 *
 * A test that only checked the status code would pass against a gate that
 * refused and recorded nothing — and an unrecorded refusal is exactly the
 * failure mode this repo has written down twice already (the legacy
 * `requireAdminCtx` helpers threw a 403 and wrote no `AUTHZ_DENIED` row, and
 * the whole of Epic D.3 was undoing that). So every refusal below is checked
 * against the AuditLog ROW: its action, its category, the reason, the api key
 * it names — and its place in the chain, because a row whose `previousHash`
 * does not match its predecessor's `entryHash` is not evidence of anything.
 *
 * ── The SEVEN standings a credential can resolve to ──────────────────
 *
 * This table said "four states" and named the enforcement flag as the only
 * axis. That was #2399 written down as a design. The register answers with one
 * of SEVEN standings, and the flag decides only whether the gate REFUSES —
 * never what the standing is, and never which of the agent's own controls apply
 * afterwards. `AgentGateStanding` is set unconditionally for exactly that
 * reason; `reason` is null in a non-enforcing tenant by design, which is
 * precisely the tenant where the situations most need telling apart.
 *
 *   standing         gate ON            gate OFF (and the engine path, always)
 *   ─────────────────────────────────────────────────────────────────────────
 *   no_binding       REFUSED            allowed, no agent-keyed control applies
 *   unresolvable     REFUSED            allowed, no agent-keyed control applies
 *   draft            REFUSED            allowed — unreachable by any supported
 *                                       path, so unchanged deliberately
 *   suspended        REFUSED            EVERY TOOL REFUSED (`agent_suspended`),
 *                                       and its kill switch, breaker, autonomy
 *                                       ceiling and policy card all apply
 *   retired          REFUSED            allowed — the open asymmetry, recorded
 *   unknown_status   REFUSED            governs; unrepresentable in the enum
 *   vouched          allowed            allowed
 *
 * ── What "suspended" now means, stated exactly ───────────────────────
 *
 * Every TOOL call is refused. The resources door is NARROWED, not closed: a
 * suspended agent that is scored, unkilled, unlatched and inside its card is
 * still served `inflect://frameworks` and this tenant's framework coverage.
 * The REST surface is unchanged — the register has never gated `/api/t/**`.
 * Not "deny-all", and no assertion in this file may be read as saying so; the
 * 200 on the resources door below is here to keep that impossible.
 *
 * The vouched rows are what keep the others honest: a gate that refused
 * everything would satisfy every refusal assertion in this file.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { generateApiKey } from '@/lib/auth/api-key-auth';
import { POST } from '@/app/api/mcp/route';
import { POST as START_RUN } from '@/app/api/t/[tenantSlug]/agent-runs/route';
import { createApiKey } from '@/app-layer/usecases/api-keys';
import { utcDay } from '@/lib/agentic/policy-card-store';
import { MCP_RESOURCES_AUDIENCE } from '@/lib/mcp/token-exchange';
import { windowKeyFor } from '@/lib/agentic/circuit-breaker';
import { makeRequestContext } from '../helpers/make-context';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const SUITE = `agate-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;

/** Bound to an ACTIVE agent. */
let keyActive = '';
/** Bound to a SUSPENDED agent — the kill switch. */
let keySuspended = '';
/** Bound to nothing — an ordinary integration key reaching the agent surface. */
let keyUnbound = '';

let activeAgentId = '';
let suspendedAgentId = '';

/**
 * A SECOND credential for the same suspended agent, scoped wide enough to reach
 * the two doors and the engine.
 *
 * `keySuspended` above carries only `mcp:read | mcp:propose | risks:read`, and
 * the cells below need `frameworks:read` (the resources door's own scope gate),
 * `controls:read` (the diagnostic workflow's tool) and `mcp:orchestrate` (which
 * is what `startWorkflowRun` requires of an API-key caller). Widening the
 * existing key instead would make the assertions above depend on scopes they
 * are not about.
 */
let keySuspendedWide = '';

async function mintKey(
    agentId: string | null,
    scopes: string[] = ['mcp:read', 'mcp:propose', 'risks:read'],
    name?: string,
): Promise<string> {
    const { plaintext, keyHash, keyPrefix } = generateApiKey();
    await prisma.tenantApiKey.create({
        data: {
            tenantId: TENANT,
            name: name ?? agentId ?? 'unbound',
            keyPrefix,
            keyHash,
            scopes,
            createdById: USER,
            agentId,
        },
    });
    return plaintext;
}

/** Create an AI-system register entry + the agent that links to it. */
async function seedAgent(name: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<string> {
    const aiSystem = await prisma.aiSystem.create({
        data: { tenantId: TENANT, name: `${name} host`, ownerUserId: USER },
    });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId: TENANT,
            aiSystemId: aiSystem.id,
            name,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: USER,
            status,
            // Scored LOW so the TIER term is never what refuses here — an
            // UNSCORED agent is denied every tool from Agentic 3/10, which
            // would make these assertions pass for the wrong reason. LOW leaves
            // the ladder whole, so the arithmetic below is unchanged.
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
    return agent.id;
}

async function setEnforcement(requireRegisteredAgent: boolean): Promise<void> {
    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId: TENANT },
        update: { requireRegisteredAgent },
        create: { tenantId: TENANT, requireRegisteredAgent },
    });
}

/** A minimal, valid MCP call: list the tools. Needs only `mcp:read`. */
async function callMcp(token: string): Promise<{ status: number; body: unknown }> {
    const req = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const res = await POST(req, { params: Promise.resolve({}) } as never);
    let body: unknown = null;
    try {
        body = await res.json();
    } catch {
        /* 202 / empty */
    }
    return { status: res.status, body };
}

/**
 * Any JSON-RPC method, through the real route.
 *
 * ── The status code, and why it is 200 for a refused tool call ──
 *
 * `/api/mcp` refuses in TWO PLACES with two different transports, and Table D
 * would be wrong about the fix if it conflated them.
 *
 *   • The REGISTRATION gate runs inside `authenticateMcpRequest`, ABOVE the
 *     JSON-RPC dispatch, so its refusal is a transport-level HTTP 403. That is
 *     every `flag ON` case above.
 *
 *   • The tool BOUNDARY (`authorizeToolCall`, which is where `agent_suspended`
 *     is raised) runs inside a handler. `route.ts` catches the thrown
 *     `forbidden` and maps it through `toRpcError` to an IN-BAND JSON-RPC error
 *     at HTTP **200**, deliberately, so a refused call does not tear down the
 *     client's MCP session.
 *
 * So the cells below assert the JSON-RPC error and the audit row, not a 403.
 * The refusal is no weaker for it — the audit row is the same hash-chained
 * `AUTHZ_DENIED` row a 403 writes — but a test that demanded 403 here would
 * fail against correct code, and one that asserted only `status !== 200` would
 * pass against a route that had stopped refusing at all.
 */
async function callRpc(
    token: string,
    method: string,
    params?: Record<string, unknown>,
): Promise<{ status: number; body: RpcBody }> {
    const req = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 11, method, ...(params ? { params } : {}) }),
    });
    const res = await POST(req, { params: Promise.resolve({}) } as never);
    let body: RpcBody = {};
    try {
        body = (await res.json()) as RpcBody;
    } catch {
        /* 202 / empty */
    }
    return { status: res.status, body };
}

interface RpcBody {
    result?: { tools?: unknown[]; contents?: { uri: string; text: string }[] };
    error?: { code: number; message: string };
}

/** `POST /api/t/:slug/agent-runs` — the workflow-engine path, which never runs the gate. */
async function startRun(token: string, workflowKey: string) {
    const req = new NextRequest(`http://localhost/api/t/${TENANT}/agent-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ workflowKey }),
    });
    const res = await START_RUN(req, {
        params: Promise.resolve({ tenantSlug: TENANT }),
    } as never);
    let body: Record<string, unknown> = {};
    try {
        body = (await res.json()) as Record<string, unknown>;
    } catch {
        /* empty */
    }
    return { status: res.status, body };
}

async function denialRows() {
    return prisma.auditLog.findMany({
        where: { tenantId: TENANT, action: 'AUTHZ_DENIED' },
        orderBy: { createdAt: 'asc' },
    });
}

/** The `detailsJson` of the one AUTHZ_DENIED row, or a failure naming the count. */
async function theDenial(): Promise<Record<string, unknown>> {
    const rows = await denialRows();
    expect(rows).toHaveLength(1);
    return rows[0].detailsJson as Record<string, unknown>;
}

describeFn('the agent-registration gate', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: TENANT, slug: TENANT },
        });
        const email = `${TENANT}@example.test`;
        await prisma.user.upsert({
            where: { id: USER },
            update: {},
            create: { id: USER, email, emailHash: hashForLookup(email) },
        });

        // The key's PRINCIPAL must be a live member: as of Epic Agentic 2 the
        // MCP surface resolves `TenantApiKey.createdById` through the same
        // `resolveTenantContext` a human goes through and intersects the two.
        // OWNER because this suite's `propose_risks` case needs a principal who
        // could create the risk it proposes.
        await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: TENANT, userId: USER } },
            update: { role: 'OWNER', status: 'ACTIVE' },
            create: { tenantId: TENANT, userId: USER, role: 'OWNER', status: 'ACTIVE' },
        });

        activeAgentId = await seedAgent('Live reconciler', 'ACTIVE');
        suspendedAgentId = await seedAgent('Stopped reconciler', 'SUSPENDED');

        // Tool exposure is deny-by-default, so a registered agent reaches
        // nothing until an administrator grants it. This suite is about the
        // REGISTRATION gate, not the exposure list, so it grants the two tools
        // it drives and leaves the allowlist's own behaviour to
        // tests/integration/mcp-tool-authz-per-invocation.test.ts.
        for (const toolName of ['list_risks', 'propose_risks']) {
            await prisma.registeredAgentTool.create({
                data: { tenantId: TENANT, agentId: activeAgentId, toolName, grantedByUserId: USER },
            });
        }
        keyActive = await mintKey(activeAgentId);
        keySuspended = await mintKey(suspendedAgentId);
        keyUnbound = await mintKey(null);
        keySuspendedWide = await mintKey(
            suspendedAgentId,
            [
                'mcp:read',
                'mcp:propose',
                'mcp:orchestrate',
                'risks:read',
                'frameworks:read',
                'controls:read',
            ],
            'suspended-wide',
        );
    });

    afterAll(async () => {
        // `session_replication_role = 'replica'` for AuditLog: the
        // immutable-audit-log trigger fires on an ordinary DELETE and would
        // take the teardown, and therefore the whole suite, down with it.
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT);
        });
        await prisma.agentProposal.deleteMany({ where: { tenantId: TENANT } });
        // Table D's own rows, deleted before the agent they hang off. Every one
        // of these tables is a CONTROL keyed to an agent, so a leak here does
        // not merely leave data behind — it makes the next run of this suite
        // start with a kill switch engaged or a breaker latched open.
        await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.agentPolicyCardVersion.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.agentPolicyCard.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.agentKillSwitch.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.agentCircuitBreaker.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.agentBehaviourWindow.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.mcpToolManifestPin.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.registeredAgentTool.deleteMany({ where: { tenantId: TENANT } });
        await prisma.tenantApiKey.deleteMany({ where: { tenantId: TENANT } });
        // Same replica-mode escape as the AuditLog delete above, and for the
        // same class of reason: `tenant_membership_last_owner_guard` raises
        // P0001 on a DELETE that would leave the tenant with no ACTIVE OWNER,
        // which a teardown always would.
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
        });
        await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
        await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });
        await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: TENANT } });
        await prisma.user.deleteMany({ where: { id: USER } });
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT);
        });
    });

    describe('flag OFF — today’s behaviour is preserved', () => {
        beforeEach(() => setEnforcement(false));

        it('an unbound key still reaches the agent surface', async () => {
            const { status, body } = await callMcp(keyUnbound);
            expect(status).toBe(200);
            // Not just "not a 403" — a real tool list came back, so the call
            // went all the way through rather than failing somewhere quieter.
            expect((body as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
        });

        it('and writes no denial row', async () => {
            await callMcp(keyUnbound);
            expect(await denialRows()).toHaveLength(0);
        });

        it('a key bound to a SUSPENDED agent still passes the REGISTRATION gate', async () => {
            // ── THIS ASSERTION SURVIVES #2399 AND ITS OLD COMMENT DOES NOT ──
            //
            // It used to read: "The kill switch is the gate's, not the
            // credential's. With the gate off, suspension stops nothing — which
            // is precisely the reason a tenant would turn the gate on." Every
            // clause of that was wrong, and the assertion staying green is
            // exactly why the comment was the danger: a passing test with a
            // false explanation is worse than either a failing test or no test,
            // because it is cited.
            //
            // What is wrong with it. (a) SUSPENDED is NOT the kill switch —
            // that is `agentic/kill-switch.ts`, a boundary control with its own
            // table and three scopes, and the two are now proved to compose
            // below. (b) "Suspension stops nothing" was true and is the bug: it
            // did not merely fail to stop the agent, it WIDENED the credential,
            // dropping the tool allowlist, both autonomy terms, the policy card,
            // the breaker and the AGENT arm of its own kill switch at once.
            //
            // What this 200 means, and all it means: the REGISTRATION gate did
            // not refuse, because the tenant opted out of it. `tools/list` is
            // the method being called, and it comes back 200 with an EMPTY tool
            // array — asserted next, because "200" alone is what let the old
            // comment sound reasonable.
            expect((await callMcp(keySuspended)).status).toBe(200);
        });

        it('and that 200 carries an EMPTY tool list, not the catalogue', async () => {
            // `grantedTools` is an EMPTY SET for a suspended agent, and
            // `toolIsLoadable` reads an empty set as deny — the contract
            // `listGrantedToolNames` has always stated. So the catalogue filter
            // returns nothing and the operator's client sees an agent with no
            // tools, which is the right signal and needs no new error path.
            //
            // Paired with the unbound key's non-empty list above: a filter that
            // returned `[]` for everyone would satisfy this cell alone.
            const { status, body } = await callMcp(keySuspended);
            expect(status).toBe(200);
            expect((body as { result: { tools: unknown[] } }).result.tools).toEqual([]);
        });
    });

    /**
     * ── TABLE D — SUSPENSION AS A BOUNDARY CONTROL, AGAINST THE REAL ROUTE ──
     *
     * Every cell here is one the unit doubles cannot decide. The point of the
     * table is not redundancy: the unit suite
     * (`tests/unit/agent-suspension-boundary.test.ts`) proves the funnel
     * consults each control, and it proves it against doubles that could all
     * agree with each other and still be wrong about what the route does.
     *
     * Two of these cells are load-bearing in a way no double can reproduce.
     *
     *   • The kill switch's AGENT arm is `("agentId" IS NULL OR "agentId" = $2)`
     *     in hand-written SQL. A doubled `$queryRaw` returns whatever it is
     *     told, so it can prove the funnel PASSED an id and never that the
     *     statement MATCHES a row. Only a real `AgentKillSwitch` row can.
     *
     *   • `reserveDailyAction` is an `UPDATE … RETURNING`. "The card was
     *     applied" is a claim about a WRITE landing, and a double asserts the
     *     call, not the row.
     */
    describe('flag OFF — a SUSPENDED agent is stopped at the TOOL boundary', () => {
        beforeEach(() => setEnforcement(false));

        it('refuses `tools/call` with reason `agent_suspended` and ONE hash-chained row', async () => {
            // The register did not refuse — the tenant opted out — so this
            // refusal comes from the tool boundary, which before #2399 did not
            // refuse at all: `grantedTools` was `null` for a suspended agent,
            // and a null grant list is allow-all by design (there is no list to
            // consult). The whole catalogue was reachable.
            const { status, body } = await callRpc(keySuspendedWide, 'tools/call', {
                name: 'list_risks',
                arguments: {},
            });

            // In-band, at 200 — see `callRpc`. The refusal is the JSON-RPC
            // error and the audit row, together.
            expect(status).toBe(200);
            expect(body.error?.message).toMatch(/suspended in the register/i);
            expect(body.result).toBeUndefined();

            const details = await theDenial();
            expect(details).toMatchObject({
                gate: 'mcp_tool_invocation',
                reason: 'agent_suspended',
                tool: 'list_risks',
                // The GOVERNED id. `verdict.agentId` is null for a suspended
                // agent, so every row this funnel wrote about one used to say
                // `agentId: null` — a refusal no operator could attribute.
                agentId: suspendedAgentId,
                standing: 'suspended',
            });

            const rows = await denialRows();
            // Hash-chained, and the head of a chain in a table this suite's
            // `beforeEach` just cleared. Asserting the row exists would pass
            // against evidence nobody can verify.
            expect(rows[0].entryHash).toMatch(/^[0-9a-f]{64}$/);
            expect(rows[0].entity).toBe('McpTool');
            expect(rows[0].actorType).toBe('API_KEY');
        });

        it('and the refusal does NOT send the operator to the grant list', async () => {
            // `tool_not_granted` and `agent_suspended` have opposite fixes:
            // activate the agent, versus grant it a tool. The grant rows are
            // intact and unread here, so a message naming them would send an
            // operator to widen a list that is not refusing — and they would
            // widen it, see no change, and widen it further.
            const { body } = await callRpc(keySuspendedWide, 'tools/call', {
                name: 'list_risks',
                arguments: {},
            });

            expect(body.error?.message).not.toMatch(/must grant it in the agent register/i);
            expect(body.error?.message).toMatch(/administrator must activate it/i);
            expect(body.error?.message).toMatch(/tool grants are unchanged/i);
        });

        it('THE HONEST NEGATIVE — `resources/read` on the framework catalogue is still SERVED', async () => {
            // The cell that keeps the copy on this PR truthful, and the reason
            // the changelog may never say "deny-all".
            //
            // This fix denies TOOLS. The resources door is narrowed — kill,
            // breaker, autonomy ceiling and policy card all apply to it again —
            // and it is not closed: `read` requires rung 1, even CRITICAL caps
            // at 1, so no SCORED tier is refused by the ceiling, and the
            // exposure allowlist has nothing to apply here because
            // `RegisteredAgentTool` names catalogue TOOLS and resources have no
            // entries in it.
            //
            // A suite that proved only refusals would licence a claim the code
            // does not support. Deleting this test is how that happens.
            const { status, body } = await callRpc(keySuspendedWide, 'resources/read', {
                uri: 'inflect://frameworks',
            });

            expect(status).toBe(200);
            expect(body.error).toBeUndefined();
            // Not merely "not an error" — real contents came back, so the read
            // went all the way through to the usecase.
            expect(body.result?.contents?.[0].uri).toBe('inflect://frameworks');
            expect(await denialRows()).toHaveLength(0);
        });

        it('an AGENT-scope kill engaged and THEN suspended refuses, and writes `agent_killed`', async () => {
            // ── THE LARGEST SINGLE WIN, AGAINST REAL SQL ──
            //
            // `resolveKillState` matches `("agentId" IS NULL OR "agentId" = $2)`.
            // Step 0 used to pass the VOUCHED id, which is NULL for a suspended
            // agent, so the AGENT arm could never match — only TENANT and
            // PLATFORM rows could. An operator who suspended an agent and then
            // pulled its kill switch got a 200 on both doors and NO
            // `agent_killed` row to say the control had done anything.
            //
            // Kill-then-suspend is a normal sequence, not a contrivance:
            // `AgentKillSwitchAction.tsx` tells the operator that engaging the
            // kill does not change `RegisteredAgent.status`, so an operator who
            // wants both does both.
            const kill = await prisma.agentKillSwitch.create({
                data: {
                    tenantId: TENANT,
                    agentId: suspendedAgentId,
                    reason: 'Table D — the AGENT arm must match a suspended agent',
                    engagedByUserId: USER,
                },
            });
            try {
                const { body } = await callRpc(keySuspendedWide, 'tools/call', {
                    name: 'list_risks',
                    arguments: {},
                });

                // The KILL is what refuses, not the suspension — step 0 runs
                // ahead of step 4, so the operator reading the trail during an
                // incident sees the control they pulled.
                expect(body.error?.message).toMatch(/stopped by an administrator's kill switch/i);

                const details = await theDenial();
                expect(details).toMatchObject({
                    reason: 'agent_killed',
                    killScope: 'AGENT',
                    killSwitchId: kill.id,
                    agentId: suspendedAgentId,
                    // Loud, unconditionally: a call arriving after somebody
                    // pulled the stop switch is not routine.
                    escalate: true,
                    drill: false,
                });
            } finally {
                await prisma.agentKillSwitch.delete({ where: { id: kill.id } });
            }
        });

        it('the same kill stops the RESOURCES door — a one-door stop is walkable', async () => {
            const kill = await prisma.agentKillSwitch.create({
                data: {
                    tenantId: TENANT,
                    agentId: suspendedAgentId,
                    reason: 'Table D — both doors',
                    engagedByUserId: USER,
                },
            });
            try {
                const { body } = await callRpc(keySuspendedWide, 'resources/read', {
                    uri: 'inflect://frameworks',
                });

                expect(body.result).toBeUndefined();
                expect(await theDenial()).toMatchObject({
                    reason: 'agent_killed',
                    tool: MCP_RESOURCES_AUDIENCE,
                });
            } finally {
                await prisma.agentKillSwitch.delete({ where: { id: kill.id } });
            }
        });

        it('a breaker latched OPEN and then suspended refuses `circuit_breaker_open`', async () => {
            // `assertCircuitBreakerClosed` returned early on a null VOUCHED id,
            // so the latch was SKIPPED — not consulted and found closed. A
            // breaker latched open against a suspended agent refused nothing on
            // either door, which is the exfiltration half of the rogue-agent
            // case the breaker exists to stop.
            // All four fields, because `AgentCircuitBreaker_open_has_basis` is a
            // real CHECK: an OPEN latch must say when it tripped, in which
            // window, and on what signal. A latch with no basis is one nobody
            // can argue with, which is how a control becomes something
            // operators route around. A doubled `findUnique` would have let this
            // fixture be a state the database cannot hold.
            const trippedAt = new Date();
            await prisma.agentCircuitBreaker.upsert({
                where: { tenantId_agentId: { tenantId: TENANT, agentId: suspendedAgentId } },
                update: {
                    state: 'OPEN',
                    trippedAt,
                    trippedWindow: windowKeyFor(trippedAt),
                    trippedSignals: ['TOOL_MIX'],
                },
                create: {
                    tenantId: TENANT,
                    agentId: suspendedAgentId,
                    state: 'OPEN',
                    trippedAt,
                    trippedWindow: windowKeyFor(trippedAt),
                    trippedSignals: ['TOOL_MIX'],
                },
            });
            try {
                const { body } = await callRpc(keySuspendedWide, 'tools/call', {
                    name: 'list_risks',
                    arguments: {},
                });

                expect(body.error?.message).toMatch(/circuit breaker latched open/i);
                // What tripped it never goes back to the caller — that is the
                // threshold an attacker would stay under. It goes in the row.
                expect(body.error?.message).not.toMatch(/TOOL_MIX/);
                expect(await theDenial()).toMatchObject({
                    reason: 'circuit_breaker_open',
                    agentId: suspendedAgentId,
                    breakerSignals: ['TOOL_MIX'],
                });
            } finally {
                await prisma.agentCircuitBreaker.deleteMany({
                    where: { tenantId: TENANT, agentId: suspendedAgentId },
                });
            }
        });

        it("a suspended agent's resource read SPENDS its policy card's daily budget", async () => {
            // A real write, which is the only way to make this claim. The card
            // was authored, it existed, and for a suspended agent it was
            // silently not applied — while `WorkflowRun` still pinned its
            // version into a write-once hash-chained column. Now it applies, and
            // a resource read spends the agent's day like any other call.
            const card = await prisma.agentPolicyCard.create({
                data: {
                    tenantId: TENANT,
                    agentId: suspendedAgentId,
                    currentVersion: 1,
                    createdByUserId: USER,
                },
            });
            await prisma.agentPolicyCardVersion.create({
                data: {
                    tenantId: TENANT,
                    cardId: card.id,
                    version: 1,
                    // Empty: a resource read passes `tool: null`, which skips
                    // the permitted-TOOL rule and ONLY that rule. Every other
                    // rung below applies, and does.
                    permittedTools: [],
                    maxDataScope: 'READ_TENANT_DATA',
                    maxAutonomyLevel: 2,
                    maxActionsPerRun: 25,
                    maxActionsPerDay: 100,
                    escalationTriggers: [],
                    approvalRung: 'SINGLE_APPROVER',
                    createdByUserId: USER,
                },
            });
            try {
                const { status } = await callRpc(keySuspendedWide, 'resources/read', {
                    uri: 'inflect://frameworks',
                });
                expect(status).toBe(200);

                const after = await prisma.agentPolicyCard.findUnique({
                    where: { id: card.id },
                    select: { actionsInWindow: true, usageWindowDate: true },
                });
                expect(after?.actionsInWindow).toBe(1);
                // Stamped with today's UTC day, so the reset is a property of
                // the write rather than of a job that has to run at midnight.
                expect(after?.usageWindowDate?.toISOString().slice(0, 10)).toBe(
                    utcDay(new Date()),
                );
            } finally {
                await prisma.agentPolicyCardVersion.deleteMany({ where: { cardId: card.id } });
                await prisma.agentPolicyCard.delete({ where: { id: card.id } });
            }
        });

        it("refuses the read once that card's daily budget is exhausted", async () => {
            // The other direction of the same write. Without this, "the card is
            // applied" is satisfied by a reservation whose result nothing reads.
            const card = await prisma.agentPolicyCard.create({
                data: {
                    tenantId: TENANT,
                    agentId: suspendedAgentId,
                    currentVersion: 1,
                    createdByUserId: USER,
                    // Already at the cap for today, so the reservation returns
                    // the call that goes over it.
                    usageWindowDate: new Date(`${utcDay(new Date())}T00:00:00.000Z`),
                    actionsInWindow: 1,
                },
            });
            await prisma.agentPolicyCardVersion.create({
                data: {
                    tenantId: TENANT,
                    cardId: card.id,
                    version: 1,
                    permittedTools: [],
                    maxDataScope: 'READ_TENANT_DATA',
                    maxAutonomyLevel: 2,
                    maxActionsPerRun: 25,
                    maxActionsPerDay: 1,
                    escalationTriggers: [],
                    approvalRung: 'SINGLE_APPROVER',
                    createdByUserId: USER,
                },
            });
            try {
                const { body } = await callRpc(keySuspendedWide, 'resources/read', {
                    uri: 'inflect://frameworks',
                });

                expect(body.result).toBeUndefined();
                expect(await theDenial()).toMatchObject({
                    reason: 'policy_card_denied',
                    policyCardRule: 'DAILY_ACTION_CAP_EXCEEDED',
                    policyCardVersion: 1,
                    agentId: suspendedAgentId,
                });
            } finally {
                await prisma.agentPolicyCardVersion.deleteMany({ where: { cardId: card.id } });
                await prisma.agentPolicyCard.delete({ where: { id: card.id } });
            }
        });
    });

    /**
     * ── AUDIT 1'S OPEN QUESTION: IS #2399 OPT-OUT-ONLY, OR GENERAL? ──
     *
     * The registration gate lives in `authenticateMcpRequest`, which only
     * `/api/mcp` calls. The workflow engine enters the funnel through
     * `resolveMcpInvocation`, which uses the NON-THROWING evaluator on purpose —
     * the run's own route already decided whether the caller may start it, and a
     * second differently-timed refusal there would be a second denial on a path
     * that has one. So `reason` is null on this path in EVERY tenant, and a
     * suspended agent reaches the tool boundary here even when the flag is ON.
     *
     * That makes the answer GENERAL, not opt-out-only, and only a real DB can
     * show it: it takes `getTenantCtx` → `tryApiKeyAuth` carrying `agentId`
     * through to `resolveMcpInvocation` and on to `governedAgentIdOf`. The
     * changelog wording depends on this cell.
     */
    describe('flag ON — the workflow-engine path honours suspension too', () => {
        beforeEach(() => setEnforcement(true));

        it('starts the run and then refuses its every tool call', async () => {
            // The run is CREATED — `POST /api/t/:slug/agent-runs` runs no
            // registration gate, and this fix does not add one; the REST
            // surface is unchanged and the copy must not imply otherwise. What
            // changed is that the first tool call the engine makes is refused,
            // so the run fails at step 0 instead of reading the tenant's whole
            // compliance posture.
            const { status, body } = await startRun(keySuspendedWide, 'diagnostic');

            expect(status).toBe(201);
            expect(body.status).toBe('FAILED');
            expect(typeof body.runId).toBe('string');

            const run = await prisma.workflowRun.findUnique({
                where: { id: body.runId as string },
                select: { status: true, agentId: true },
            });
            expect(run?.status).toBe('FAILED');

            // The refusal is the register's, named as such, and attributed to
            // the agent — on a path where `verdict.reason` is null, so nothing
            // but `standing` could have carried it.
            const details = await theDenial();
            expect(details).toMatchObject({
                gate: 'mcp_tool_invocation',
                reason: 'agent_suspended',
                tool: 'get_compliance_posture',
                agentId: suspendedAgentId,
                standing: 'suspended',
            });
        });

        it('and the step it failed at is the FIRST one — nothing ran before the refusal', async () => {
            // Prevention, not detection. A run that read the posture and then
            // failed would produce the same FAILED status and the same audit
            // row, so the status is not the property; the step trail is.
            const { body } = await startRun(keySuspendedWide, 'diagnostic');

            const steps = await prisma.workflowStep.findMany({
                where: { tenantId: TENANT, runId: body.runId as string },
                orderBy: { seq: 'asc' },
                select: { seq: true, kind: true, status: true },
            });
            expect(steps).toHaveLength(1);
            expect(steps[0]).toMatchObject({ seq: 0, kind: 'READ', status: 'FAILED' });
        });

        it('a VOUCHED agent still completes the same run — the paired positive', async () => {
            // Without this the two cells above are equally satisfied by an
            // engine that cannot run anything at all. `keyActive`'s agent is
            // granted `list_risks` and `propose_risks` but not
            // `get_compliance_posture`, so this needs its own credential —
            // which is also the honest shape: the grant list is what decides
            // for a VOUCHED agent, and it still does.
            await prisma.registeredAgentTool.upsert({
                where: {
                    tenantId_agentId_toolName: {
                        tenantId: TENANT,
                        agentId: activeAgentId,
                        toolName: 'get_compliance_posture',
                    },
                },
                update: {},
                create: {
                    tenantId: TENANT,
                    agentId: activeAgentId,
                    toolName: 'get_compliance_posture',
                    grantedByUserId: USER,
                },
            });
            const keyActiveWide = await mintKey(
                activeAgentId,
                ['mcp:read', 'mcp:orchestrate', 'controls:read'],
                'active-wide',
            );

            const { status, body } = await startRun(keyActiveWide, 'diagnostic');

            expect(status).toBe(201);
            expect(body.status).toBe('COMPLETED');
            expect(await denialRows()).toHaveLength(0);
        });
    });

    describe('flag ON — an unregistered credential is refused', () => {
        beforeEach(() => setEnforcement(true));

        it('refuses the call with a 403', async () => {
            expect((await callMcp(keyUnbound)).status).toBe(403);
        });

        it('writes a hash-chained AUTHZ_DENIED row naming the key and the reason', async () => {
            await callMcp(keyUnbound);
            const rows = await denialRows();
            expect(rows).toHaveLength(1);

            const row = rows[0];
            expect(row.action).toBe('AUTHZ_DENIED');
            expect(row.entity).toBe('RegisteredAgent');
            expect(row.actorType).toBe('API_KEY');

            const details = row.detailsJson as Record<string, unknown>;
            expect(details.category).toBe('access');
            expect(details.gate).toBe('agent_registration');
            // The reason is the operator's whole diagnosis: "nobody registered
            // this key" and "the kill switch is down" need opposite responses.
            expect(details.reason).toBe('no_agent_binding');
            expect(details.path).toBe('/api/mcp');

            // The row names the CREDENTIAL, because that is what an operator
            // has to bind or revoke. There is no agent to name — that is the
            // finding.
            const key = await prisma.tenantApiKey.findFirst({
                where: { tenantId: TENANT, agentId: null },
                select: { id: true },
            });
            expect(row.entityId).toBe(key?.id);
            expect(details.agentId).toBeNull();

            // Hash-chained: the entry carries a hash, and it is the head of
            // this tenant's chain in a database we just cleared.
            expect(row.entryHash).toMatch(/^[0-9a-f]{64}$/);
        });

        it('a second refusal links to the first — the chain is real, not decorative', async () => {
            await callMcp(keyUnbound);
            await callMcp(keyUnbound);
            const rows = await denialRows();
            expect(rows).toHaveLength(2);
            // The load-bearing property: tampering with or deleting the first
            // row breaks the second's link. Asserting only that a hash exists
            // would pass against two unrelated rows.
            expect(rows[1].previousHash).toBe(rows[0].entryHash);
            expect(rows[1].entryHash).not.toBe(rows[0].entryHash);
        });

        it('refuses a key whose agent is SUSPENDED, and says so', async () => {
            expect((await callMcp(keySuspended)).status).toBe(403);
            const rows = await denialRows();
            expect(rows).toHaveLength(1);
            const details = rows[0].detailsJson as Record<string, unknown>;
            // A DIFFERENT reason from the unbound case. The suspended agent IS
            // named here — an operator needs to know which switch is down.
            expect(details.reason).toBe('agent_not_active');
            expect(details.agentId).toBe(suspendedAgentId);
        });

        it('a key bound to an ACTIVE agent goes through', async () => {
            // Without this, every assertion above is equally satisfied by a
            // gate that refuses all traffic.
            const { status, body } = await callMcp(keyActive);
            expect(status).toBe(200);
            expect((body as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
            expect(await denialRows()).toHaveLength(0);
        });
    });

    describe('an absent settings row reads as ENFORCING', () => {
        it('refuses an unbound key for a tenant nobody has configured', async () => {
            // Rows here are written lazily, so "no row" is the state of every
            // tenant created after this shipped. Reading it as "off" would make
            // the documented default true only of tenants whose admin had
            // happened to open a settings page. The migration back-filled a row
            // for every tenant that existed at deploy time so this rule cannot
            // retroactively switch an existing customer on.
            await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: TENANT } });
            expect((await callMcp(keyUnbound)).status).toBe(403);
            expect((await callMcp(keyActive)).status).toBe(200);
        });
    });

    describe('the runtime record it lets through is attributed', () => {
        beforeEach(() => setEnforcement(true));

        it('a proposal made through MCP names the agent that made it', async () => {
            // The other half of the invariant the `local/require-agent-attribution`
            // rule polices. The register says which agents exist; the runtime
            // rows have to resolve back to it. An `agentId` of NULL here would
            // mean the gate identified a caller and then lost track of who it
            // was — a register that is consulted at the door and forgotten
            // immediately afterwards.
            const before = await prisma.agentProposal.count({ where: { tenantId: TENANT } });

            const req = new NextRequest('http://localhost/api/mcp', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${keyActive}`,
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 7,
                    method: 'tools/call',
                    params: {
                        name: 'propose_risks',
                        arguments: {
                            items: [{ title: 'Attributed risk', description: 'from a live agent' }],
                        },
                    },
                }),
            });
            const res = await POST(req, { params: Promise.resolve({}) } as never);
            expect(res.status).toBe(200);

            const proposals = await prisma.agentProposal.findMany({
                where: { tenantId: TENANT },
            });
            // Anti-vacuity: the call really queued something. Without this the
            // attribution assertion below would pass over an empty array.
            expect(proposals).toHaveLength(before + 1);
            expect(proposals[0].agentId).toBe(activeAgentId);
        });
    });

    /**
     * The gate's ALLOW path has to be reachable through the product, not only
     * through SQL.
     *
     * Everything above mints its credentials with `prisma.tenantApiKey.create`,
     * which sets `agentId` directly. That proves the gate READS the binding; it
     * cannot prove an operator can ever WRITE one. Those are different claims, and
     * the difference is not academic: `TenantApiKey.agentId` shipped with no writer
     * anywhere in `src/`, so a tenant with no `TenantSecuritySettings` row — which
     * is every tenant created after the gate, since the absence reads as ENFORCING
     * — could mint no usable MCP credential at all. Every assertion above passed
     * while `/api/mcp` was unreachable in production.
     *
     * So this block mints through `createApiKey`, the usecase the admin route
     * calls, and asserts the resulting credential passes the gate it must pass.
     */
    describe('the binding is writable through the product', () => {
        const adminCtx = () => makeRequestContext('OWNER', { tenantId: TENANT, userId: USER });

        it('a key minted through createApiKey and bound to an ACTIVE agent passes the gate', async () => {
            await setEnforcement(true);

            const { plaintext } = (await createApiKey(adminCtx(), {
                name: 'minted-bound',
                scopes: ['mcp:read'],
                agentId: activeAgentId,
            })) as { plaintext: string };

            const res = await callMcp(plaintext);
            expect(res.status).toBe(200);
        });

        it('the binding it wrote is the agent asked for, not merely non-null', async () => {
            const { keyPrefix } = (await createApiKey(adminCtx(), {
                name: 'minted-attributed',
                scopes: ['mcp:read'],
                agentId: activeAgentId,
            })) as { keyPrefix: string };

            const row = await prisma.tenantApiKey.findFirst({
                where: { tenantId: TENANT, keyPrefix },
                select: { agentId: true },
            });
            expect(row?.agentId).toBe(activeAgentId);
        });

        it('a key minted with no agent is refused once the tenant enforces', async () => {
            await setEnforcement(true);

            const { plaintext } = (await createApiKey(adminCtx(), {
                name: 'minted-unbound',
                scopes: ['mcp:read'],
            })) as { plaintext: string };

            const res = await callMcp(plaintext);
            expect(res.status).toBe(403);
        });

        it('refuses another tenant`s agent as the binding', async () => {
            const otherTenant = `t-other-${randomUUID().slice(0, 8)}`;
            await prisma.tenant.create({ data: { id: otherTenant, name: otherTenant, slug: otherTenant } });
            const foreignSystem = await prisma.aiSystem.create({
                data: { tenantId: otherTenant, name: 'foreign host', ownerUserId: USER },
            });
            const foreign = await prisma.registeredAgent.create({
                data: {
                    tenantId: otherTenant,
                    aiSystemId: foreignSystem.id,
                    name: 'foreign',
                    autonomyLevel: 1,
                    dataAccessScope: 'READ_METADATA',
                    reversibility: 'REVERSIBLE',
                    provenance: 'FIRST_PARTY',
                    ownerUserId: USER,
                    status: 'ACTIVE',
                    // Scored LOW so the TIER term is never what refuses
                    // here — an UNSCORED agent is denied every tool from
                    // Agentic 3/10, which would make these assertions pass for
                    // the wrong reason. LOW leaves the ladder whole.
                    riskTier: 'LOW',
                    riskTierScoredAt: new Date(),
                },
            });

            try {
                // A plain FK would accept this: Postgres runs foreign-key checks
                // as the table owner, which bypasses row security. The
                // tenant-scoped lookup is what refuses it.
                await expect(
                    createApiKey(adminCtx(), {
                        name: 'minted-foreign',
                        scopes: ['mcp:read'],
                        agentId: foreign.id,
                    }),
                ).rejects.toThrow();
            } finally {
                // This case reaches OUTSIDE the suite's fixture, so it clears up
                // after itself. The foreign agent names USER as its owner and the
                // suite's teardown deletes that user, so leaving these rows behind
                // turns a passing suite into "failed to run" on a foreign-key
                // violation — which reads as a broken suite rather than a leak.
                await prisma.registeredAgent.deleteMany({ where: { tenantId: otherTenant } });
                await prisma.aiSystem.deleteMany({ where: { tenantId: otherTenant } });
                await prisma.tenant.deleteMany({ where: { id: otherTenant } });
            }
        });

        it('refuses a SUSPENDED agent at mint time rather than at first use', async () => {
            await expect(
                createApiKey(adminCtx(), {
                    name: 'minted-suspended',
                    scopes: ['mcp:read'],
                    agentId: suspendedAgentId,
                }),
            ).rejects.toThrow();
        });
    });
});
