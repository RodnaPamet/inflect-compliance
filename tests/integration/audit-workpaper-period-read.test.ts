/**
 * ONE PERIOD'S WORKPAPERS THROUGH `list_audit_workpapers`, END TO END (#3749).
 *
 * Driven through the REAL `/api/mcp` route with REAL `TenantApiKey` rows, so
 * the whole funnel is in the path: the `mcp:read` capability, the agent's
 * deny-by-default grant list, the named scope `audits:workpaper_view`, the
 * principal's own permission, and the provenance label.
 *
 *   1. The auditor agent's key, carrying the named scope and granted the tool,
 *      reads its OWN tenant's workpapers for the period, bounded, and never
 *      another tenant's.
 *   2. Every other credential is refused, each refusal writing exactly one
 *      `AUTHZ_DENIED` row: no scope, `audits:read`, `audits:write`,
 *      `audits:*`, `*`, an agent not granted the tool, and a principal who
 *      does not hold the view key.
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
import { POST } from '@/app/api/mcp/route';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `wpread-${randomUUID().slice(0, 8)}`;
const TENANT_A = `wa-${SUITE}`;
const TENANT_B = `wb-${SUITE}`;
const TOOL = 'list_audit_workpapers';
const PERIOD = '2026-09';
const DIGEST: Record<string, string> = { [TENANT_A]: 'a'.repeat(64), [TENANT_B]: 'b'.repeat(64) };

const ids: Record<string, { owner: string; second: string; reader: string; auditor: string; ungranted: string; workpapers: string[] }> = {};
const keys: Record<string, string> = {};

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

const callTool = (token: string, args: unknown) =>
    rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL, arguments: args } });
const listTools = (token: string) => rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

function contentOf(json: unknown): Array<{ text: string }> | undefined {
    return (json as { result?: { content?: Array<{ text: string }> } })?.result?.content;
}
const errorOf = (json: unknown) => (json as { error?: { message?: string } })?.error?.message;

interface ReadView {
    periodLabel: string;
    truncated: boolean;
    workpapers: Array<{ workpaperId: string; populationDigest: string; conclusion: string; exceptionCodes: unknown; reviewed: boolean }>;
}
function viewOf(json: unknown): ReadView {
    expect(errorOf(json)).toBeUndefined();
    return JSON.parse(contentOf(json)![0].text) as ReadView;
}

async function denials(tenantId: string) {
    return prisma.auditLog.count({ where: { tenantId, action: 'AUTHZ_DENIED' } });
}

/** Run one call that must be refused, and return how many AUTHZ_DENIED rows it wrote. */
async function refusedWithRows(tenantId: string, call: () => Promise<{ json: unknown }>): Promise<number> {
    const before = await denials(tenantId);
    const { json } = await call();
    expect(contentOf(json)).toBeUndefined();
    expect(errorOf(json)).toBeDefined();
    return (await denials(tenantId)) - before;
}

async function mintKey(tenantId: string, userId: string, scopes: string[], agentId: string | null): Promise<string> {
    const { plaintext, keyHash, keyPrefix } = generateApiKey();
    await prisma.tenantApiKey.create({
        data: { tenantId, name: `${scopes.join('+')}-${randomUUID().slice(0, 6)}`, keyPrefix, keyHash, scopes, createdById: userId, agentId },
    });
    return plaintext;
}

async function seedUser(suffix: string): Promise<string> {
    const userId = `u-${suffix}`;
    const email = `${suffix}@example.test`;
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, email, emailHash: hashForLookup(email) } });
    return userId;
}

/** An auditor agent, owned by the tenant's second-line ADMIN (the independence trigger's rule). */
async function seedAuditorAgent(tenantId: string, ownerUserId: string, name: string): Promise<string> {
    const aiSystem = await prisma.aiSystem.create({ data: { tenantId, name: `${name} host`, ownerUserId } });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: aiSystem.id,
            name,
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId,
            status: 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
            isAuditor: true,
        },
    });
    return agent.id;
}

