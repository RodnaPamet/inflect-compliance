/**
 * An agent cannot exceed the human it speaks for.
 *
 * Drives the REAL `/api/mcp` route with REAL `TenantApiKey` credentials against
 * a REAL database — the usecase layer is not called directly anywhere here,
 * because the property under test is a property of the request path.
 *
 * ## What each block proves, and why it is the interesting question
 *
 *   1. TWO IDENTICAL CREDENTIALS, DIFFERENT PRINCIPALS. Both keys carry exactly
 *      `['mcp:propose', 'risks:read']`; one was minted by a READER, the other by
 *      an EDITOR. Before this change `verifyApiKey` derived authority from the
 *      SCOPES alone, so the two were indistinguishable and both could queue a
 *      risk proposal — one of them on behalf of somebody who cannot create a
 *      risk. Same bytes in, opposite answers out, is the whole claim.
 *
 *   2. THE READ CASE. A principal whose CUSTOM ROLE denies `risks.view` gets no
 *      risk rows out of ANY tool: `list_risks` is refused outright, and — the
 *      part that is easy to get wrong — the cross-domain posture and grounding
 *      tools, which the principal IS allowed to call, come back with their risk
 *      sections and their risk activity rows removed. Gating the call is not the
 *      same claim as returning only what the caller may read, and the second one
 *      is where the data actually leaves.
 *
 *   3. TWO TENANTS. A tenant-A credential sees zero of tenant B's rows under
 *      every read tool the suite can reach, not just the one that is convenient.
 *
 *   4. DENY-BY-DEFAULT EXPOSURE. A tool that the agent's registration does not
 *      list is unreachable even when the credential is scoped for it and the
 *      principal is permitted to do it — the two things that used to be the
 *      whole of the decision.
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
import { getPermissionsForRole } from '@/lib/permissions';
import { appendAuditEntry } from '@/lib/audit';
import { POST } from '@/app/api/mcp/route';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `authz-${randomUUID().slice(0, 8)}`;
const TENANT_A = `pa-${SUITE}`;
const TENANT_B = `pb-${SUITE}`;

/** Every tool this suite drives, granted to each seeded agent. */
const GRANTED_TOOLS = [
    'list_risks',
    'list_controls',
    'list_tasks',
    'get_compliance_posture',
    'get_tenant_context',
    'propose_risks',
];

/** Domain read scopes wide enough that the CREDENTIAL is never the limit. */
const WIDE_READ_SCOPES = [
    'mcp:read',
    'risks:read',
    'controls:read',
    'tasks:read',
    'evidence:read',
    'audits:read',
];

let agentA = '';
let agentB = '';

// Same scopes, different principals — block 1.
let keyProposeReader = '';
let keyProposeEditor = '';
// An OWNER principal with a custom role that denies `risks.view` — block 2.
let keyRiskBlind = '';
// A full-authority tenant-A key, and its tenant-B twin — block 3.
let keyOwnerA = '';
let keyOwnerB = '';
// Granted NOTHING — block 4.
let keyUngrantedTool = '';
let agentNoTools = '';

async function rpc(token: string, body: unknown): Promise<{ status: number; json: unknown }> {
    const req = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    const res = await POST(req, { params: Promise.resolve({}) } as never);
    let json: unknown = null;
    try {
        json = await res.json();
    } catch {
        /* 202 / empty */
    }
    return { status: res.status, json };
}

function callTool(token: string, name: string, args: unknown = {}) {
    return rpc(token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
    });
}

/** The JSON-RPC result payload, or `undefined` when the call was refused. */
function resultOf(json: unknown): unknown {
    const r = json as { result?: { content?: Array<{ text: string }> } };
    const text = r?.result?.content?.[0]?.text;
    return text === undefined ? undefined : JSON.parse(text);
}

function errorMessageOf(json: unknown): string | undefined {
    return (json as { error?: { message?: string } })?.error?.message;
}

async function mintKey(
    tenantId: string,
    userId: string,
    scopes: string[],
    agentId: string | null,
): Promise<string> {
    const { plaintext, keyHash, keyPrefix } = generateApiKey();
    await prisma.tenantApiKey.create({
        data: {
            tenantId,
            name: `${scopes.join('+')}-${randomUUID().slice(0, 6)}`,
            keyPrefix,
            keyHash,
            scopes,
            createdById: userId,
            agentId,
        },
    });
    return plaintext;
}

/** `User` is a GLOBAL table — no tenant, by design. Membership is separate. */
async function seedUser(suffix: string): Promise<string> {
    const userId = `u-${suffix}`;
    const email = `${suffix}@example.test`;
    await prisma.user.upsert({
        where: { id: userId },
        update: {},
        create: { id: userId, email, emailHash: hashForLookup(email) },
    });
    return userId;
}

