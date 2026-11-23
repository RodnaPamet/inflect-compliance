/**
 * Fill each route's dynamic segments with a real record from the database.
 *
 * The audit and the mobile E2E project both read the seeded database directly
 * (Playwright specs already do, for example `control-evidence.spec.ts`): a
 * list page may open its rows with `router.push` rather than a link, so
 * scraping list pages for ids would miss half the detail pages.
 *
 * One resolver per dynamic route, keyed on the route PATTERN, because one
 * parameter name means different records on different routes (`runId` is a
 * workflow run under `agents/` and a test run under `tests/`). A route with no
 * resolver, or whose resolver finds no record, is reported as UNCAPTURED with
 * the reason — it is never silently dropped from the report.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { AppRoute } from './routes';
import { fillPattern } from './routes';

export const SEED_TENANT_SLUG = 'acme-corp';
export const SEED_ORG_SLUG = 'acme-org';

export interface ResolveContext {
    db: PrismaClient;
    tenantId: string;
    tenantSlug: string;
    orgId: string | null;
    orgSlug: string;
}

/** The values for a route's non-slug segments, or the reason there are none. */
type ResolverResult = Record<string, string> | { uncaptured: string };
type Resolver = (c: ResolveContext) => Promise<ResolverResult>;

const T = '/t/[tenantSlug]';

const one = (param: string, what: string, id: string | null | undefined): ResolverResult =>
    id ? { [param]: id } : { uncaptured: `the database holds no ${what}` };

/**
 * Every dynamic route other than the bare tenant/org slug. A route missing
 * from this table is reported as "no resolver"; add one here when you add a
 * dynamic page.
 */