/** Three workpapers for the period in tenant A (FAIL, PASS, INCONCLUSIVE), one in B. */
async function seedWorkpapers(tenantId: string, auditorAgentId: string, count: number): Promise<string[]> {
    const base = {
        tenantId,
        catalogueVersion: 1,
        periodLabel: PERIOD,
        populationDefinition: 'Employee rows with status TERMINATED and endDate inside the period',
        populationDigest: DIGEST[tenantId],
        auditorAgentId,
        controlTestRunId: `run-${tenantId}`,
    };
    const sample = (procedureId: string, units: string[]) => ({
        sampleEpoch: `${procedureId}@${PERIOD}`,
        seedFingerprint: 'c'.repeat(64),
        sampleSize: units.length,
        sampledUnitIds: units,
    });
    const rows = [
        {
            ...base,
            procedureId: 'iam.leaver_timeliness',
            populationCount: 4,
            ...sample('iam.leaver_timeliness', ['emp_1', 'emp_2']),
            attributesTested: ['L1', 'L2'],
            parametersJson: { leaverWindowHours: 24 },
            itemOutcomesJson: [
                { unitId: 'emp_1', outcome: 'PASS', code: null },
                { unitId: 'emp_2', outcome: 'EXCEPTION', code: 'ACCESS_NOT_REMOVED' },
            ],
            exceptionsJson: [{ unitId: 'emp_2', code: 'ACCESS_NOT_REMOVED' }],
            exceptionCount: 1,
            conclusion: 'FAIL' as const,
            conclusionBasis: 'EXCEPTIONS_FOUND',
        },
        {
            ...base,
            procedureId: 'iam.joiner_approval',
            populationCount: 2,
            ...sample('iam.joiner_approval', ['emp_3']),
            attributesTested: ['J1'],
            itemOutcomesJson: [{ unitId: 'emp_3', outcome: 'PASS', code: null }],
            exceptionsJson: [],
            exceptionCount: 0,
            conclusion: 'PASS' as const,
            conclusionBasis: 'ALL_SAMPLED_UNITS_PASSED',
        },
        {
            ...base,
            procedureId: 'iam.access_review_completion',
            populationCount: 0,
            itemOutcomesJson: [],
            exceptionsJson: [],
            exceptionCount: 0,
            conclusion: 'INCONCLUSIVE' as const,
            conclusionBasis: 'EMPTY_POPULATION',
        },
    ].slice(0, count);
    const out: string[] = [];
    for (const [i, data] of rows.entries()) {
        // Distinct creation times, so "oldest first" is a fact the test can read.
        const row = await prisma.auditWorkpaper.create({ data: { ...data, createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)) } });
        out.push(row.id);
    }
    return out;
}

async function seedTenant(tenantId: string, workpapers: number): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const owner = await seedUser(`${tenantId}-owner`);
    const second = await seedUser(`${tenantId}-second`);
    const reader = await seedUser(`${tenantId}-reader`);
    await prisma.tenantMembership.create({ data: { tenantId, userId: owner, role: 'OWNER', status: 'ACTIVE' } });
    await prisma.tenantMembership.create({
        data: { tenantId, userId: second, role: 'ADMIN', status: 'ACTIVE', lineOfDefence: 'SECOND' },
    });
    await prisma.tenantMembership.create({ data: { tenantId, userId: reader, role: 'READER', status: 'ACTIVE' } });
    const auditor = await seedAuditorAgent(tenantId, second, `Auditor ${tenantId}`);
    const ungranted = await seedAuditorAgent(tenantId, second, `Ungranted auditor ${tenantId}`);
    await prisma.registeredAgentTool.create({ data: { tenantId, agentId: auditor, toolName: TOOL, grantedByUserId: owner } });
    ids[tenantId] = { owner, second, reader, auditor, ungranted, workpapers: await seedWorkpapers(tenantId, auditor, workpapers) };
}

