/**
 * #2569 — the agent-governance reports API, REFUSED at the route.
 *
 * AGENTIC UI 4/4 item 10 asked for the endpoint to be gated with
 * `requirePermission` "so a denial writes a hash-chained AUTHZ_DENIED row", and
 * named this file to prove it. The gate shipped; the proof did not. Nothing in
 * the tree drove either reports route handler, so every property the owner
 * asked for — the status code, the withheld key, the single audit row — was
 * unwitnessed on this surface.
 *
 * ## Why the three neighbours that look like coverage are not
 *
 *   - `tests/guardrails/admin-route-coverage.test.ts` is a FILE SCANNER. It
 *     asserts the route module imports `requirePermission`. It cannot see a
 *     status code, a response body, or whether a row was written.
 *   - `tests/integration/agents-subpage-authz.test.ts` covers the PAGE, whose
 *     refusal is an `appPermissions` check rendering `<ForbiddenPage>`. That
 *     refusal writes NO audit row at all — so the one denial class that produces
 *     the hash-chained row was the one with no test.
 *   - `tests/integration/agentic-reports-export.test.ts` calls the USECASE
 *     directly. A usecase throw is not an HTTP response and writes no
 *     AUTHZ_DENIED row. It proves the floor; this file proves the gate.
 *
 * ## The refused principal is a NEIGHBOUR, not a reader
 *
 * `neighbourKeyCtx` holds `admin.agent_tool_exposure`, `admin.agent_policy_card`
 * and `admin.agent_kill_switch` — and every other ADMIN key — but NOT
 * `admin.agent_registry`. A bare READER would be refused by a route gated on any
 * admin key whatever, so a suite that refused one would pass on a wrongly-keyed
 * gate. The neighbour composition is the one the key split exists to prevent.
 *
 * The positive is the mirror image and is load-bearing for the same reason:
 * `registryOnlyCtx` holds `admin.agent_registry` and NOT the three neighbours.
 * Pinning both directions is what makes the enforced key exactly
 * `admin.agent_registry` rather than "some privileged key" — a route re-keyed to
 * a neighbour still 403s the people it should, and is caught here only because
 * the registry-only principal must get through.
 *
 * ## The export route has TWO denial classes and they are NOT symmetric
 *
 * `agent-governance-pack-export.ts` refuses a caller without
 * `admin.agent_registry` at the ROUTE (one row), and a caller holding it but not
 * `evidence.edit` inside the USECASE (zero rows). So a 403 on `…/reports/export`
 * means "exactly one row" or "no row at all" depending on which gate fired.
 * Stated here rather than left implicit — an asymmetry nobody has written down
 * is one somebody later reads as a logging bug and "fixes".
 *
 * Only `getTenantCtx` is mocked. `requirePermission`, `assertPermission`,
 * `appendAuditEntry`, the usecases and RLS are all real.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { getPermissionsForRole } from '@/lib/permissions';
import { resolveRoutePermission } from '@/lib/security/route-permissions';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { GET as REPORTS_GET } from '@/app/api/t/[tenantSlug]/admin/agents/reports/route';
import { POST as EXPORT_POST } from '@/app/api/t/[tenantSlug]/admin/agents/reports/export/route';
import { makeRequestContext } from '../helpers/make-context';
import type { RequestContext } from '@/app-layer/types';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `ra-${randomUUID().slice(0, 8)}`;
const TENANT_A = `raa-${SUITE}`;
const TENANT_B = `rab-${SUITE}`;
const TENANTS = [TENANT_A, TENANT_B] as const;

/**
 * Distinguishable on sight and unique per run, so the isolation arm is a claim
 * about THIS suite's rows and not about whatever else the shared database holds.
 */
const AGENT_NAME: Record<string, string> = {
    [TENANT_A]: `Alpha register agent ${SUITE}`,
    [TENANT_B]: `Bravo register agent ${SUITE}`,
};