export const RESOLVERS: Readonly<Record<string, Resolver>> = {
    [`${T}/access-reviews/[reviewId]`]: async ({ db, tenantId }) =>
        one('reviewId', 'access review', (await db.accessReview.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } }))?.id),
    [`${T}/admin/agents/[agentId]`]: async ({ db, tenantId }) =>
        one('agentId', 'registered agent', (await db.registeredAgent.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } }))?.id),
    [`${T}/agents/[agentId]`]: async ({ db, tenantId }) =>
        one('agentId', 'registered agent', (await db.registeredAgent.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } }))?.id),
    [`${T}/processes/agents/[agentId]`]: async ({ db, tenantId }) =>
        one('agentId', 'registered agent', (await db.registeredAgent.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } }))?.id),
    [`${T}/processes/agents/[agentId]/flow`]: async ({ db, tenantId }) =>
        one('agentId', 'registered agent', (await db.registeredAgent.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } }))?.id),
    [`${T}/admin/external-write-policy/[connectionId]`]: async ({ db, tenantId }) =>
        one('connectionId', 'integration connection', (await db.integrationConnection.findFirst({ where: { tenantId }, select: { id: true } }))?.id),
    [`${T}/admin/integrations/[connectionId]`]: async ({ db, tenantId }) =>
        one('connectionId', 'integration connection', (await db.integrationConnection.findFirst({ where: { tenantId }, select: { id: true } }))?.id),
    [`${T}/admin/integrations/[connectionId]/reconciliation`]: async ({ db, tenantId }) =>
        one('connectionId', 'integration connection', (await db.integrationConnection.findFirst({ where: { tenantId }, select: { id: true } }))?.id),
    [`${T}/admin/vendor-assessment-reviews/[assessmentId]`]: async ({ db, tenantId }) =>
        one('assessmentId', 'vendor assessment', (await db.vendorAssessment.findFirst({ where: { tenantId }, select: { id: true } }))?.id),
    [`${T}/admin/vendor-templates/[templateId]`]: async ({ db, tenantId }) =>
        one('templateId', 'vendor assessment template', (await db.vendorAssessmentTemplate.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' }, select: { id: true } }))?.id),
    [`${T}/agents/peers/[peerId]`]: async ({ db, tenantId }) =>
        one('peerId', 'A2A peer', (await db.peerAgent.findFirst({ where: { tenantId }, select: { id: true } }))?.id),
    [`${T}/agents/runs/[runId]`]: async ({ db, tenantId }) =>
        one('runId', 'workflow run', (await db.workflowRun.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' }, select: { id: true } }))?.id),
    [`${T}/assets/[id]`]: async ({ db, tenantId }) =>
        one('id', 'asset', (await db.asset.findFirst({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } }))?.id),
    [`${T}/audits/business-continuity/[id]`]: async ({ db, tenantId }) =>
        one('id', 'business impact analysis', (await db.businessImpactAnalysis.findFirst({ where: { tenantId }, select: { id: true } }))?.id),
    [`${T}/audits/cycles/[cycleId]`]: async ({ db, tenantId }) =>
        one('cycleId', 'audit cycle', (await db.auditCycle.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } }))?.id),
    [`${T}/audits/cycles/[cycleId]/readiness`]: async ({ db, tenantId }) =>
        one('cycleId', 'audit cycle', (await db.auditCycle.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } }))?.id),
    [`${T}/audits/nis2-gap/respond/[assignmentId]`]: async ({ db, tenantId }) =>
        one('assignmentId', 'NIS2 gap assignment', (await db.nis2GapAssignment.findFirst({ where: { tenantId }, select: { id: true } }))?.id),
    [`${T}/audits/packs/[packId]`]: async ({ db, tenantId }) =>
        one('packId', 'audit pack', (await db.auditPack.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } }))?.id),
    [`${T}/controls/[controlId]`]: async ({ db, tenantId }) =>
        one('controlId', 'control', (await db.control.findFirst({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } }))?.id),
    [`${T}/controls/[controlId]/tests/[planId]`]: async ({ db, tenantId }): Promise<ResolverResult> => {
        const plan = await db.controlTestPlan.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true, controlId: true } });
        return plan ? { controlId: plan.controlId, planId: plan.id } : { uncaptured: 'the database holds no control test plan' };
    },
    [`${T}/tests/plans/[planId]`]: async ({ db, tenantId }) =>
        one('planId', 'control test plan', (await db.controlTestPlan.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } }))?.id),
    [`${T}/tests/runs/[runId]`]: async ({ db, tenantId }) =>
        one('runId', 'control test run', (await db.controlTestRun.findFirst({ where: { tenantId }, select: { id: true } }))?.id),
    [`${T}/frameworks/[frameworkKey]`]: async () => ({ frameworkKey: 'ISO27001' }),
    [`${T}/frameworks/[frameworkKey]/diff`]: async () => ({ frameworkKey: 'ISO27001' }),
    [`${T}/frameworks/[frameworkKey]/install`]: async () => ({ frameworkKey: 'ISO27001' }),
    [`${T}/frameworks/[frameworkKey]/readiness`]: async () => ({ frameworkKey: 'ISO27001' }),
    [`${T}/frameworks/[frameworkKey]/self-assessment`]: async () => ({ frameworkKey: 'NIS2' }),
    [`${T}/frameworks/[frameworkKey]/templates`]: async () => ({ frameworkKey: 'ISO27001' }),
    [`${T}/incidents/[incidentId]`]: async ({ db, tenantId }) =>
        one('incidentId', 'incident', (await db.incident.findFirst({ where: { tenantId }, select: { id: true } }))?.id),
    [`${T}/issues/[issueId]`]: async ({ db, tenantId }) =>
        one('issueId', 'task', (await db.task.findFirst({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } }))?.id),
    [`${T}/tasks/[taskId]`]: async ({ db, tenantId }) =>
        one('taskId', 'task', (await db.task.findFirst({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } }))?.id),
    [`${T}/policies/[policyId]`]: async ({ db, tenantId }) =>
        one('policyId', 'policy', (await db.policy.findFirst({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } }))?.id),
    [`${T}/risks/[riskId]`]: async ({ db, tenantId }) =>
        one('riskId', 'risk', (await db.risk.findFirst({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } }))?.id),
    [`${T}/risks/ai-systems/[systemId]`]: async ({ db, tenantId }) =>
        one('systemId', 'AI system', (await db.aiSystem.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } }))?.id),
    [`${T}/vendors/[vendorId]`]: async ({ db, tenantId }) =>
        one('vendorId', 'vendor', (await db.vendor.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } }))?.id),
    ['/org/[orgSlug]/initiatives/[initiativeId]']: async ({ db, orgId }) =>
        one('initiativeId', 'org security initiative', orgId ? (await db.orgSecurityInitiative.findFirst({ where: { organizationId: orgId }, select: { id: true } }))?.id : null),
    ['/trust/[slug]']: async ({ db, tenantId }) =>
        one('slug', 'trust center', (await db.trustCenter.findFirst({ where: { tenantId }, select: { slug: true } }))?.slug),
    ['/vendor-assessment/[assessmentId]']: async ({ db, tenantId }) =>
        one('assessmentId', 'vendor assessment', (await db.vendorAssessment.findFirst({ where: { tenantId }, select: { id: true } }))?.id),
    ['/audit/shared/[token]']: async () => ({ uncaptured: 'share tokens are stored hashed; only the creator ever holds one' }),
    ['/invite/[token]']: async () => ({ uncaptured: 'invite tokens are stored hashed; only the creator ever holds one' }),
    ['/invite/org/[token]']: async () => ({ uncaptured: 'invite tokens are stored hashed; only the creator ever holds one' }),
};

