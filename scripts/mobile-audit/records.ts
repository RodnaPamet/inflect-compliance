/**
 * `--create-records`: the records the E2E seed lacks, created through the
 * product's own API so detail pages have something to show.
 *
 * It WRITES to the app's database (as the seeded owner, through the same
 * routes a person would use), so it is opt-in and meant for a throwaway
 * audit database, never a shared one. Each kind is created only when the
 * database has none, so a second run adds nothing. A kind that cannot be
 * created is logged and left to `resolve.ts`, which then reports its pages as
 * uncaptured with the reason.
 *
 * Not created: a registered agent, a workflow run, an A2A peer, an
 * integration connection, a trust center, a vendor assessment and NIS2
 * assignments — each needs a chain of configuration (or an external system)
 * that a plain create call cannot stand in for.
 */
import type { APIRequestContext } from '@playwright/test';
import type { ResolveContext } from './resolve';

interface Creator {
    what: string;
    exists: (c: ResolveContext) => Promise<boolean>;
    create: (api: (path: string, data: unknown) => Promise<{ id: string }>, c: ResolveContext) => Promise<void>;
}

const CREATORS: readonly Creator[] = [
    {
        what: 'vendor',
        exists: async ({ db, tenantId }) => !!(await db.vendor.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } })),
        create: async (api, { tenantSlug }) => {
            await api(`/api/t/${tenantSlug}/vendors`, { name: 'Northwind Cloud Hosting', criticality: 'HIGH', description: 'Primary infrastructure provider.' });
        },
    },
    {
        what: 'incident',
        exists: async ({ db, tenantId }) => !!(await db.incident.findFirst({ where: { tenantId }, select: { id: true } })),
        create: async (api, { tenantSlug }) => {
            await api(`/api/t/${tenantSlug}/incidents`, { title: 'Phishing campaign against the finance team', severity: 'HIGH', incidentType: 'UNAUTHORIZED_ACCESS', description: 'Three users reported a credential-harvesting email.' });
        },
    },
    {
        what: 'business impact analysis',
        exists: async ({ db, tenantId }) => !!(await db.businessImpactAnalysis.findFirst({ where: { tenantId }, select: { id: true } })),
        create: async (api, { tenantSlug }) => {
            await api(`/api/t/${tenantSlug}/business-continuity`, { name: 'Customer payments processing', criticality: 'HIGH', rtoHours: 4, rpoHours: 1, mtpdHours: 24 });
        },
    },
    {
        what: 'AI system',
        exists: async ({ db, tenantId }) => !!(await db.aiSystem.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } })),
        create: async (api, { tenantSlug }) => {
            await api(`/api/t/${tenantSlug}/ai-systems`, { name: 'Support ticket triage assistant', purpose: 'Routes inbound support tickets.', provider: 'Internal' });
        },
    },
    {
        what: 'evidence',
        exists: async ({ db, tenantId }) => !!(await db.evidence.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } })),
        create: async (api, { tenantSlug }) => {
            await api(`/api/t/${tenantSlug}/evidence`, { type: 'TEXT', title: 'Quarterly access review sign-off', content: 'Signed off by the CISO.' });
        },
    },
    {
        what: 'control test plan and run',
        exists: async ({ db, tenantId }) => !!(await db.controlTestRun.findFirst({ where: { tenantId }, select: { id: true } })),
        create: async (api, { db, tenantId, tenantSlug }) => {
            const control = await db.control.findFirst({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } });
            if (!control) throw new Error('no control to attach a test plan to');
            const plan = await api(`/api/t/${tenantSlug}/controls/${control.id}/tests/plans`, {
                name: 'Quarterly review of privileged access to production',
                frequency: 'QUARTERLY',
                steps: [{ instruction: 'Export the list of privileged accounts', expectedOutput: 'A CSV of accounts' }],
            });
            await api(`/api/t/${tenantSlug}/tests/plans/${plan.id}/runs`, {});
        },
    },
    {
        what: 'access review',
        exists: async ({ db, tenantId }) => !!(await db.accessReview.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } })),
        create: async (api, { db, tenantId, tenantSlug }) => {
            const owner = await db.tenantMembership.findFirst({ where: { tenantId, role: 'OWNER' }, select: { userId: true } });
            if (!owner) throw new Error('no tenant owner to review');
            await api(`/api/t/${tenantSlug}/access-reviews`, { name: 'Q4 user access review', reviewerUserId: owner.userId });
        },
    },
];

const ORG_CREATORS: readonly Creator[] = [
    {
        what: 'org security initiative',
        exists: async ({ db, orgId }) => !orgId || !!(await db.orgSecurityInitiative.findFirst({ where: { organizationId: orgId }, select: { id: true } })),
        create: async (api, { orgSlug }) => {
            await api(`/api/org/${orgSlug}/initiatives`, { title: 'Roll out phishing-resistant MFA' });
        },
    },
];

function apiFor(request: APIRequestContext) {
    return async (path: string, data: unknown): Promise<{ id: string }> => {
        const res = await request.post(path, { data, headers: { 'Content-Type': 'application/json' } });
        if (!res.ok()) throw new Error(`POST ${path} → ${res.status()} ${(await res.text()).slice(0, 200)}`);
        return (await res.json()) as { id: string };
    };
}

async function run(creators: readonly Creator[], request: APIRequestContext, c: ResolveContext): Promise<string[]> {
    const done: string[] = [];
    for (const k of creators) {
        try {
            if (await k.exists(c)) continue;
            await k.create(apiFor(request), c);
            done.push(k.what);
        } catch (e) {
            console.warn(`[mobile-audit] could not create a ${k.what}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return done;
}

/** Create what is missing; returns the kinds created. */
export async function createAuditRecords(
    tenantRequest: APIRequestContext,
    orgRequest: APIRequestContext,
    c: ResolveContext,
): Promise<string[]> {
    return [...(await run(CREATORS, tenantRequest, c)), ...(await run(ORG_CREATORS, orgRequest, c))];
}
