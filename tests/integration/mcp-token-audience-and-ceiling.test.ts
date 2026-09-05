/**
 * Audience-scoped tokens, the autonomy ceiling, and revocation INSIDE a run.
 *
 * Drives the REAL `/api/mcp/token` and `/api/mcp` routes and the REAL workflow
 * engine against a REAL database. Nothing here calls a usecase directly, because
 * every property under test is a property of the request path.
 *
 * ## What each block proves
 *
 *   1. EXCHANGE NARROWS AND NEVER WIDENS. A token minted for `list_risks` calls
 *      `list_risks` and is REFUSED at `list_controls` — with the same key, the
 *      same agent and the same grants, so the token is the only difference. And
 *      a token cannot be minted for a tool the agent was never granted: the
 *      deny-by-default allowlist composes with the audience rather than sitting
 *      beside it.
 *
 *   2. THE CEILING IS min(KEY, AGENT). Two credentials on ONE agent registered
 *      at rung 2: one with no ceiling, one capped at 0. The uncapped key reads;
 *      the capped one cannot, and its refusal is an `AUTHZ_DENIED` row naming
 *      the rung it wanted. Authority stops travelling with the bearer.
 *
 *   3. A NULL RISK TIER DENIES. The 3/10 seam, composed rather than described:
 *      the same ceiling arithmetic the funnel runs, with the tier term folded
 *      in, refuses an otherwise fully-authorised agent — and the agents in this
 *      database really are unscored, which is why the term is not wired yet.
 *
 *   4. REVOCATION LANDS INSIDE A RUN IN FLIGHT. A multi-step workflow, a SPY on
 *      the tool itself, and the key revoked from under it after the first step.
 *      The assertion is that NO FURTHER TOOL EXECUTED — a status code cannot
 *      tell "checked at the tool boundary" from "checked at dispatch", because
 *      both refuse the next REQUEST. Only the spy can.
 *
 * Suite-unique ids keep it parallel-safe (`TenantApiKey.keyHash` is globally
 * unique).
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { generateApiKey } from '@/lib/auth/api-key-auth';
import { POST as MCP_POST } from '@/app/api/mcp/route';
import { POST as TOKEN_POST } from '@/app/api/mcp/token/route';
import {
    AUTONOMY_REQUIRED_BY_CAPABILITY,
    DENY_CEILING,
} from '@/lib/agentic/autonomy-ceiling';
import { TOKEN_EXCHANGE_GRANT_TYPE, MCP_RESOURCES_AUDIENCE } from '@/lib/mcp/token-exchange';
import { listRisksTool } from '@/lib/mcp/tools/risk-tools';
import { registerWorkflow } from '@/lib/agentic/workflow-registry';
import { startWorkflowRun, getWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { makeRequestContext } from '../helpers/make-context';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `aud-${randomUUID().slice(0, 8)}`;
const TENANT = `ta-${SUITE}`;
const REVOKE_WF = `test-revoke-${SUITE}`;

const GRANTED_TOOLS = ['list_risks', 'list_controls'];
const WIDE_SCOPES = ['mcp:read', 'mcp:orchestrate', 'risks:read', 'controls:read'];

let ownerId = '';
let agentRung2 = '';
/** Same agent, two credentials — the ceiling is the only difference. */
let keyNoCeiling = '';
let keyCeilingZero = '';
/** Bound to `agentRung2`, used for the exchange + revocation blocks. */
let keyForExchange = '';
let keyForRunId = '';
let keyForRun = '';

async function rpc(token: string, body: unknown): Promise<{ status: number; json: unknown }> {
    const req = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    const res = await MCP_POST(req, { params: Promise.resolve({}) } as never);
    let json: unknown = null;
    try {
        json = await res.json();
    } catch {
        /* 202 / empty */
    }
    return { status: res.status, json };
}