async function member(
    tenantId: string,
    userId: string,
    role: 'OWNER' | 'EDITOR' | 'READER',
    customRoleId?: string,
): Promise<void> {
    await prisma.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId, userId } },
        update: { role, status: 'ACTIVE', customRoleId: customRoleId ?? null },
        create: { tenantId, userId, role, status: 'ACTIVE', customRoleId: customRoleId ?? null },
    });
}

async function seedAgent(tenantId: string, ownerUserId: string, name: string): Promise<string> {
    const aiSystem = await prisma.aiSystem.create({
        data: { tenantId, name: `${name} host`, ownerUserId },
    });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: aiSystem.id,
            name,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId,
            status: 'ACTIVE',
        },
    });
    return agent.id;
}

async function grantTools(tenantId: string, agentId: string, userId: string, tools: string[]) {
    for (const toolName of tools) {
        await prisma.registeredAgentTool.create({
            data: { tenantId, agentId, toolName, grantedByUserId: userId },
        });
    }
}

async function seedTenant(tenantId: string, riskCount: number, taskCount: number): Promise<void> {
    await prisma.tenant.upsert({
        where: { id: tenantId },
        update: {},
        create: { id: tenantId, name: tenantId, slug: tenantId },
    });
    const owner = await seedUser(`${tenantId}-owner`);
    await member(tenantId, owner, 'OWNER');
    for (let i = 0; i < riskCount; i++) {
        await prisma.risk.create({
            data: {
                tenantId,
                title: `${tenantId}-risk-${i}`,
                description: 'x',
                category: 'Cybersecurity',
                impact: 3,
                likelihood: 3,
                score: 9,
                inherentScore: 9,
                status: 'OPEN',
                createdByUserId: owner,
            },
        });
    }
    for (let i = 0; i < taskCount; i++) {
        await prisma.task.create({
            data: {
                tenantId,
                key: `${tenantId.slice(0, 6).toUpperCase()}-${i}`,
                title: `${tenantId}-task-${i}`,
                status: 'OPEN',
                createdByUserId: owner,
            },
        });
    }
}

