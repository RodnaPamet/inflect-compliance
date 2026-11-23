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
import { optionLabels } from './leaks';

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
 * Names of records that appear on pages as data, not UI text: every tenant's
 * and organisation's name, and every control's. The leak detector skips them
 * ("Acme Corp" is the seeded tenant AND an English placeholder in the catalog).
 *
 * Controls are here because a phone renders each list card's title as the
 * card's own label, which the detector reads as chrome. A tenant's controls
 * are its own record, often copied from an English library ("Return of
 * assets", "Segregation of duties"), and which of them a tenant holds depends
 * on what else ran against the database first, so without them the count
 * moved between a fresh seed and the E2E run.
 *
 * A risk's legacy `treatmentOwner` is free text a person typed (the seed's
 * "Infrastructure"), and the risks list shows it in the Owner column when no
 * owner account is linked. It is the tenant's words, not the product's; that
 * it happens to equal a catalog value ("Infrastructure", an asset type) made
 * the detector call it a leak (#5828).
 */
export async function dataNames(db: PrismaClient): Promise<Set<string>> {
    const [tenants, orgs, controls, riskOwners] = await Promise.all([
        db.tenant.findMany({ select: { name: true }, take: 1000 }),
        db.organization.findMany({ select: { name: true }, take: 1000 }),
        db.control.findMany({ select: { name: true }, distinct: ['name'], take: 5000 }),
        db.risk.findMany({
            where: { treatmentOwner: { not: null } },
            select: { treatmentOwner: true },
            distinct: ['treatmentOwner'],
            take: 1000,
        }),
    ]);
    return new Set(
        [
            ...[...tenants, ...orgs, ...controls].map((r) => r.name),
            ...riskOwners.map((r) => r.treatmentOwner ?? ''),
        ]
            .map((n) => n.trim())
            .filter(Boolean),
    );
}

/**
 * Every value of the English LIBRARY the product ships, which the leak
 * detector treats as content rather than interface text (owner decision,
 * 2026-11-23; see `leaks.ts`): framework names and descriptions, requirement
 * titles, categories, sections and themes, ISO clause names, control and
 * policy templates, and the seeded vendor questionnaires — the global
 * `QuestionnaireTemplate` and every `VendorAssessmentTemplate` seeded as a
 * global (`isGlobal`), with their sections, prompts and option labels.
 *
 * Only the library tables are read. A record a tenant created or edited is
 * not library content: tenant data is `dataNames`' business, and a tenant's
 * own questionnaire (not `isGlobal`) is judged like any other text.
 */
export async function libraryTexts(db: PrismaClient): Promise<Set<string>> {
    const [frameworks, requirements, clauses, controlTemplates, templateTasks, policyTemplates, questionnaires, questions, vendorTemplates, vendorSections, vendorQuestions] =
        await Promise.all([
            db.framework.findMany({ select: { name: true, description: true }, take: 1000 }),
            db.frameworkRequirement.findMany({ select: { title: true, description: true, category: true, section: true, theme: true }, take: 50_000 }),
            db.clause.findMany({ select: { title: true, description: true }, take: 1000 }),
            db.controlTemplate.findMany({ select: { title: true, description: true, category: true, defaultOwnerHint: true }, take: 10_000 }),
            db.controlTemplateTask.findMany({ select: { title: true }, distinct: ['title'], take: 10_000 }),
            db.policyTemplate.findMany({ select: { title: true, category: true }, take: 5000 }),
            db.questionnaireTemplate.findMany({ select: { name: true, description: true }, take: 1000 }),
            db.questionnaireQuestion.findMany({ select: { section: true, prompt: true, optionsJson: true }, take: 10_000 }),
            db.vendorAssessmentTemplate.findMany({ where: { isGlobal: true }, select: { name: true, description: true }, take: 1000 }),
            db.vendorAssessmentTemplateSection.findMany({ where: { template: { isGlobal: true } }, select: { title: true, description: true }, take: 10_000 }),
            db.vendorAssessmentTemplateQuestion.findMany({
                where: { template: { isGlobal: true } },
                select: { prompt: true, optionsJson: true, scaleConfigJson: true },
                take: 20_000,
            }),
        ]);
    const values: Array<string | null | undefined> = [
        ...frameworks.flatMap((r) => [r.name, r.description]),
        ...requirements.flatMap((r) => [r.title, r.description, r.category, r.section, r.theme]),
        ...clauses.flatMap((r) => [r.title, r.description]),
        ...controlTemplates.flatMap((r) => [r.title, r.description, r.category, r.defaultOwnerHint]),
        ...templateTasks.map((r) => r.title),
        ...policyTemplates.flatMap((r) => [r.title, r.category]),
        ...questionnaires.flatMap((r) => [r.name, r.description]),
        ...questions.flatMap((r) => [r.section, r.prompt, ...optionLabels(r.optionsJson)]),
        ...vendorTemplates.flatMap((r) => [r.name, r.description]),
        ...vendorSections.flatMap((r) => [r.title, r.description]),
        ...vendorQuestions.flatMap((r) => [r.prompt, ...optionLabels(r.optionsJson), ...optionLabels(r.scaleConfigJson)]),
    ];
    return new Set(values.map((v) => (v ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean));
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
