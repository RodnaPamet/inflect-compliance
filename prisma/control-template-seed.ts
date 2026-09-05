/**
 * The ONE seeder for authored control-template content.
 *
 * ═══ WHY THIS MODULE EXISTS ═══
 *
 * Two callers need this fixture's tasks — `prisma/seed.ts` (dev + CI) and
 * `scripts/seed-control-template-tasks.ts` (every other environment, including
 * production). Letting each read and shape the JSON itself is exactly how the
 * five generic task strings ended up as four byte-identical copies, two of them
 * npm-reachable. One owner, from the start this time.
 *
 * ═══ WHY IT VALIDATES RATHER THAN CASTS ═══
 *
 * The reason this file was written at all is that `seed.ts` read the fixture
 * through a hand-written `as` cast whose type had no `tasks` field. The cast
 * compiled, the seed ran, and 865 authored tasks reached no database — with a
 * conformance gate, an actionability ratchet and 24 green CI checks all
 * certifying the file's shape, because every one of them read the same JSON
 * the seeder was silently discarding.
 *
 * So this parses through `CatalogTaskSchema` — the same schema the catalog
 * importer uses — and THROWS on malformed content. A cast lies quietly; a
 * parse fails loudly. That difference is the whole point of the module.
 */
import type { PrismaClient } from '@prisma/client';
import { CatalogTaskSchema } from './catalog-loader';
import { reconcileTemplateTasks, type AuthoredTask, type TaskReconcileResult } from './catalog-applier';

/**
 * Three fixture shapes ship, and all three must be readable here.
 *
 * `internal-controls.json` nests under `controls`; every framework fixture
 * (DORA, NIS2, SOC 2, …) nests under `templates`; a couple are a bare array.
 * The first draft read only `controls`, which silently skipped every framework
 * — the same denominator mistake that hid 151 templates from the actionability
 * scan, one layer down.
 */
type FixtureEntry = { code?: unknown; tasks?: unknown };

export interface AuthoredControlTasks {
    /** Template code (`ICN-001`) -> its authored tasks, in authored order. */
    byCode: Map<string, AuthoredTask[]>;
    /** Controls carrying at least one authored task. */
    controlCount: number;
    /** Total authored tasks across every control. */
    taskCount: number;
}

/**
 * Parse the fixture's authored tasks.
 *
 * @throws if any task fails `CatalogTaskSchema`. Deliberate: a fixture that
 *         cannot be parsed must stop the seed rather than seed a subset,
 *         because a partial seed is indistinguishable from a complete one
 *         once the process exits 0.
 */
/** Every template/control entry in a fixture, whatever shape it ships in. */
export function fixtureEntries(fixture: unknown): FixtureEntry[] {
    if (Array.isArray(fixture)) return fixture as FixtureEntry[];
    const obj = (fixture ?? {}) as { controls?: unknown[]; templates?: unknown[] };
    return ((obj.controls ?? obj.templates ?? []) as FixtureEntry[]).filter(
        (e) => e && typeof e === 'object',
    );
}

export function loadAuthoredControlTasks(fixture: unknown): AuthoredControlTasks {
    const controls = fixtureEntries(fixture);
    const byCode = new Map<string, AuthoredTask[]>();
    let taskCount = 0;

    for (const control of controls) {
        const code = typeof control?.code === 'string' ? control.code : null;
        if (!code || !Array.isArray(control.tasks) || control.tasks.length === 0) continue;

        const parsed = control.tasks.map((task, i) => {
            const result = CatalogTaskSchema.safeParse(task);
            if (!result.success) {
                throw new Error(
                    `internal-controls.json: ${code} task[${i}] is invalid — ${result.error.issues
                        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
                        .join('; ')}`,
                );
            }
            return result.data as AuthoredTask;
        });

        byCode.set(code, parsed);
        taskCount += parsed.length;
    }

    return { byCode, controlCount: byCode.size, taskCount };
}

export interface SeedInternalControlsResult extends TaskReconcileResult {
    /** ControlTemplate rows created / updated by this run. */
    templates: { created: number; updated: number };
    /** Policy-mediated ControlTemplateRequirementLink rows upserted. */
    requirementLinks: number;
    /** Authored tasks the fixture carries, whether or not they landed. */
    fixtureTaskCount: number;
}

interface ControlRow {
    code: string;
    title: string;
    objective?: string | null;
    successCriteria?: string | null;
    testingMethodology?: string | null;
    relatedPolicies?: string[];
    category?: string | null;
}

/** `internal-controls-policy-framework-map.json` — policy name -> framework codes. */
export type PolicyFrameworkMap = Record<string, { iso27001?: string[]; nis2?: string[] }>;

/**
 * Seed the internal-controls library: templates, policy-mediated requirement
 * links, and authored tasks.
 *
 * THREE callers share this — `prisma/seed.ts` (dev + CI),
 * `scripts/seed-control-template-tasks.ts` (prod), and
 * `tests/integration/control-template-task-delivery.test.ts`.
 *
 * ═══ WHY IT SEEDS TEMPLATES AND LINKS, NOT JUST TASKS ═══
 *
 * Production carries ZERO `ICN-` ControlTemplate rows: its catalogue was built
 * by `framework-import` from `src/data/libraries/*.yaml`, and `prisma/seed.ts`
 * — the only thing that ever wrote these fixtures — is not run on prod deploys.
 * A tasks-only seeder would therefore report 151 missing templates and deliver
 * nothing, which is the same silence this whole module exists to end.
 *
 * The requirement links are load-bearing rather than decorative: an internal
 * control reaches a tenant ONLY because a framework-pack install pulls in
 * templates whose `requirementLinks` point at that framework's requirements.
 * Seed the template without its links and it is present but unreachable.
 *
 * The test calling this same function is deliberate. A delivery test that
 * re-implements the delivery it checks proves only that two pieces of code
 * agree — exactly the failure being fixed here: every gate on this content
 * agreed with every other gate, and all of them read the fixture rather than
 * the database.
 */