function callTool(token: string, name: string, args: unknown = {}) {
    return rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

async function exchange(
    subjectToken: string,
    audience: string[] | string,
    extra: Record<string, unknown> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
    const req = new NextRequest('http://localhost/api/mcp/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
            subject_token: subjectToken,
            audience,
            ...extra,
        }),
    });
    const res = await TOKEN_POST(req, { params: Promise.resolve({}) } as never);
    let json: Record<string, unknown> = {};
    try {
        json = (await res.json()) as Record<string, unknown>;
    } catch {
        /* empty body */
    }
    return { status: res.status, json };
}

function errorMessageOf(json: unknown): string | undefined {
    return (json as { error?: { message?: string } })?.error?.message;
}

function resultOf(json: unknown): unknown {
    const r = json as { result?: { content?: Array<{ text: string }> } };
    const text = r?.result?.content?.[0]?.text;
    return text === undefined ? undefined : JSON.parse(text);
}

async function mintKey(
    userId: string,
    scopes: string[],
    agentId: string | null,
    maxAutonomyLevel: number | null = null,
): Promise<{ plaintext: string; id: string }> {
    const { plaintext, keyHash, keyPrefix } = generateApiKey();
    const row = await prisma.tenantApiKey.create({
        data: {
            tenantId: TENANT,
            name: `k-${randomUUID().slice(0, 6)}`,
            keyPrefix,
            keyHash,
            scopes,
            createdById: userId,
            agentId,
            maxAutonomyLevel,
        },
        select: { id: true },
    });
    return { plaintext, id: row.id };
}

async function seedAgent(name: string, autonomyLevel: number): Promise<string> {
    const aiSystem = await prisma.aiSystem.create({
        data: { tenantId: TENANT, name: `${name} host`, ownerUserId: ownerId },
    });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId: TENANT,
            aiSystemId: aiSystem.id,
            name,
            autonomyLevel,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: ownerId,
            status: 'ACTIVE',
            // Scored LOW so the TIER term is never what refuses here — an
            // UNSCORED agent is denied every tool from Agentic 3/10, which
            // would make these assertions pass for the wrong reason. LOW leaves
            // the ladder whole, so the arithmetic below is unchanged.
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
    for (const toolName of GRANTED_TOOLS) {
        await prisma.registeredAgentTool.create({
            data: { tenantId: TENANT, agentId: agent.id, toolName, grantedByUserId: ownerId },
        });
    }
    return agent.id;
}