describeFn('list_audit_workpapers, end to end', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await seedTenant(TENANT_A, 3);
        await seedTenant(TENANT_B, 1);
        const a = ids[TENANT_A];
        const VIEW_SCOPES = ['mcp:read', 'audits:workpaper_view'];
        keys.view = await mintKey(TENANT_A, a.second, VIEW_SCOPES, a.auditor);
        keys.viewB = await mintKey(TENANT_B, ids[TENANT_B].second, VIEW_SCOPES, ids[TENANT_B].auditor);
        keys.noScope = await mintKey(TENANT_A, a.second, ['mcp:read'], a.auditor);
        keys.auditsRead = await mintKey(TENANT_A, a.second, ['mcp:read', 'audits:read'], a.auditor);
        keys.auditsWrite = await mintKey(TENANT_A, a.second, ['mcp:read', 'audits:write'], a.auditor);
        keys.auditsWildcard = await mintKey(TENANT_A, a.second, ['mcp:read', 'audits:*'], a.auditor);
        keys.star = await mintKey(TENANT_A, a.second, ['*'], a.auditor);
        keys.noGrant = await mintKey(TENANT_A, a.second, VIEW_SCOPES, a.ungranted);
        keys.readerPrincipal = await mintKey(TENANT_A, a.reader, VIEW_SCOPES, a.auditor);
    });

    afterAll(async () => {
        for (const t of [TENANT_A, TENANT_B]) {
            await deleteAuditRowsForTenants(prisma, t).catch(() => {});
            await prisma.auditWorkpaper.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.registeredAgentTool.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.tenantApiKey.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.registeredAgent.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma.aiSystem.deleteMany({ where: { tenantId: t } }).catch(() => {});
            await prisma
                .$transaction(async (tx) => {
                    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                    await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, t);
                })
                .catch(() => {});
            await prisma.tenant.deleteMany({ where: { id: t } }).catch(() => {});
        }
        await prisma.user.deleteMany({ where: { id: { contains: SUITE } } }).catch(() => {});
        await prisma.$disconnect();
    });

    describe('the auditor agent’s key, with the named scope and granted the tool', () => {
        it('reads its own tenant’s workpapers for the period, oldest first, labelled as agent output', async () => {
            const { json } = await callTool(keys.view, { periodLabel: PERIOD });
            const view = viewOf(json);
            expect(view).toMatchObject({ periodLabel: PERIOD, truncated: false });
            expect(view.workpapers.map((w) => w.workpaperId)).toEqual(ids[TENANT_A].workpapers);
            expect(view.workpapers.map((w) => w.conclusion)).toEqual(['FAIL', 'PASS', 'INCONCLUSIVE']);
            expect(view.workpapers[0].exceptionCodes).toEqual([{ code: 'ACCESS_NOT_REMOVED', count: 1 }]);
            expect(view.workpapers.every((w) => w.populationDigest === DIGEST[TENANT_A])).toBe(true);
            expect(JSON.parse(contentOf(json)![1].text)).toMatchObject({
                kind: 'content-provenance',
                tool: TOOL,
                mayCarryInstruction: false,
            });
        });

        it('carries no person: neither a member’s id nor a key holder’s', async () => {
            const text = JSON.stringify((await callTool(keys.view, { periodLabel: PERIOD })).json);
            for (const person of [ids[TENANT_A].owner, ids[TENANT_A].second, ids[TENANT_A].reader]) {
                expect(text).not.toContain(person);
            }
        });

        it('is bounded by limit, and says when it was', async () => {
            const capped = viewOf((await callTool(keys.view, { periodLabel: PERIOD, limit: 2 })).json);
            expect(capped.truncated).toBe(true);
            expect(capped.workpapers.map((w) => w.workpaperId)).toEqual(ids[TENANT_A].workpapers.slice(0, 2));
            const exact = viewOf((await callTool(keys.view, { periodLabel: PERIOD, limit: 3 })).json);
            expect(exact.truncated).toBe(false);
        });

        it('reads an empty period as empty, not as a refusal', async () => {
            expect(viewOf((await callTool(keys.view, { periodLabel: '2026-Q3' })).json)).toEqual({
                periodLabel: '2026-Q3',
                workpapers: [],
                truncated: false,
            });
        });

        it('refuses a malformed period and an out-of-range limit', async () => {
            for (const args of [{ periodLabel: '2026-13' }, { periodLabel: PERIOD, limit: 0 }, { periodLabel: PERIOD, limit: 51 }]) {
                const { json } = await callTool(keys.view, args);
                expect(contentOf(json)).toBeUndefined();
                expect(errorOf(json)).toBeDefined();
            }
        });

        it('is offered the tool in tools/list', async () => {
            const { json } = await listTools(keys.view);
            const names = ((json as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? []).map((t) => t.name);
            expect(names).toContain(TOOL);
        });

        it('never reads another tenant’s workpapers, and the other tenant reads only its own', async () => {
            const a = JSON.stringify((await callTool(keys.view, { periodLabel: PERIOD })).json);
            expect(a).not.toContain(DIGEST[TENANT_B]);
            for (const id of ids[TENANT_B].workpapers) expect(a).not.toContain(id);

            const b = viewOf((await callTool(keys.viewB, { periodLabel: PERIOD })).json);
            expect(b.workpapers.map((w) => w.workpaperId)).toEqual(ids[TENANT_B].workpapers);
            expect(JSON.stringify(b)).not.toContain(DIGEST[TENANT_A]);
        });
    });

    describe('every other credential is refused, and each refusal writes exactly one AUTHZ_DENIED row', () => {
        const REFUSED = ['noScope', 'auditsRead', 'auditsWrite', 'auditsWildcard', 'star', 'noGrant', 'readerPrincipal'];

        it.each([
            ['no view scope (mcp:read alone)', 'noScope'],
            ['audits:read, which is every role’s audits.view', 'auditsRead'],
            ['audits:write, which manages audits and does not reach the named group', 'auditsWrite'],
            ['audits:*, which does not reach the named group', 'auditsWildcard'],
            ['*, which subtracts the view key', 'star'],
            ['the view scope, on an agent NOT granted the tool', 'noGrant'],
            ['the view scope, minted by a READER who does not hold the key', 'readerPrincipal'],
        ])('%s', async (_label, key) => {
            expect(await refusedWithRows(TENANT_A, () => callTool(keys[key], { periodLabel: PERIOD }))).toBe(1);
        });

        it('none of the refused keys is offered the tool', async () => {
            for (const key of REFUSED) {
                const { json } = await listTools(keys[key]);
                const names = ((json as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? []).map((t) => t.name);
                expect({ key, offered: names.includes(TOOL) }).toEqual({ key, offered: false });
            }
        });
    });
});