export async function seedInternalControls(
    prisma: PrismaClient,
    fixture: unknown,
    policyMap: PolicyFrameworkMap = {},
): Promise<SeedInternalControlsResult> {
    const authored = loadAuthoredControlTasks(fixture);
    const controls = ((fixture as { controls?: ControlRow[] })?.controls ?? []).filter(
        (c) => typeof c?.code === 'string' && typeof c?.title === 'string',
    );

    const out: SeedInternalControlsResult = {
        created: 0,
        updated: 0,
        deprecated: 0,
        unchanged: 0,
        templates: { created: 0, updated: 0 },
        requirementLinks: 0,
        fixtureTaskCount: authored.taskCount,
    };

    // Requirement code -> id, per framework. An absent framework yields an
    // empty map, so a database without ISO 27001 or NIS2 still seeds templates
    // and tasks and simply creates no links — degraded, never crashed.
    const reqMap = async (key: string): Promise<Record<string, string>> => {
        const framework = await prisma.framework.findFirst({ where: { key }, select: { id: true } });
        if (!framework) return {};
        const rows = await prisma.frameworkRequirement.findMany({
            where: { frameworkId: framework.id },
            select: { id: true, code: true },
        });
        return Object.fromEntries(rows.map((r) => [r.code, r.id]));
    };
    const isoReq = await reqMap('ISO27001');
    const nis2Req = await reqMap('NIS2');

    for (const c of controls) {
        const data = {
            title: c.title,
            description: c.objective || null,
            category: c.category || null,
            objective: c.objective || null,
            successCriteria: c.successCriteria || null,
            testingMethodology: c.testingMethodology || null,
            relatedPolicies: (c.relatedPolicies ?? []).join('|') || null,
        };
        const before = await prisma.controlTemplate.findUnique({
            where: { code: c.code },
            select: { id: true },
        });
        const template = await prisma.controlTemplate.upsert({
            where: { code: c.code },
            update: data,
            create: { code: c.code, ...data },
        });
        if (before) out.templates.updated++;
        else out.templates.created++;

        const requirementIds = new Set<string>();
        for (const policy of c.relatedPolicies ?? []) {
            const mapped = policyMap[policy];
            if (!mapped) continue;
            for (const code of mapped.iso27001 ?? []) if (isoReq[code]) requirementIds.add(isoReq[code]);
            for (const code of mapped.nis2 ?? []) if (nis2Req[code]) requirementIds.add(nis2Req[code]);
        }
        for (const requirementId of requirementIds) {
            await prisma.controlTemplateRequirementLink.upsert({
                where: { templateId_requirementId: { templateId: template.id, requirementId } },
                create: { templateId: template.id, requirementId },
                update: {},
            });
            out.requirementLinks++;
        }

        const tasks = authored.byCode.get(c.code);
        if (!tasks) continue;
        const r = await reconcileTemplateTasks(prisma, template.id, tasks);
        out.created += r.created;
        out.updated += r.updated;
        out.deprecated += r.deprecated;
        out.unchanged += r.unchanged;
    }

    return out;
}

export interface SeedAuthoredTasksResult extends TaskReconcileResult {
    /** Codes carrying authored tasks with no ControlTemplate in this database. */
    missingTemplates: string[];
    /** Authored tasks the fixture carries, whether or not they landed. */
    fixtureTaskCount: number;
}

/**
 * Deliver authored tasks onto templates that ALREADY EXIST, by code.
 *
 * This is the DORA / NIS2 case, and it differs from the internal-controls one
 * in a way that matters: production already carries those templates — they came
 * from `seed-catalog.ts` / `framework-import` — so there is nothing to create
 * and no requirement links to mediate. Only the tasks are missing.
 *
 * A code with no template is REPORTED rather than created. Creating one here
 * would invent a control template from a task list, and an unrecognised code is
 * far more likely to be a typo than a new control.
 */
export async function seedAuthoredTemplateTasks(
    prisma: PrismaClient,
    fixture: unknown,
): Promise<SeedAuthoredTasksResult> {
    const authored = loadAuthoredControlTasks(fixture);
    const out: SeedAuthoredTasksResult = {
        created: 0,
        updated: 0,
        deprecated: 0,
        unchanged: 0,
        missingTemplates: [],
        fixtureTaskCount: authored.taskCount,
    };

    for (const [code, tasks] of authored.byCode) {
        const template = await prisma.controlTemplate.findUnique({
            where: { code },
            select: { id: true },
        });
        if (!template) {
            out.missingTemplates.push(code);
            continue;
        }
        const r = await reconcileTemplateTasks(prisma, template.id, tasks);
        out.created += r.created;
        out.updated += r.updated;
        out.deprecated += r.deprecated;
        out.unchanged += r.unchanged;
    }

    return out;
}