describeFn('audience-scoped tokens, the autonomy ceiling, and mid-run revocation', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: TENANT, slug: TENANT },
        });

        ownerId = `u-${TENANT}-owner`;
        const email = `${ownerId}@example.test`;
        await prisma.user.upsert({
            where: { id: ownerId },
            update: {},
            create: { id: ownerId, email, emailHash: hashForLookup(email) },
        });
        await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: TENANT, userId: ownerId } },
            update: { role: 'OWNER', status: 'ACTIVE' },
            create: { tenantId: TENANT, userId: ownerId, role: 'OWNER', status: 'ACTIVE' },
        });

        for (let i = 0; i < 2; i++) {
            await prisma.risk.create({
                data: {
                    tenantId: TENANT,
                    title: `${TENANT}-risk-${i}`,
                    description: 'x',
                    category: 'Cybersecurity',
                    impact: 3,
                    likelihood: 3,
                    score: 9,
                    inherentScore: 9,
                    status: 'OPEN',
                    createdByUserId: ownerId,
                },
            });
        }

        agentRung2 = await seedAgent('Ceiling agent', 2);

        keyNoCeiling = (await mintKey(ownerId, WIDE_SCOPES, agentRung2, null)).plaintext;
        keyCeilingZero = (await mintKey(ownerId, WIDE_SCOPES, agentRung2, 0)).plaintext;
        keyForExchange = (await mintKey(ownerId, WIDE_SCOPES, agentRung2, null)).plaintext;
        const forRun = await mintKey(ownerId, WIDE_SCOPES, agentRung2, null);
        keyForRun = forRun.plaintext;
        keyForRunId = forRun.id;

        // Three READ steps on one granted tool. The engine resolves ONE
        // invocation for the whole execution, which is exactly the state that
        // makes "checked at the boundary" a different design from "checked at
        // dispatch".
        registerWorkflow({
            key: REVOKE_WF,
            name: 'Revocation probe',
            description: 'three reads in a row, so a revoke has somewhere to land',
            steps: [
                { kind: 'READ', label: 'first', tool: 'list_risks' },
                { kind: 'READ', label: 'second', tool: 'list_risks' },
                { kind: 'READ', label: 'third', tool: 'list_risks' },
            ],
        });
    });

    afterAll(async () => {
        await prisma
            .$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT);
                await tx.$executeRawUnsafe(
                    `DELETE FROM "TenantMembership" WHERE "tenantId" = $1`,
                    TENANT,
                );
            })
            .catch(() => {});
        await prisma.workflowStep.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.workflowRun.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.registeredAgentTool.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.tenantApiKey.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.risk.deleteMany({ where: { tenantId: TENANT } }).catch(() => {});
        await prisma.tenant.deleteMany({ where: { id: TENANT } }).catch(() => {});
        await prisma.$disconnect();
    });

    describe('exchange narrows, and never widens', () => {
        it('issues a token scoped to the tool it asked for', async () => {
            const { status, json } = await exchange(keyForExchange, 'list_risks');
            expect(status).toBe(201);
            expect(json.token_type).toBe('Bearer');
            expect(json.audience).toEqual(['list_risks']);
            expect(String(json.access_token)).toMatch(/^ifxt_/);
            // The subject token is not carried inside the issued one.
            expect(String(json.access_token)).not.toContain(keyForExchange);
        });

        it('the issued token calls the tool it names', async () => {
            const { json: minted } = await exchange(keyForExchange, 'list_risks');
            const { json } = await callTool(String(minted.access_token), 'list_risks');
            expect(errorMessageOf(json)).toBeUndefined();
            expect(resultOf(json)).toBeDefined();
        });

        it('and is REFUSED at a tool it does not name — same key, same grants', async () => {
            // The raw key reaches `list_controls` perfectly well…
            const viaKey = await callTool(keyForExchange, 'list_controls');
            expect(errorMessageOf(viaKey.json)).toBeUndefined();

            // …and the token minted from that same key does not.
            const { json: minted } = await exchange(keyForExchange, 'list_risks');
            const { json } = await callTool(String(minted.access_token), 'list_controls');
            expect(errorMessageOf(json)).toMatch(/list_controls/);

            const denial = await prisma.auditLog.findFirst({
                where: { tenantId: TENANT, action: 'AUTHZ_DENIED', entityId: 'list_controls' },
                orderBy: { createdAt: 'desc' },
            });
            expect(denial).not.toBeNull();
            expect(denial?.detailsJson).toMatchObject({ reason: 'audience_denied' });
        });

        it('a token for the resources surface cannot call a tool', async () => {
            const { status, json: minted } = await exchange(
                keyForExchange,
                MCP_RESOURCES_AUDIENCE,
            );
            expect(status).toBe(201);
            const { json } = await callTool(String(minted.access_token), 'list_risks');
            expect(errorMessageOf(json)).toMatch(/list_risks/);
        });

        it('a token cannot be minted for a tool the agent was never granted', async () => {
            // Deny-by-default exposure composes with the audience: exchange is
            // refused at issue rather than issued and refused later.
            const { status, json } = await exchange(keyForExchange, 'list_tasks');
            expect(status).toBe(403);
            expect((json.error as { message?: string } | undefined)?.message).toMatch(
                /list_tasks/,
            );
        });

        it('a token cannot be minted for something that is not a tool at all', async () => {
            const { status } = await exchange(keyForExchange, 'not_a_tool');
            expect(status).toBe(400);
        });

        it('an exchanged token cannot be exchanged AGAIN', async () => {
            const { json: minted } = await exchange(keyForExchange, 'list_risks');
            const again = await exchange(String(minted.access_token), 'list_controls');
            expect(again.status).toBe(400);
        });

        it('a delegation chain is refused rather than silently ignored', async () => {
            const { status } = await exchange(keyForExchange, 'list_risks', {
                actor_token: 'someone-else',
            });
            expect(status).toBe(400);
        });

        it('a revoked key cannot mint a token', async () => {
            const doomed = await mintKey(ownerId, WIDE_SCOPES, agentRung2, null);
            await prisma.tenantApiKey.update({
                where: { id: doomed.id },
                data: { revokedAt: new Date() },
            });
            const { status } = await exchange(doomed.plaintext, 'list_risks');
            expect(status).toBe(401);
        });
    });

    describe('the ceiling is the lower of the key and the agent', () => {
        it('a key with no ceiling reaches the tool its agent is registered for', async () => {
            const { json } = await callTool(keyNoCeiling, 'list_risks');
            expect(errorMessageOf(json)).toBeUndefined();
            expect(resultOf(json)).toBeDefined();
        });

        it('the SAME agent, a key capped at rung 0, reaches nothing', async () => {
            // Two credentials, one agent, identical scopes and identical grants.
            // The ceiling is the only difference — which is the claim that
            // authority belongs to the agent and a key may only narrow it.
            const { json } = await callTool(keyCeilingZero, 'list_risks');
            expect(errorMessageOf(json)).toMatch(/autonomy/i);

            const denial = await prisma.auditLog.findFirst({
                where: { tenantId: TENANT, action: 'AUTHZ_DENIED', entityId: 'list_risks' },
                orderBy: { createdAt: 'desc' },
            });
            expect(denial?.detailsJson).toMatchObject({
                reason: 'autonomy_denied',
                required: AUTONOMY_REQUIRED_BY_CAPABILITY.read,
                ceiling: 0,
            });
        });

        it('a key may not be minted with a ceiling above its agent', async () => {
            // Refused at creation rather than clamped at runtime: the runtime
            // `min` would make a stored 6 harmless, but the register is where
            // an operator reads an agent's authority, and a number there that
            // is not the effective one is a register that misinforms.
            const { createApiKey } = await import('@/app-layer/usecases/api-keys');
            const ctx = makeRequestContext('OWNER', {
                tenantId: TENANT,
                tenantSlug: TENANT,
                userId: ownerId,
            });
            await expect(
                createApiKey(ctx, {
                    name: 'over-ceiling',
                    scopes: ['mcp:read'],
                    agentId: agentRung2,
                    maxAutonomyLevel: 5,
                }),
            ).rejects.toThrow(/never widen it/);
        });

        it('a ceiling with no agent to be the lower of is refused', async () => {
            const { createApiKey } = await import('@/app-layer/usecases/api-keys');
            const ctx = makeRequestContext('OWNER', {
                tenantId: TENANT,
                tenantSlug: TENANT,
                userId: ownerId,
            });
            await expect(
                createApiKey(ctx, {
                    name: 'unbound-ceiling',
                    scopes: ['mcp:read'],
                    maxAutonomyLevel: 1,
                }),
            ).rejects.toThrow(/requires an agent binding/);
        });
    });

    describe('the risk-tier term is WIRED into the live funnel', () => {
        it('the fixture agents are SCORED — which is why the suite above passes', async () => {
            // Stated rather than assumed. From Agentic 3/10 an unscored agent
            // is refused every tool, so if this fixture ever reverted to NULL
            // every assertion in this file would fail for a reason that has
            // nothing to do with audiences or ceilings.
            const agent = await prisma.registeredAgent.findUniqueOrThrow({
                where: { id: agentRung2 },
                select: { riskTier: true, riskTierScoredAt: true, autonomyLevel: true },
            });
            expect(agent.riskTier).toBe('LOW');
            expect(agent.riskTierScoredAt).not.toBeNull();
            expect(agent.autonomyLevel).toBe(2);
        });

        it('unscoring the agent DENIES the read that same key just performed', async () => {
            // The load-bearing pair, driven through the real HTTP surface
            // rather than through the arithmetic: same agent, same key, same
            // grants, same tool. The only thing that changes is whether anybody
            // has assessed it.
            const before = await callTool(keyNoCeiling, 'list_risks');
            expect(errorMessageOf(before.json)).toBeUndefined();

            await prisma.registeredAgent.update({
                where: { id: agentRung2 },
                data: { riskTier: null, riskTierScoredAt: null },
            });
            try {
                const after = await callTool(keyNoCeiling, 'list_risks');
                // The refusal names the ASSESSMENT, not the registered autonomy
                // level — an operator sent to raise that number would be
                // editing the term that is not binding.
                expect(errorMessageOf(after.json)).toMatch(/risk-assessed/i);
                expect(resultOf(after.json)).toBeUndefined();

                const denial = await prisma.auditLog.findFirst({
                    where: { tenantId: TENANT, action: 'AUTHZ_DENIED', entityId: 'list_risks' },
                    orderBy: { createdAt: 'desc' },
                });
                expect(denial?.detailsJson).toMatchObject({
                    reason: 'autonomy_denied',
                    ceiling: DENY_CEILING,
                    unscored: true,
                    riskTier: null,
                });
            } finally {
                await prisma.registeredAgent.update({
                    where: { id: agentRung2 },
                    data: { riskTier: 'LOW', riskTierScoredAt: new Date() },
                });
            }
        });

        it('and scoring it again restores exactly the authority it had', async () => {
            // The other half of the pair. Without this, "the tier denies" is
            // indistinguishable from "something else broke and stayed broken".
            const { json } = await callTool(keyNoCeiling, 'list_risks');
            expect(errorMessageOf(json)).toBeUndefined();
            expect(resultOf(json)).toBeDefined();
        });

    });

    describe('revocation lands inside a run already in flight', () => {
        it('no further tool executes after the key is revoked mid-run', async () => {
            const ctx = makeRequestContext('ADMIN', {
                tenantId: TENANT,
                tenantSlug: TENANT,
                userId: ownerId,
                apiKeyId: keyForRunId,
                apiKeyScopes: WIDE_SCOPES,
                agentId: agentRung2,
            });

            // The spy is the whole test. A status-code assertion cannot
            // distinguish "refused at the tool boundary" from "refused at
            // dispatch" — both leave the run FAILED — so the property is stated
            // as a count of tool executions.
            const runs: number[] = [];
            const spy = jest
                .spyOn(listRisksTool, 'run')
                .mockImplementation(async (toolCtx, args) => {
                    runs.push(runs.length);
                    if (runs.length === 1) {
                        // The operator revokes, between step 1 and step 2.
                        await prisma.tenantApiKey.update({
                            where: { id: keyForRunId },
                            data: { revokedAt: new Date() },
                        });
                    }
                    return { risks: [], total: 0, ctx: toolCtx.tenantId, args };
                });

            try {
                const result = await startWorkflowRun(ctx, REVOKE_WF, {});
                expect(result.status).toBe('FAILED');

                // ONE execution. Steps 2 and 3 never reached their tool.
                expect(spy).toHaveBeenCalledTimes(1);

                const run = await getWorkflowRun(ctx, result.runId);
                expect(run.steps.filter((s) => s.status === 'DONE')).toHaveLength(1);
                const failed = run.steps.find((s) => s.status === 'FAILED');
                expect(failed?.seq).toBe(1);
                expect(run.errorMessage).toMatch(/revoked/i);
            } finally {
                spy.mockRestore();
                await prisma.tenantApiKey.update({
                    where: { id: keyForRunId },
                    data: { revokedAt: null },
                });
            }
        });

        it('and the refusal left a hash-chained AUTHZ_DENIED row naming the reason', async () => {
            const denial = await prisma.auditLog.findFirst({
                where: { tenantId: TENANT, action: 'AUTHZ_DENIED' },
                orderBy: { createdAt: 'desc' },
            });
            expect(denial).not.toBeNull();
            expect(denial?.detailsJson).toMatchObject({
                gate: 'mcp_tool_invocation',
                reason: 'credential_revoked',
            });
        });
    });
});
