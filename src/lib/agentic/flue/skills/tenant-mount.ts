/**
 * What a run mounts IN ITS OWN TENANT (#3680): the read half of tenant-authored
 * skills. `resolve.ts` decides; this module only fetches the tenant's approved
 * versions and hands them over.
 *
 * ── NEVER ANOTHER TENANT'S SKILL ────────────────────────────────────────────
 *
 * The read runs inside `runInTenantContext(ctx, …)`, so row-level security
 * returns this tenant's rows only, AND it filters on `ctx.tenantId`: the two
 * layers the platform's isolation rests on. There is no parameter through
 * which a caller can name a tenant; the context is the only input that says
 * whose skills these are.
 *
 * ── APPROVED ONLY, AND STILL GATED ──────────────────────────────────────────
 *
 * The read selects APPROVED versions naming the workflow — or, for an agent
 * profile's run (Step 2d), the APPROVED versions of the skills the profile
 * names, by name. That narrows; it does not vouch. Every version it returns still goes through
 * `checkTenantSkillMountable` — hash, scan, record — on every resolution.
 *
 * Every caller is on the ordinary-Node side: run admission
 * (`usecases/workflow-runs.ts`, which pins the result before the run row
 * exists), each segment of a reasoning engine (`flue/execute.ts` and
 * `tool-runner/execute.ts`, which mount the documents and compare the pins
 * with the row's), and an agent profile's picker, save and approval
 * (`usecases/agent-profiles.ts`), which read the versions the same way and ask
 * them what a run asks (`mountableTenantSkillLines`). Neither the agent module
 * nor the runtime's ESM graph reaches this file.
 */
import type { RequestContext } from '@/app-layer/types';
import type { PrismaTx } from '@/lib/db-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { recordTenantSkillMount } from '@/lib/observability/integration-metrics';

import { SkillLoadError, SkillTextRefusedError } from './index';
import { SkillNotMountableError } from './mount-gate';
import { mountableTenantSkillLines, resolveRunSkills, type DeclaresSkills, type RunSkillMount } from './resolve';
import type { TenantSkillVersionForMount } from './tenant-skill';

/** The columns the mount gate reads. Nothing else is selected. */
export const TENANT_SKILL_MOUNT_SELECT = {
    id: true,
    version: true,
    description: true,
    instructions: true,
    license: true,
    sourceRef: true,
    requiredInput: true,
    output: true,
    controls: true,
    tools: true,
    workflowKeys: true,
    contentHash: true,
    status: true,
    authorUserId: true,
    approvedByUserId: true,
    approvedContentHash: true,
    evaluationRecordJson: true,
    skill: { select: { name: true } },
} as const;

interface MountRow {
    id: string;
    version: number;
    description: string;
    instructions: string;
    license: string;
    sourceRef: string;
    requiredInput: string | null;
    output: string | null;
    controls: string | null;
    tools: string | null;
    workflowKeys: string[];
    contentHash: string;
    status: TenantSkillVersionForMount['status'];
    authorUserId: string;
    approvedByUserId: string | null;
    approvedContentHash: string | null;
    evaluationRecordJson: string | null;
    skill: { name: string };
}

/** A selected row as the gate's input. */
export function toMountInput(row: MountRow): TenantSkillVersionForMount {
    return {
        versionId: row.id,
        name: row.skill.name,
        version: row.version,
        description: row.description,
        instructions: row.instructions,
        license: row.license,
        sourceRef: row.sourceRef,
        requiredInput: row.requiredInput,
        output: row.output,
        controls: row.controls,
        tools: row.tools,
        workflowKeys: row.workflowKeys,
        contentHash: row.contentHash,
        status: row.status,
        authorUserId: row.authorUserId,
        approvedByUserId: row.approvedByUserId,
        approvedContentHash: row.approvedContentHash,
        evaluationRecordJson: row.evaluationRecordJson,
    };
}

/**
 * At most this many tenant skills mount on one workflow. The catalogue budget
 * binds long before this (a catalogue line is at least a name and a sentence),
 * so the bound only ever matters as the `take` on the read.
 */
const MAX_TENANT_SKILLS_PER_WORKFLOW = 64;

/** This tenant's APPROVED versions that name `workflowKey`. */
export async function readApprovedTenantSkills(
    ctx: RequestContext,
    workflowKey: string,
): Promise<TenantSkillVersionForMount[]> {
    const rows = await runInTenantContext(ctx, (db) =>
        db.tenantSkillVersion.findMany({
            where: { tenantId: ctx.tenantId, status: 'APPROVED', workflowKeys: { has: workflowKey } },
            select: TENANT_SKILL_MOUNT_SELECT,
            orderBy: { createdAt: 'asc' },
            take: MAX_TENANT_SKILLS_PER_WORKFLOW,
        }),
    );
    return rows.map(toMountInput);
}

/**
 * This tenant's APPROVED versions of the skills named here, keyed by the
 * skill's name rather than by a workflow (Step 2d): what an agent profile
 * names. One per name at most, because a skill holds one APPROVED version (a
 * partial unique index), so `take` is the number of names.
 *
 * Read through `db`, a transaction already bound to `tenantId`. Admission
 * reads by it (below), and so do a profile version's save and approval, so the
 * gate is asked of the same columns of the same rows.
 */
export async function readApprovedTenantSkillsByNameIn(
    db: PrismaTx,
    tenantId: string,
    names: readonly string[],
): Promise<TenantSkillVersionForMount[]> {
    if (names.length === 0) return [];
    const rows = await db.tenantSkillVersion.findMany({
        where: { tenantId, status: 'APPROVED', skill: { name: { in: [...names] } } },
        select: TENANT_SKILL_MOUNT_SELECT,
        orderBy: { createdAt: 'asc' },
        take: names.length,
    });
    return rows.map(toMountInput);
}