describeFn('an agent cannot exceed the human it speaks for', () => {
    beforeAll(async () => {
        await prisma.$connect();

        await seedTenant(TENANT_A, 3, 2);
        await seedTenant(TENANT_B, 5, 4);

        const ownerA = `u-${TENANT_A}-owner`;
        const ownerB = `u-${TENANT_B}-owner`;

        // ── block 1: two principals, one credential shape ──
        const readerId = await seedUser(`${SUITE}-reader`);
        const editorId = await seedUser(`${SUITE}-editor`);
        await member(TENANT_A, readerId, 'READER');
        await member(TENANT_A, editorId, 'EDITOR');

        // ── block 2: an OWNER narrowed by a custom role ──
        // A real `TenantCustomRole`, not a hand-built permission blob: the
        // narrowing has to travel the path `resolveTenantContext` actually
        // reads, or the test proves something about a fixture.
        const riskBlindPermissions = getPermissionsForRole('OWNER');
        const blindRoleRow = await prisma.tenantCustomRole.create({
            data: {
                tenantId: TENANT_A,
                name: `risk-blind-${SUITE}`,
                baseRole: 'OWNER',
                // The OBJECT, not `JSON.stringify` of it: the column is a
                // Prisma `Json` field, and a stringified value lands as a JSON
                // string, which `parsePermissionsJson` rejects as non-object and
                // silently falls back to the base role's full permissions — the
                // narrowing would vanish and every assertion below would pass
                // for the wrong reason.
                permissionsJson: {
                    ...riskBlindPermissions,
                    risks: { view: false, create: false, edit: false },
                },
            },
        });
        const blindId = await seedUser(`${SUITE}-blind`);
        await member(TENANT_A, blindId, 'OWNER', blindRoleRow.id);

        agentA = await seedAgent(TENANT_A, ownerA, 'Tenant A reconciler');
        agentB = await seedAgent(TENANT_B, ownerB, 'Tenant B reconciler');
        agentNoTools = await seedAgent(TENANT_A, ownerA, 'Ungranted reconciler');

        await grantTools(TENANT_A, agentA, ownerA, GRANTED_TOOLS);
        await grantTools(TENANT_B, agentB, ownerB, GRANTED_TOOLS);
        // agentNoTools is granted NOTHING, on purpose.

        keyProposeReader = await mintKey(
            TENANT_A, readerId, ['mcp:propose', 'risks:read'], agentA,
        );
        keyProposeEditor = await mintKey(
            TENANT_A, editorId, ['mcp:propose', 'risks:read'], agentA,
        );
        keyRiskBlind = await mintKey(TENANT_A, blindId, WIDE_READ_SCOPES, agentA);
        keyOwnerA = await mintKey(TENANT_A, ownerA, WIDE_READ_SCOPES, agentA);
        keyOwnerB = await mintKey(TENANT_B, ownerB, WIDE_READ_SCOPES, agentB);
        keyUngrantedTool = await mintKey(TENANT_A, ownerA, WIDE_READ_SCOPES, agentNoTools);
    });

    afterAll(async () => {
        for (const t of [TENANT_A, TENANT_B]) {
            // AuditLog is immutable and its trigger fires on an ordinary
            // DELETE; TenantMembership has the last-OWNER guard. Both need the
            // replica-mode escape or the teardown takes the suite down with it.
            await prisma
                .$transaction(async (tx) => {
                    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                    await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, t);
                    await tx.$executeRawUnsafe(
                        `DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, t,
                    );
                })
                .catch(() => {});
            await prisma.agentProposal.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.registeredAgentTool.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.tenantApiKey.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.registeredAgent.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.aiSystem.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.task.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.risk.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.tenantCustomRole.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.tenant.deleteMany({ where: { id: t } }).catch(() => {});
        }
        await prisma.$disconnect();
    });

    describe('the same credential, two different principals', () => {
        it('a key whose principal is a READER cannot propose a risk', async () => {
            const before = await prisma.agentProposal.count({ where: { tenantId: TENANT_A } });

            const { json } = await callTool(keyProposeReader, 'propose_risks', {
                items: [{ title: 'Reader-proposed risk', description: 'should never queue' }],
            });

            expect(resultOf(json)).toBeUndefined();
            expect(errorMessageOf(json)).toBeDefined();

            // The refusal is worthless if the row landed anyway.
            const after = await prisma.agentProposal.count({ where: { tenantId: TENANT_A } });
            expect(after).toBe(before);
        });

        it('the SAME credential shape, minted by an EDITOR, can', async () => {
            // The paired positive. Without it the assertion above is equally
            // consistent with a propose surface that is simply broken.
            const before = await prisma.agentProposal.count({ where: { tenantId: TENANT_A } });

            const { json } = await callTool(keyProposeEditor, 'propose_risks', {
                items: [{ title: 'Editor-proposed risk', description: 'should queue' }],
            });

            const result = resultOf(json) as { proposed?: number; status?: string } | undefined;
            expect(errorMessageOf(json)).toBeUndefined();
            expect(result?.proposed).toBe(1);
            expect(result?.status).toBe('PENDING');

            const after = await prisma.agentProposal.count({ where: { tenantId: TENANT_A } });
            expect(after).toBe(before + 1);
        });

        it('the two keys are otherwise identical — the principal is the only difference', async () => {
            // Anti-vacuity for the pair above: if the scopes or the agent
            // binding differed, the opposite outcomes would prove nothing about
            // the principal.
            const rows = await prisma.tenantApiKey.findMany({
                where: { tenantId: TENANT_A, createdById: { in: [`u-${SUITE}-reader`, `u-${SUITE}-editor`] } },
                select: { scopes: true, agentId: true, createdById: true },
            });
            expect(rows).toHaveLength(2);
            expect(rows[0].scopes).toEqual(rows[1].scopes);
            expect(rows[0].agentId).toBe(rows[1].agentId);
            expect(rows[0].createdById).not.toBe(rows[1].createdById);
        });
    });

    describe('a read tool returns only rows the acting principal may see', () => {
        it('the domain tool itself is refused', async () => {
            const { json } = await callTool(keyRiskBlind, 'list_risks');
            expect(resultOf(json)).toBeUndefined();
            expect(errorMessageOf(json)).toBe('Permission denied');
        });

        it('and the SAME principal can still read the domain it is allowed', async () => {
            // Paired positive: the narrowing is `risks.view`, not "this key is
            // broken". Without it a total failure would read as a pass.
            const { json } = await callTool(keyRiskBlind, 'list_tasks');
            expect(errorMessageOf(json)).toBeUndefined();
            const tasks = resultOf(json) as Array<{ title: string }>;
            expect(tasks.length).toBe(2);
        });

        it('the cross-domain posture tool it MAY call comes back with the risk sections gone', async () => {
            const { json } = await callTool(keyRiskBlind, 'get_compliance_posture');
            expect(errorMessageOf(json)).toBeUndefined();
            const posture = resultOf(json) as Record<string, unknown> & {
                stats?: Record<string, unknown>;
                redactedDomains?: string[];
            };

            // The call succeeded — this is not a refusal in disguise.
            expect(posture.controlCoverage).toBeDefined();
            // …and every risk-shaped field is absent, not zero. A zero would be
            // a lie the agent would reason over.
            expect(posture.riskBySeverity).toBeUndefined();
            expect(posture.riskByStatus).toBeUndefined();
            expect(posture.stats).toBeDefined();
            expect(posture.stats).not.toHaveProperty('risks');
            expect(posture.stats).not.toHaveProperty('highRisks');
            expect(posture.redactedDomains).toContain('risks.view');
        });

        it('an OWNER with no custom role gets those same sections', async () => {
            // The other half of the redaction claim: the sections exist and are
            // populated for a principal who may see them, so their absence
            // above is the policy and not the payload shape.
            const { json } = await callTool(keyOwnerA, 'get_compliance_posture');
            const posture = resultOf(json) as {
                riskBySeverity?: unknown;
                stats?: { risks?: number };
            };
            expect(posture.riskBySeverity).toBeDefined();
            expect(posture.stats?.risks).toBe(3);
        });

        it('the grounding feed drops the ROWS whose domain the principal cannot see', async () => {
            // The strongest form of the claim: `recentActivity` interleaves
            // every domain in one array, so a section-level rule cannot express
            // it. Seed one audit row per domain and assert only the permitted
            // one survives.
            // Written through `appendAuditEntry`, the real hash-chained
            // writer, rather than a raw INSERT: a hand-made row with an invented
            // `entryHash` would leave this tenant's chain permanently broken and
            // any later chain assertion meaningless.
            for (const [entity, action] of [
                ['Risk', 'RISK_CREATED'],
                ['Control', 'CONTROL_CREATED'],
            ] as const) {
                await appendAuditEntry({
                    tenantId: TENANT_A,
                    userId: `u-${TENANT_A}-owner`,
                    entity,
                    entityId: `${entity}-${SUITE}`,
                    action,
                    detailsJson: { category: 'entity_lifecycle' },
                });
            }

            const { json } = await callTool(keyRiskBlind, 'get_tenant_context');
            const ctx = resultOf(json) as { recentActivity?: Array<{ entity: string }> };
            const entities = (ctx.recentActivity ?? []).map((r) => r.entity);

            // Anti-vacuity: the feed is not simply empty.
            expect(entities).toContain('Control');
            expect(entities).not.toContain('Risk');
        });
    });

    describe('two tenants', () => {
        it("a tenant-A credential reads none of tenant B's risks", async () => {
            const { json } = await callTool(keyOwnerA, 'list_risks');
            const risks = resultOf(json) as Array<{ title: string }>;
            expect(risks.length).toBe(3);
            expect(risks.every((r) => r.title.startsWith(TENANT_A))).toBe(true);
        });

        it("a tenant-B credential reads none of tenant A's risks", async () => {
            const { json } = await callTool(keyOwnerB, 'list_risks');
            const risks = resultOf(json) as Array<{ title: string }>;
            expect(risks.length).toBe(5);
            expect(risks.every((r) => r.title.startsWith(TENANT_B))).toBe(true);
        });

        it('the isolation holds under every tool this suite can reach', async () => {
            // One tool proving isolation is one tool. The leak, when it comes,
            // will be in whichever tool nobody checked.
            for (const tool of ['list_risks', 'list_controls', 'list_tasks', 'get_tenant_context']) {
                const { json } = await callTool(keyOwnerA, tool);
                const text = JSON.stringify(resultOf(json) ?? {});
                expect(text).not.toContain(TENANT_B);
            }
        });
    });

    describe('deny-by-default tool exposure', () => {
        it('an agent granted nothing reaches no tool, however wide its key', async () => {
            const { json } = await callTool(keyUngrantedTool, 'list_risks');
            expect(resultOf(json)).toBeUndefined();
            expect(errorMessageOf(json)).toMatch(/not granted/i);
        });

        it('the same call succeeds once the tool is granted, and stops when it is revoked', async () => {
            // Grant → allowed → revoke → refused, on one credential. The
            // round trip is the test: a one-way assertion cannot tell a
            // working allowlist from a check that never runs after the first
            // request.
            await prisma.registeredAgentTool.create({
                data: {
                    tenantId: TENANT_A,
                    agentId: agentNoTools,
                    toolName: 'list_risks',
                    grantedByUserId: `u-${TENANT_A}-owner`,
                },
            });

            const allowed = await callTool(keyUngrantedTool, 'list_risks');
            expect(errorMessageOf(allowed.json)).toBeUndefined();
            expect((resultOf(allowed.json) as unknown[]).length).toBe(3);

            await prisma.registeredAgentTool.deleteMany({
                where: { tenantId: TENANT_A, agentId: agentNoTools, toolName: 'list_risks' },
            });

            const refused = await callTool(keyUngrantedTool, 'list_risks');
            expect(errorMessageOf(refused.json)).toMatch(/not granted/i);
        });

        it('tools/list advertises nothing for an agent granted nothing', async () => {
            const { json } = await rpc(keyUngrantedTool, {
                jsonrpc: '2.0', id: 9, method: 'tools/list',
            });
            const tools = (json as { result: { tools: Array<{ name: string }> } }).result.tools;
            expect(tools).toEqual([]);
        });
    });
});