const users: Record<string, string> = {};
const agents: Record<string, string> = {};

// ─── Contexts ───────────────────────────────────────────────────────

function ownerCtx(tenantId: string, overrides: Partial<RequestContext> = {}): RequestContext {
    return makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: users[tenantId],
        ...overrides,
    });
}

/**
 * An ADMIN whose custom role holds the NEIGHBOURING agent keys and not this one.
 *
 * Somebody trusted to widen an approved agent's tool list, amend its policy card
 * and pull its kill switch, who must not thereby be able to read a pack that
 * names who approved what. A test that refused a READER would pass on a route
 * gated by `admin.manage`; this one would not.
 */
function neighbourKeyCtx(tenantId: string): RequestContext {
    const base = getPermissionsForRole('ADMIN');
    return makeRequestContext('ADMIN', {
        tenantId,
        tenantSlug: tenantId,
        userId: users[tenantId],
        appPermissions: {
            ...base,
            admin: {
                ...base.admin,
                agent_registry: false,
                agent_tool_exposure: true,
                agent_policy_card: true,
                agent_kill_switch: true,
            },
        },
    });
}

/**
 * The mirror: holds `admin.agent_registry` and NOT the three neighbours.
 *
 * This is what pins the enforced key to the DECLARED key. A route re-keyed to
 * `admin.agent_tool_exposure` would still refuse a reader, still refuse an
 * auditor, and still look gated — and would admit the neighbour above while
 * refusing this principal. Both arms together are the only way to say which key.
 */
function registryOnlyCtx(tenantId: string): RequestContext {
    const base = getPermissionsForRole('OWNER');
    return makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: users[tenantId],
        appPermissions: {
            ...base,
            admin: {
                ...base.admin,
                agent_registry: true,
                agent_tool_exposure: false,
                agent_policy_card: false,
                agent_kill_switch: false,
            },
        },
    });
}

/** Holds the register key, may not write evidence. The export's SECOND gate. */
function noEvidenceEditCtx(tenantId: string): RequestContext {
    const base = getPermissionsForRole('OWNER');
    return makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: users[tenantId],
        appPermissions: { ...base, evidence: { ...base.evidence, edit: false } },
    });
}

// ─── Driving the routes ─────────────────────────────────────────────

const routeArgs = (tenantId: string) => ({ params: Promise.resolve({ tenantSlug: tenantId }) });

function reportsReq(tenantId: string): NextRequest {
    return new NextRequest(`http://localhost/api/t/${tenantId}/admin/agents/reports`, {
        method: 'GET',
    });
}

function exportReq(tenantId: string): NextRequest {
    return new NextRequest(`http://localhost/api/t/${tenantId}/admin/agents/reports/export`, {
        method: 'POST',
        headers: new Headers({ 'content-type': 'application/json' }),
    });
}

async function countDenials(tenantId: string): Promise<number> {
    return prisma.auditLog.count({ where: { tenantId, action: 'AUTHZ_DENIED' } });
}

async function countEvidence(tenantId: string): Promise<number> {
    return prisma.evidence.count({ where: { tenantId } });
}

// ─── Fixture ────────────────────────────────────────────────────────

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [...TENANTS] } };
    await prisma.evidenceControlLink.deleteMany({ where: t }).catch(() => {});
    await prisma.evidence.deleteMany({ where: t }).catch(() => {});
    await prisma.registeredAgentTool.deleteMany({ where: t }).catch(() => {});
    await prisma.registeredAgent.deleteMany({ where: t }).catch(() => {});
    await prisma.aiSystemRequirementLink.deleteMany({ where: t }).catch(() => {});
    await prisma.aiSystem.deleteMany({ where: t }).catch(() => {});
    await prisma.tenantSecuritySettings.deleteMany({ where: t }).catch(() => {});
    await deleteAuditRowsForTenants(prisma, [...TENANTS]).catch(() => {});
    // `TenantMembership` carries the last-OWNER guard; the audit trails carry
    // their own immutability trigger and go through the helper above. See
    // `tests/integration/db-helper.ts` for why the predicate is never optional.
    await prisma
        .$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(
                `DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`,
                [...TENANTS],
            );
        })
        .catch(() => {});
    await prisma.user
        .deleteMany({
            where: { emailHash: { in: TENANTS.map((x) => hashForLookup(`owner@${x}.test`)) } },
        })
        .catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: { in: [...TENANTS] } } }).catch(() => {});
}