async function readApprovedTenantSkillsByName(
    ctx: RequestContext,
    names: readonly string[],
): Promise<TenantSkillVersionForMount[]> {
    if (names.length === 0) return [];
    return runInTenantContext(ctx, (db) => readApprovedTenantSkillsByNameIn(db, ctx.tenantId, names));
}

/**
 * Versions read per page by `readMountableTenantSkillLines`. A version's
 * evaluation record may be up to 4 MiB (`TENANT_SKILL_LIMITS.recordBytes`),
 * so the page, not the whole list, bounds what is held at once.
 */
export const MOUNTABLE_TENANT_SKILL_PAGE = 20;

/**
 * THE TENANT SKILLS AN AGENT PROFILE'S PICKER OFFERS (owner decision,
 * 2026-10-30): this tenant's APPROVED versions a run could mount, as catalogue
 * lines, from at most `limit` versions read. Each is read with the columns the
 * gate reads and asked what a run asks (`mountableTenantSkillLines`), so a
 * version admission would refuse is not offered.
 *
 * In pages of `MOUNTABLE_TENANT_SKILL_PAGE`, ordered by id, through `db`, a
 * transaction already bound to `tenantId`. Each page's rows are dropped once
 * its lines are taken, so at most one page of records is held at a time.
 */
export async function readMountableTenantSkillLines(
    db: PrismaTx,
    tenantId: string,
    limit: number,
): Promise<{ name: string; description: string }[]> {
    const lines: { name: string; description: string }[] = [];
    let cursor: string | undefined;
    for (let read = 0; read < limit; ) { // guardrail-allow: n+1 — one query per PAGE of versions, at most limit / page of them
        const take = Math.min(MOUNTABLE_TENANT_SKILL_PAGE, limit - read);
        const rows = await db.tenantSkillVersion.findMany({
            where: { tenantId, status: 'APPROVED' },
            select: TENANT_SKILL_MOUNT_SELECT,
            orderBy: { id: 'asc' },
            take,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        lines.push(...mountableTenantSkillLines(rows.map(toMountInput)));
        read += rows.length;
        if (rows.length < take) break;
        cursor = rows[rows.length - 1].id;
    }
    return lines;
}

/** The fields of an agent profile this module reads: which skills it names, and from where. */
interface NamesProfileSkills {
    readonly profile?: {
        readonly skillRefs: ReadonlyArray<{ readonly origin: 'repository' | 'tenant'; readonly name: string }>;
    };
}

/**
 * What a run mounts, read for its kind: an AGENT PROFILE's run mounts the
 * skills its pinned version names (Step 2d), every other run its workflow's
 * declared skills plus the tenant's approved skills on that workflow.
 *
 * A profile names a tenant skill by name, so its approved version is read by
 * name. A name with no approved version in this tenant REFUSES the run, as an
 * unknown repository name does: a profile run is never taught less than its
 * version names. The save-time check (`agent-profiles.ts`) refused the same
 * name when it was written; this one catches a skill retired since.
 */
async function readRunSkillInputs(
    ctx: RequestContext,
    def: DeclaresSkills & NamesProfileSkills,
): Promise<{ declared: readonly string[] | undefined; tenantVersions: TenantSkillVersionForMount[] }> {
    if (!def.profile) return { declared: def.skills, tenantVersions: await readApprovedTenantSkills(ctx, def.key) };
    const refs = def.profile.skillRefs;
    const tenantNames = refs.filter((r) => r.origin === 'tenant').map((r) => r.name);
    const tenantVersions = await readApprovedTenantSkillsByName(ctx, tenantNames);
    const found = new Set(tenantVersions.map((v) => v.name));
    const missing = tenantNames.find((name) => !found.has(name));
    if (missing !== undefined) {
        throw new SkillLoadError(missing, 'named by the agent profile, and this workspace holds no approved version of it');
    }
    return {
        declared: [...(def.skills ?? []), ...refs.filter((r) => r.origin === 'repository').map((r) => r.name)],
        tenantVersions,
    };
}

/** The metric's name for a refusal: the gate's reason, never the skill's text. */
function outcomeOf(err: unknown): string {
    if (err instanceof SkillNotMountableError) return err.reason;
    if (err instanceof SkillTextRefusedError) return 'TEXT_REFUSED';
    if (err instanceof SkillLoadError) return 'LOAD_REFUSED';
    return 'ERROR';
}

/**
 * What a run of `def` mounts in `ctx`'s tenant, and the pins its row records:
 * the definition's repository skills, then the tenant's approved skills on it —
 * or, for an agent profile's run, the skills its version names. Either way
 * through the ONE resolver, so the gate, the pins and the catalogue budget are
 * the same for every engine and every kind of run. Throws the resolver's
 * `SkillLoadError` family on any refusal.
 */
export async function resolveRunSkillMount(
    ctx: RequestContext,
    def: DeclaresSkills & NamesProfileSkills,
    context: 'admission' | 'segment' = 'segment',
): Promise<RunSkillMount> {
    const { declared, tenantVersions } = await readRunSkillInputs(ctx, def);
    try {
        const mount = resolveRunSkills(declared, tenantVersions);
        if (tenantVersions.length > 0) recordTenantSkillMount({ outcome: 'MOUNTED', context });
        return mount;
    } catch (err) {
        if (tenantVersions.length > 0) recordTenantSkillMount({ outcome: outcomeOf(err), context });
        throw err;
    }
}