export function connectDb(databaseUrl: string): PrismaClient {
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export async function resolveContext(
    db: PrismaClient,
    tenantSlug = SEED_TENANT_SLUG,
    orgSlug = SEED_ORG_SLUG,
): Promise<ResolveContext> {
    const tenant = await db.tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true } });
    if (!tenant) throw new Error(`no tenant with slug ${tenantSlug} — is the database seeded?`);
    const org = await db.organization.findUnique({ where: { slug: orgSlug }, select: { id: true } });
    return { db, tenantId: tenant.id, tenantSlug, orgId: org?.id ?? null, orgSlug };
}

/**
 * Names of records that appear on many pages as data, not UI text: every
 * tenant's and organisation's name. The leak detector skips them ("Acme Corp"
 * is the seeded tenant AND an English placeholder in the catalog).
 */
export async function dataNames(db: PrismaClient): Promise<Set<string>> {
    const [tenants, orgs] = await Promise.all([
        db.tenant.findMany({ select: { name: true }, take: 1000 }),
        db.organization.findMany({ select: { name: true }, take: 1000 }),
    ]);
    return new Set([...tenants, ...orgs].map((r) => r.name.trim()).filter(Boolean));
}

export type ResolvedRoute =
    | { route: AppRoute; url: string }
    | { route: AppRoute; uncaptured: string };

/** The concrete URL for `route`, or why there is none. */
export async function resolveRoute(route: AppRoute, c: ResolveContext): Promise<ResolvedRoute> {
    const base: Record<string, string> = { tenantSlug: c.tenantSlug, orgSlug: c.orgSlug };
    const rest = route.params.filter((p) => !(p in base));
    let values: Record<string, string> = base;
    if (rest.length) {
        const resolver = RESOLVERS[route.pattern];
        if (!resolver) return { route, uncaptured: `no resolver for [${rest.join('], [')}] in scripts/mobile-audit/resolve.ts` };
        const r = await resolver(c);
        if ('uncaptured' in r) return { route, uncaptured: r.uncaptured };
        values = { ...base, ...r };
    }
    const url = fillPattern(route.pattern, values);
    return url ? { route, url } : { route, uncaptured: 'a segment could not be filled' };
}