describeFn('the agent-governance reports API refuses at the route, and says so once (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await clearOwnRows();
        for (const tenantId of TENANTS) {
            await prisma.tenant.create({
                data: { id: tenantId, name: `Workspace ${tenantId}`, slug: tenantId },
            });
            const email = `owner@${tenantId}.test`;
            const user = await prisma.user.create({
                data: { email, emailHash: hashForLookup(email) },
            });
            users[tenantId] = user.id;
            await prisma.tenantMembership.create({
                data: { tenantId, userId: user.id, role: 'OWNER', status: 'ACTIVE' },
            });
            await prisma.tenantSecuritySettings.create({
                data: { tenantId, requireRegisteredAgent: false },
            });
            const aiSystem = await prisma.aiSystem.create({
                data: { tenantId, name: `System of ${tenantId}`, ownerUserId: user.id },
            });
            const agent = await createRegisteredAgent(ownerCtx(tenantId), {
                aiSystemId: aiSystem.id,
                name: AGENT_NAME[tenantId],
                description: 'fixture',
                autonomyLevel: 2,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: user.id,
            });
            agents[tenantId] = agent.id;
        }
    });

    afterEach(() => {
        getTenantCtxMock.mockReset();
    });

    afterAll(async () => {
        await clearOwnRows();
        await prisma.$disconnect();
    });

    // ── The declarative map ─────────────────────────────────────────

    it('the map resolves BOTH report paths to the register key, and a neighbour path to its own', () => {
        expect(
            resolveRoutePermission(`/api/t/${TENANT_A}/admin/agents/reports`, 'GET')?.permission,
        ).toBe('admin.agent_registry');
        expect(
            resolveRoutePermission(`/api/t/${TENANT_A}/admin/agents/reports/export`, 'POST')
                ?.permission,
        ).toBe('admin.agent_registry');
        // The neighbour still resolves to the neighbour's key — so the two above
        // are about rule ORDERING, not a rule that matches everything under
        // `admin/agents` and would agree with any key I asserted.
        expect(
            resolveRoutePermission(`/api/t/${TENANT_A}/admin/agents/${agents[TENANT_A]}/tools`, 'POST')
                ?.permission,
        ).toBe('admin.agent_tool_exposure');
    });

    // ── GET: refused, audited once, told nothing ────────────────────

    it('GET refuses a principal holding the NEIGHBOURING agent keys, audits it once, and echoes no key', async () => {
        getTenantCtxMock.mockResolvedValue(neighbourKeyCtx(TENANT_A));
        const before = await countDenials(TENANT_A);

        const res = await REPORTS_GET(reportsReq(TENANT_A), routeArgs(TENANT_A));
        expect(res.status).toBe(403);

        // The 403 never echoes the key — otherwise the permission namespace is
        // enumerable one request at a time.
        const body = JSON.stringify(await res.json());
        expect(body).not.toContain('agent_registry');
        expect(body).not.toContain('admin.');

        // EXACTLY one row, not "at least one". A second gate a layer down would
        // double every denial and make the trail count refusals rather than
        // attempts — and `toBeGreaterThan` would never notice.
        expect(await countDenials(TENANT_A)).toBe(before + 1);
        const row = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: TENANT_A, action: 'AUTHZ_DENIED' },
            orderBy: { createdAt: 'desc' },
        });
        expect(row.entity).toBe('Permission');
        expect(row.entityId).toBe('admin.agent_registry');
        expect(row.entryHash).not.toBeNull();
    });

    // ── POST /export: refused, audited once, and NOTHING filed ──────

    it('the export POST refuses the same principal, audits it once, and files no evidence', async () => {
        getTenantCtxMock.mockResolvedValue(neighbourKeyCtx(TENANT_A));
        const before = await countDenials(TENANT_A);
        const evidenceBefore = await countEvidence(TENANT_A);

        const res = await EXPORT_POST(exportReq(TENANT_A), routeArgs(TENANT_A));
        expect(res.status).toBe(403);

        const body = JSON.stringify(await res.json());
        expect(body).not.toContain('agent_registry');
        expect(body).not.toContain('admin.');

        expect(await countDenials(TENANT_A)).toBe(before + 1);
        const row = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: TENANT_A, action: 'AUTHZ_DENIED' },
            orderBy: { createdAt: 'desc' },
        });
        expect(row.entityId).toBe('admin.agent_registry');

        // …and nothing was filed. A route that audited the denial and then ran
        // the handler anyway would pass every assertion above it.
        expect(await countEvidence(TENANT_A)).toBe(evidenceBefore);
    });

    // ── The paired positive ─────────────────────────────────────────

    it('a principal holding ONLY the register key is admitted on both routes, and adds no denial row', async () => {
        getTenantCtxMock.mockResolvedValue(registryOnlyCtx(TENANT_A));
        const before = await countDenials(TENANT_A);
        const evidenceBefore = await countEvidence(TENANT_A);

        const read = await REPORTS_GET(reportsReq(TENANT_A), routeArgs(TENANT_A));
        expect(read.status).toBe(200);

        const filed = await EXPORT_POST(exportReq(TENANT_A), routeArgs(TENANT_A));
        expect(filed.status).toBe(201);

        // Without this arm every assertion in this file is satisfied by a gate
        // that refused EVERYONE; with it, the enforced key is pinned to the
        // declared one, since this principal holds no other agent key.
        expect(await countDenials(TENANT_A)).toBe(before);
        expect(await countEvidence(TENANT_A)).toBe(evidenceBefore + 1);
    });

    // ── The export's second gate, which is NOT audited ───────────────

    it('the export refuses a reader of the pack who may not write evidence — with ZERO denial rows', async () => {
        getTenantCtxMock.mockResolvedValue(noEvidenceEditCtx(TENANT_A));
        const before = await countDenials(TENANT_A);
        const evidenceBefore = await countEvidence(TENANT_A);

        const res = await EXPORT_POST(exportReq(TENANT_A), routeArgs(TENANT_A));
        expect(res.status).toBe(403);

        // The asymmetry, stated: this 403 comes from `assertCanEditEvidence`
        // inside the usecase, PAST the route gate, so it writes no AUTHZ_DENIED
        // row at all. Same status code, different evidence trail. Anyone reading
        // the trail for "who was refused this endpoint" sees only the first
        // class, and that is the current design rather than a logging bug.
        expect(await countDenials(TENANT_A)).toBe(before);
        expect(await countEvidence(TENANT_A)).toBe(evidenceBefore);
    });

    // ── Two tenants, at the route this time ─────────────────────────

    it("tenant B's agent never appears in tenant A's pack", async () => {
        getTenantCtxMock.mockResolvedValue(registryOnlyCtx(TENANT_A));

        const res = await REPORTS_GET(reportsReq(TENANT_A), routeArgs(TENANT_A));
        expect(res.status).toBe(200);
        const pack = JSON.stringify(await res.json());

        // A's OWN agent is present first. Without it, "B is absent" is equally
        // satisfied by an empty pack, a 200 over no rows, or a serialiser that
        // dropped the inventory — the three ways this assertion passes for the
        // wrong reason.
        expect(pack).toContain(AGENT_NAME[TENANT_A]);
        expect(pack).not.toContain(AGENT_NAME[TENANT_B]);
        expect(pack).not.toContain(TENANT_B);
    });
});
