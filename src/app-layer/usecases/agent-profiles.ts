/**
 * AGENT PROFILES UNDER THE REVIEW LIFECYCLE (Step 1a of
 * `docs/claude-agent-sdk-design.md`, #4143).
 *
 * The ONLY writer of `AgentProfile` and `AgentProfileVersion`
 * (`tests/guards/agent-harness-single-write-seam.test.ts`).
 *
 * A profile is what a registered agent should DO, as its tenant wrote it, and
 * never what it may REACH. It follows the tenant-skill lifecycle (#3680):
 *
 *   create        version 1 at DRAFT, authored by the caller
 *   edit          version N+1 at DRAFT; an open (DRAFT or SUBMITTED) version is
 *                 retired first, so a reviewer never approves replaced text
 *   submit        DRAFT → SUBMITTED
 *   approve       SUBMITTED → APPROVED, by a person other than the author,
 *                 naming the instructions hash they read; the version in force
 *                 is retired and the profile's pointer moves, in one transaction
 *   reject        SUBMITTED → REJECTED, by a person other than the author
 *   retire        any status but RETIRED → RETIRED; retiring the version in
 *                 force clears the pointer, so the profile stops running
 *
 * ── WHO MAY ACT ─────────────────────────────────────────────────────────────
 *
 * `admin.agent_registry` for every act (owner decision 3, 2026-10-25), re-read
 * here beneath the route's literal `requirePermission`. The four-eyes rule is a
 * PERSON, whoever holds the key: approving and rejecting refuse the version's
 * author (`SELF_DECISION`) and refuse an API-key caller
 * (`DECIDER_NOT_A_PERSON`), and the database refuses a decision whose decider
 * is the author.
 *
 * ── WHAT IS CHECKED AT SAVE ─────────────────────────────────────────────────
 *
 * The instructions are sanitised (`sanitizePlainText`), held to a size cap and
 * scanned by the skill text scan, and text the scan refuses is refused by rule
 * id and never stored (owner decision 2). Every tool must be one the agent is
 * granted now: an ungranted tool is refused BY NAME, never dropped. Every
 * skill must be one the agent may mount — a shipped skill the text scan
 * refused is neither offered nor accepted — and together they must fit the
 * per-run catalogue budget a run of the version is refused by
 * (`SKILL_CATALOGUE_OVER_BUDGET`, #4523). Approval asks all of it again,
 * because a grant can be revoked, and a tenant skill retired or given a longer
 * description, while a version waits.
 *
 * ── THE FLAG ────────────────────────────────────────────────────────────────
 *
 * With `AGENT_PROFILES` off every act answers 404 (`PROFILES_DISABLED`), before
 * any read, so the surface is absent rather than refused.
 *
 * Audit rows carry hashes, version numbers, tool names and rule ids, never the
 * instructions.
 */
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';

import type { RequestContext } from '../types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { AppError, ConflictError, ValidationError } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { scanSkillText } from '@/lib/agentic/flue/skills/text-scan';
import { runCatalogue, selectableRepositorySkillNames, type CatalogueLine } from '@/lib/agentic/flue/skills/resolve';
import { approvedTenantSkillsByNameWhere } from '@/lib/agentic/flue/skills/tenant-mount';
import { MAX_CATALOG_BYTES } from '@/lib/agentic/flue/skills';
import { agentProfilesOnFor } from '@/lib/agentic/agent-switches-policy';
import {
    PROFILE_INSTRUCTIONS_MAX_CHARS,
    PROFILE_MAX_TURNS,
    PROFILE_REJECTION_REASON_MAX_CHARS,
    profileRunKey,
    type ProfileSkillRef,
} from '@/lib/agentic/agent-profile';
import type { AgentProfileVersionInput } from '../schemas/agent-profile.schemas';
import { getAgentDriverSetting } from './agent-driver-setting';
import { isPersonContext } from '../request-context-kind';
import { resolveKillState } from '@/lib/agentic/kill-switch';
import { readBreakerLatch } from '@/lib/agentic/circuit-breaker-store';

// ─── Refusals ───────────────────────────────────────────────────────

export type AgentProfileRefusal =
    | 'PROFILES_DISABLED'
    | 'AGENT_NOT_FOUND'
    | 'AGENT_RETIRED'
    | 'PROFILE_EXISTS'
    | 'PROFILE_NOT_FOUND'
    | 'VERSION_NOT_FOUND'
    | 'INSTRUCTIONS_EMPTY'
    | 'INSTRUCTIONS_TOO_LONG'
    | 'INSTRUCTIONS_REFUSED'
    | 'TOOL_NOT_GRANTED'
    | 'SKILL_UNKNOWN'
    | 'SKILL_CATALOGUE_OVER_BUDGET'
    | 'NOT_DRAFT'
    | 'NOT_SUBMITTED'
    | 'ALREADY_RETIRED'
    | 'SELF_DECISION'
    | 'DECIDER_NOT_A_PERSON'
    | 'HASH_CHANGED'
    | 'REJECTION_REASON_REQUIRED'
    | 'REJECTION_REASON_TOO_LONG'
    | 'CONCURRENT_CHANGE'
    | 'TESTER_NOT_A_PERSON'
    | 'TEST_RUN_UNAVAILABLE'
    | 'TEST_RUN_VERSION_NOT_ELIGIBLE'
    | 'TEST_RUN_TRIGGER_NOT_ALLOWED'
    | 'AGENT_KILL_SWITCHED'
    | 'AGENT_BREAKER_LATCHED';

const REFUSAL_STATUS: Record<AgentProfileRefusal, 400 | 403 | 404 | 409> = {
    PROFILES_DISABLED: 404,
    AGENT_NOT_FOUND: 404,
    AGENT_RETIRED: 409,
    PROFILE_EXISTS: 409,
    PROFILE_NOT_FOUND: 404,
    VERSION_NOT_FOUND: 404,
    INSTRUCTIONS_EMPTY: 400,
    INSTRUCTIONS_TOO_LONG: 400,
    INSTRUCTIONS_REFUSED: 400,
    TOOL_NOT_GRANTED: 400,
    SKILL_UNKNOWN: 400,
    SKILL_CATALOGUE_OVER_BUDGET: 400,
    NOT_DRAFT: 409,
    NOT_SUBMITTED: 409,
    ALREADY_RETIRED: 409,
    SELF_DECISION: 403,
    DECIDER_NOT_A_PERSON: 403,
    HASH_CHANGED: 409,
    REJECTION_REASON_REQUIRED: 400,
    REJECTION_REASON_TOO_LONG: 400,
    CONCURRENT_CHANGE: 409,
    TESTER_NOT_A_PERSON: 403,
    TEST_RUN_UNAVAILABLE: 409,
    TEST_RUN_VERSION_NOT_ELIGIBLE: 409,
    TEST_RUN_TRIGGER_NOT_ALLOWED: 409,
    AGENT_KILL_SWITCHED: 409,
    AGENT_BREAKER_LATCHED: 409,
};

/** A refusal carrying its reason as `details.reason`, beside a sentence for the person who asked. */
function refuse(reason: AgentProfileRefusal, message: string, extra: Record<string, unknown> = {}): AppError {
    const details = { reason, ...extra };
    const status = REFUSAL_STATUS[reason];
    if (status === 400) return new ValidationError(message, details);
    if (status === 409) return new ConflictError(message, details);
    if (status === 403) return new AppError(message, 'FORBIDDEN', 403, true, details);
    return new AppError(message, 'NOT_FOUND', 404, true, details);
}

/**
 * Is the profile surface on for this tenant? The deployment's switch opens it to
 * every tenant; `AGENT_PROFILES_TENANTS` opens it to the tenants it names
 * (Step 1H, #4145); with the switch unset, the tenant's organization decides
 * (#4557). No slug is never named, so the answer fails closed.
 */
export async function agentProfilesOn(tenantSlug: string | null | undefined): Promise<boolean> {
    return agentProfilesOnFor(tenantSlug);
}

/**
 * The flag, then the key. The flag first, so a deployment without the surface
 * answers every caller the same 404 and says nothing about who may act.
 */
async function assertMayManageProfiles(ctx: RequestContext): Promise<void> {
    if (!(await agentProfilesOn(ctx.tenantSlug))) throw refuse('PROFILES_DISABLED', 'Not found.');
    if (ctx.permissions.canRead !== true || ctx.appPermissions?.admin?.agent_registry !== true) {
        throw new AppError('Agent profiles require admin.agent_registry.', 'FORBIDDEN', 403, true);
    }
}

// ─── Preparing a version ────────────────────────────────────────────

/** Hex SHA-256 of the instructions exactly as stored in plaintext. */
export function profileInstructionsHash(instructions: string): string {
    return createHash('sha256').update(instructions, 'utf8').digest('hex');
}

interface PreparedVersion {
    readonly instructions: string;
    readonly instructionsHash: string;
    readonly toolNames: string[];
    readonly skillRefs: ProfileSkillRef[];
    /** `origin:name` per skill, the form an audit row carries. */
    readonly skillRefKeys: string[];
    readonly modelTier: string;
    readonly effort: string;
    readonly maxTurns: number;
    readonly outputKind: AgentProfileVersionInput['outputKind'];
    readonly allowedTriggers: string[];
}

/**
 * Sanitise, cap and scan the instructions; dedupe and sort the lists. Text the
 * scan refuses is refused here, by rule id, and never stored. The tools named
 * in the text must be the profile's own tools (`skill.undeclared_tool`), so the
 * text cannot point the model at a tool the profile does not offer.
 */
function prepareVersion(input: AgentProfileVersionInput): PreparedVersion {
    const instructions = sanitizePlainText(input.instructions).trim();
    if (instructions === '') throw refuse('INSTRUCTIONS_EMPTY', 'A profile tells its agent what to do; the instructions are empty.');
    if (instructions.length > PROFILE_INSTRUCTIONS_MAX_CHARS) {
        throw refuse(
            'INSTRUCTIONS_TOO_LONG',
            `Instructions are at most ${PROFILE_INSTRUCTIONS_MAX_CHARS} characters.`,
            { maxChars: PROFILE_INSTRUCTIONS_MAX_CHARS },
        );
    }
    const toolNames = [...new Set(input.toolNames.map((t) => t.trim()))].sort();
    const scan = scanSkillText({ description: '', instructions, declaredTools: toolNames });
    if (scan.rules.length > 0) {
        throw refuse(
            'INSTRUCTIONS_REFUSED',
            `The text scan refused these instructions (${[...scan.rules, ...scan.guardRules].join(', ')}). ` +
                'See the agent skill standard for what each rule refuses.',
            { rules: [...scan.rules], guardRules: [...scan.guardRules] },
        );
    }
    const seen = new Set<string>();
    const skillRefs: ProfileSkillRef[] = [];
    for (const ref of input.skillRefs) {
        const key = `${ref.origin}:${ref.name.trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        skillRefs.push({ origin: ref.origin, name: ref.name.trim() });
    }
    skillRefs.sort((a, b) => (a.origin + a.name < b.origin + b.name ? -1 : 1));
    return {
        instructions,
        instructionsHash: profileInstructionsHash(instructions),
        toolNames,
        skillRefs,
        skillRefKeys: skillRefs.map((r) => `${r.origin}:${r.name}`),
        modelTier: input.modelTier,
        effort: input.effort,
        maxTurns: input.maxTurns,
        outputKind: input.outputKind,
        allowedTriggers: [...new Set(input.allowedTriggers)].sort(),
    };
}

interface AgentRow {
    id: string;
    name: string;
    status: string;
    riskTier: string | null;
}

async function findAgent(db: PrismaTx, ctx: RequestContext, agentId: string): Promise<AgentRow> {
    const agent = await db.registeredAgent.findFirst({
        where: { id: agentId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true, name: true, status: true, riskTier: true },
    });
    if (!agent) throw refuse('AGENT_NOT_FOUND', 'Agent not found.');
    return agent;
}

function assertAgentNotRetired(agent: AgentRow): void {
    if (agent.status === 'RETIRED') {
        throw refuse('AGENT_RETIRED', 'A retired agent runs nothing, so its profile cannot change.');
    }
}

/**
 * Every tool the version names must be one the agent is granted NOW. Refused by
 * name, every missing one at once, never dropped: a profile that silently ran
 * with fewer tools than its author chose would look like an agent that could
 * not do its job.
 */
async function assertToolsGranted(db: PrismaTx, ctx: RequestContext, agentId: string, toolNames: readonly string[]): Promise<void> {
    const grants = await db.registeredAgentTool.findMany({
        where: { tenantId: ctx.tenantId, agentId, toolName: { in: [...toolNames] } },
        select: { toolName: true },
    });
    const granted = new Set(grants.map((g) => g.toolName));
    const missing = toolNames.filter((t) => !granted.has(t));
    if (missing.length > 0) {
        throw refuse(
            'TOOL_NOT_GRANTED',
            `The agent is not granted ${missing.join(', ')}. A profile chooses among the agent's grants; ` +
                'grant the tool on the register first.',
            { tools: missing },
        );
    }
}

/**
 * Every skill must be one the product ships or one of the tenant's APPROVED
 * skills, and together they must fit the per-run catalogue budget (#4523).
 * Mounting goes through the existing mount gate when a run is admitted by an
 * engine that runs profiles; this is the save-time and approval-time refusal.
 *
 * THE BUDGET IS THE RUN'S OWN. `runCatalogue` measures the lines
 * `resolveRunSkills` would mount for these names — each shipped skill's from
 * the corpus, each tenant skill's from its approved version, read by the
 * filter the mount reads by — through `measureCatalog`, the comparison that
 * refuses the run. A version saved here therefore fits at admission unless
 * something it names changed in between, which approval asks again and the
 * run asks a third time.
 *
 * A SHIPPED SKILL THE TEXT SCAN REFUSED IS UNKNOWN HERE (owner decision,
 * 2026-10-30). `selectableRepositorySkillNames` is the corpus's own split, the
 * one the mount path refuses a run by, so the save and the approval refuse such
 * a skill by name (`SKILL_UNKNOWN`) before the measure, which would otherwise
 * count it as nothing. Approval asks again because a deploy can refuse a skill
 * a waiting version names, and a version stored before this check was never
 * asked.
 */
async function assertSkillsFit(db: PrismaTx, ctx: RequestContext, refs: readonly ProfileSkillRef[]): Promise<void> {
    const repository = selectableRepositorySkillNames();
    const tenantNames = refs.filter((r) => r.origin === 'tenant').map((r) => r.name);
    const approved = tenantNames.length
        ? await db.tenantSkillVersion.findMany({
              where: approvedTenantSkillsByNameWhere(ctx.tenantId, tenantNames),
              select: { description: true, skill: { select: { name: true } } },
              take: tenantNames.length,
          })
        : [];
    const tenantLines = new Map<string, CatalogueLine>(
        approved.map((a) => [a.skill.name, { name: a.skill.name, description: a.description }]),
    );
    const unknown = refs
        .filter((r) => (r.origin === 'repository' ? !repository.has(r.name) : !tenantLines.has(r.name)))
        .map((r) => `${r.origin}:${r.name}`);
    if (unknown.length > 0) {
        throw refuse('SKILL_UNKNOWN', `No skill the agent may mount is called ${unknown.join(', ')}.`, { skills: unknown });
    }
    const catalogue = runCatalogue(
        refs.filter((r) => r.origin === 'repository').map((r) => r.name),
        tenantNames.map((name) => tenantLines.get(name)!),
    );
    if (!catalogue.withinBudget) {
        throw refuse(
            'SKILL_CATALOGUE_OVER_BUDGET',
            `These skills put ${catalogue.bytes} bytes in every prompt of a run, over the ${catalogue.budgetBytes}-byte ` +
                'budget, so a run of this version would be refused. Choose fewer skills, or skills with shorter descriptions.',
            { catalogueBytes: catalogue.bytes, budgetBytes: catalogue.budgetBytes },
        );
    }
}

function isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

async function insertVersion(db: PrismaTx, ctx: RequestContext, profileId: string, version: number, v: PreparedVersion) {
    return db.agentProfileVersion.create({
        data: {
            tenantId: ctx.tenantId,
            profileId,
            version,
            instructions: v.instructions,
            instructionsHash: v.instructionsHash,
            toolNames: v.toolNames,
            skillRefs: v.skillRefs.map((r) => ({ origin: r.origin, name: r.name })),
            modelTier: v.modelTier,
            effort: v.effort,
            maxTurns: v.maxTurns,
            outputKind: v.outputKind,
            allowedTriggers: v.allowedTriggers,
            authoredByUserId: ctx.userId,
        },
        select: { id: true, version: true },
    });
}

// ─── Create and edit ────────────────────────────────────────────────

export interface CreatedAgentProfileVersion {
    profileId: string;
    versionId: string;
    version: number;
    instructionsHash: string;
    /** The open version this one replaced, if any. */
    supersededVersion: number | null;
}

/** A new profile for an agent, with version 1 at DRAFT authored by the caller. */
export async function createAgentProfile(
    ctx: RequestContext,
    agentId: string,
    input: AgentProfileVersionInput,
): Promise<CreatedAgentProfileVersion> {
    await assertMayManageProfiles(ctx);
    const prepared = prepareVersion(input);
    try {
        return await runInTenantContext(ctx, async (db) => {
            const agent = await findAgent(db, ctx, agentId);
            assertAgentNotRetired(agent);
            const existing = await db.agentProfile.findFirst({
                where: { tenantId: ctx.tenantId, agentId },
                select: { id: true },
            });
            if (existing) throw refuse('PROFILE_EXISTS', 'This agent already has a profile; edit it to write a new version.');
            await assertToolsGranted(db, ctx, agentId, prepared.toolNames);
            await assertSkillsFit(db, ctx, prepared.skillRefs);
            const profile = await db.agentProfile.create({
                data: { tenantId: ctx.tenantId, agentId, createdByUserId: ctx.userId },
                select: { id: true },
            });
            const created = await insertVersion(db, ctx, profile.id, 1, prepared);
            await logEvent(db, ctx, {
                action: 'AGENT_PROFILE_CREATED',
                entityType: 'AgentProfile',
                entityId: profile.id,
                details: `Created the profile of agent ${agent.name}, version 1, as a draft`,
                detailsJson: {
                    category: 'access',
                    entityName: 'AgentProfile',
                    operation: 'created',
                    // Named at the sink, never spread: the instructions reach
                    // no audit row, only their hash.
                    after: {
                        agentId: agent.id,
                        version: 1,
                        instructionsHash: prepared.instructionsHash,
                        toolNames: prepared.toolNames,
                        skillRefs: prepared.skillRefKeys,
                        modelTier: prepared.modelTier,
                        effort: prepared.effort,
                        maxTurns: prepared.maxTurns,
                        outputKind: prepared.outputKind,
                        allowedTriggers: prepared.allowedTriggers,
                    },
                },
            });
            return {
                profileId: profile.id,
                versionId: created.id,
                version: 1,
                instructionsHash: prepared.instructionsHash,
                supersededVersion: null,
            };
        });
    } catch (err) {
        if (isUniqueViolation(err)) throw refuse('PROFILE_EXISTS', 'This agent already has a profile; edit it to write a new version.');
        throw err;
    }
}

async function findProfile(db: PrismaTx, ctx: RequestContext, agentId: string) {
    const profile = await db.agentProfile.findFirst({
        where: { tenantId: ctx.tenantId, agentId },
        select: { id: true, currentApprovedVersion: true },
    });
    if (!profile) throw refuse('PROFILE_NOT_FOUND', 'This agent has no profile.');
    return profile;
}

/**
 * Edit a profile: a NEW version N+1 at DRAFT, authored by the caller. An open
 * version (DRAFT or SUBMITTED) is retired first, so a reviewer never approves
 * text its author has already replaced. The version in force keeps running:
 * N+1 runs nothing until a second person approves it.
 */
export async function createAgentProfileVersion(
    ctx: RequestContext,
    agentId: string,
    input: AgentProfileVersionInput,
): Promise<CreatedAgentProfileVersion> {
    await assertMayManageProfiles(ctx);
    const prepared = prepareVersion(input);
    try {
        return await runInTenantContext(ctx, async (db) => {
            const agent = await findAgent(db, ctx, agentId);
            assertAgentNotRetired(agent);
            const profile = await findProfile(db, ctx, agentId);
            await assertToolsGranted(db, ctx, agentId, prepared.toolNames);
            await assertSkillsFit(db, ctx, prepared.skillRefs);
            const latest = await db.agentProfileVersion.findFirst({
                where: { tenantId: ctx.tenantId, profileId: profile.id },
                orderBy: { version: 'desc' },
                select: { version: true },
            });
            const open = await db.agentProfileVersion.findFirst({
                where: { tenantId: ctx.tenantId, profileId: profile.id, status: { in: ['DRAFT', 'SUBMITTED'] } },
                select: { id: true, version: true, status: true },
            });
            if (open) {
                const claimed = await db.agentProfileVersion.updateMany({
                    where: { id: open.id, tenantId: ctx.tenantId, status: open.status },
                    data: { status: 'RETIRED', retiredAt: new Date(), retiredByUserId: ctx.userId },
                });
                if (claimed.count !== 1) throw refuse('CONCURRENT_CHANGE', 'This profile changed while it was being edited.');
            }
            const version = (latest?.version ?? 0) + 1;
            const created = await insertVersion(db, ctx, profile.id, version, prepared);
            await logEvent(db, ctx, {
                action: 'AGENT_PROFILE_VERSION_CREATED',
                entityType: 'AgentProfileVersion',
                entityId: created.id,
                details: `Created version ${created.version} of the profile of agent ${agent.name} as a draft`,
                detailsJson: {
                    category: 'access',
                    entityName: 'AgentProfileVersion',
                    operation: 'created',
                    after: {
                        agentId: agent.id,
                        profileId: profile.id,
                        version: created.version,
                        instructionsHash: prepared.instructionsHash,
                        toolNames: prepared.toolNames,
                        skillRefs: prepared.skillRefKeys,
                        modelTier: prepared.modelTier,
                        effort: prepared.effort,
                        maxTurns: prepared.maxTurns,
                        outputKind: prepared.outputKind,
                        allowedTriggers: prepared.allowedTriggers,
                        supersededVersion: open?.version ?? null,
                    },
                },
            });
            return {
                profileId: profile.id,
                versionId: created.id,
                version,
                instructionsHash: prepared.instructionsHash,
                supersededVersion: open?.version ?? null,
            };
        });
    } catch (err) {
        if (isUniqueViolation(err)) throw refuse('CONCURRENT_CHANGE', 'This profile changed while it was being edited.');
        throw err;
    }
}

// ─── Review ─────────────────────────────────────────────────────────

const VERSION_SELECT = {
    id: true,
    version: true,
    status: true,
    instructions: true,
    instructionsHash: true,
    toolNames: true,
    skillRefs: true,
    authoredByUserId: true,
} as const;

async function findVersion(db: PrismaTx, ctx: RequestContext, profileId: string, version: number) {
    const v = await db.agentProfileVersion.findFirst({
        where: { tenantId: ctx.tenantId, profileId, version },
        select: VERSION_SELECT,
    });
    if (!v) throw refuse('VERSION_NOT_FOUND', 'Profile version not found.');
    return v;
}

/** DRAFT → SUBMITTED. */
export async function submitAgentProfileVersion(ctx: RequestContext, agentId: string, version: number): Promise<{ status: 'SUBMITTED' }> {
    await assertMayManageProfiles(ctx);
    return runInTenantContext(ctx, async (db) => {
        const agent = await findAgent(db, ctx, agentId);
        assertAgentNotRetired(agent);
        const profile = await findProfile(db, ctx, agentId);
        const v = await findVersion(db, ctx, profile.id, version);
        if (v.status !== 'DRAFT') throw refuse('NOT_DRAFT', 'Only a draft is submitted for review.');
        const claimed = await db.agentProfileVersion.updateMany({
            where: { id: v.id, tenantId: ctx.tenantId, status: 'DRAFT' },
            data: { status: 'SUBMITTED', submittedAt: new Date(), submittedByUserId: ctx.userId },
        });
        if (claimed.count !== 1) throw refuse('CONCURRENT_CHANGE', 'This version changed while it was being submitted.');
        await logEvent(db, ctx, {
            action: 'AGENT_PROFILE_SUBMITTED',
            entityType: 'AgentProfileVersion',
            entityId: v.id,
            details: `Submitted version ${v.version} of the profile of agent ${agent.name} for review`,
            detailsJson: {
                category: 'access',
                entityName: 'AgentProfileVersion',
                operation: 'updated',
                before: { status: 'DRAFT' },
                after: { status: 'SUBMITTED', agentId: agent.id, version: v.version, instructionsHash: v.instructionsHash },
            },
        });
        return { status: 'SUBMITTED' as const };
    });
}

/** The four-eyes rule, for approval and rejection alike. */
function assertMayDecide(ctx: RequestContext, authoredByUserId: string): void {
    if (ctx.apiKeyId) {
        throw refuse('DECIDER_NOT_A_PERSON', 'A profile version is decided by a signed-in person, never by an API key.');
    }
    if (authoredByUserId === ctx.userId) {
        throw refuse('SELF_DECISION', 'The author of a profile version cannot approve or reject it.');
    }
}

/**
 * SUBMITTED → APPROVED, by a person other than the author, naming the hash they
 * read. The stored text is re-scanned and re-hashed, every tool re-checked
 * against the agent's grants, and the skills re-measured against the per-run
 * catalogue budget, because each can have changed while the version waited: a
 * grant revoked, a tenant skill retired or approved again with a longer
 * description (its own approval measures the workflows it names, never the
 * profiles), a deploy that lengthened a shipped description, or a version saved
 * before the budget was asked at save. The version in force is retired and the
 * pointer moves in the same transaction.
 */
export async function approveAgentProfileVersion(
    ctx: RequestContext,
    agentId: string,
    version: number,
    input: { instructionsHash: string },
): Promise<{ status: 'APPROVED'; instructionsHash: string; runKey: string; supersededVersion: number | null }> {
    await assertMayManageProfiles(ctx);
    return runInTenantContext(ctx, async (db) => {
        const agent = await findAgent(db, ctx, agentId);
        assertAgentNotRetired(agent);
        const profile = await findProfile(db, ctx, agentId);
        const v = await findVersion(db, ctx, profile.id, version);
        if (v.status !== 'SUBMITTED') throw refuse('NOT_SUBMITTED', 'Only a submitted version can be approved.');
        assertMayDecide(ctx, v.authoredByUserId);
        if (input.instructionsHash !== v.instructionsHash || profileInstructionsHash(v.instructions) !== v.instructionsHash) {
            throw refuse('HASH_CHANGED', 'The instructions you read are not this version\'s; read the version again before approving.');
        }
        const scan = scanSkillText({ description: '', instructions: v.instructions, declaredTools: v.toolNames });
        if (scan.rules.length > 0) {
            throw refuse(
                'INSTRUCTIONS_REFUSED',
                `The text scan refuses this version (${[...scan.rules, ...scan.guardRules].join(', ')}).`,
                { rules: [...scan.rules], guardRules: [...scan.guardRules] },
            );
        }
        await assertToolsGranted(db, ctx, agentId, v.toolNames);
        await assertSkillsFit(db, ctx, viewSkillRefs(v.skillRefs));

        const now = new Date();
        const inForce = await db.agentProfileVersion.findFirst({
            where: { tenantId: ctx.tenantId, profileId: profile.id, status: 'APPROVED' },
            select: { id: true, version: true },
        });
        if (inForce) {
            const retired = await db.agentProfileVersion.updateMany({
                where: { id: inForce.id, tenantId: ctx.tenantId, status: 'APPROVED' },
                data: { status: 'RETIRED', retiredAt: now, retiredByUserId: ctx.userId },
            });
            if (retired.count !== 1) throw refuse('CONCURRENT_CHANGE', 'This profile changed while it was being approved.');
        }
        const claimed = await db.agentProfileVersion.updateMany({
            where: { id: v.id, tenantId: ctx.tenantId, status: 'SUBMITTED' },
            data: { status: 'APPROVED', decidedAt: now, decidedByUserId: ctx.userId },
        });
        if (claimed.count !== 1) throw refuse('CONCURRENT_CHANGE', 'This version changed while it was being approved.');
        await db.agentProfile.update({
            where: { id: profile.id },
            data: { currentApprovedVersion: version },
        });
        await logEvent(db, ctx, {
            action: 'AGENT_PROFILE_APPROVED',
            entityType: 'AgentProfileVersion',
            entityId: v.id,
            details: `Approved version ${v.version} of the profile of agent ${agent.name}`,
            detailsJson: {
                category: 'access',
                entityName: 'AgentProfileVersion',
                operation: 'updated',
                before: { status: 'SUBMITTED' },
                after: {
                    status: 'APPROVED',
                    agentId: agent.id,
                    version: v.version,
                    instructionsHash: v.instructionsHash,
                    authoredByUserId: v.authoredByUserId,
                    toolNames: v.toolNames,
                    supersededVersion: inForce?.version ?? null,
                },
            },
        });
        return {
            status: 'APPROVED' as const,
            instructionsHash: v.instructionsHash,
            runKey: profileRunKey(profile.id, version),
            supersededVersion: inForce?.version ?? null,
        };
    });
}

/**
 * SUBMITTED → REJECTED, by a person other than the author, saying why (Step
 * 1b). The reason is sanitised, required and capped, written once beside the
 * decision and encrypted at rest; the author reads it on the version they
 * wrote. It reaches no audit row: it is a sentence about the instructions.
 */
export async function rejectAgentProfileVersion(
    ctx: RequestContext,
    agentId: string,
    version: number,
    input: { reason: string },
): Promise<{ status: 'REJECTED' }> {
    await assertMayManageProfiles(ctx);
    const reason = sanitizePlainText(input.reason).trim();
    if (reason === '') throw refuse('REJECTION_REASON_REQUIRED', 'Say why the version is rejected, so its author can act on it.');
    if (reason.length > PROFILE_REJECTION_REASON_MAX_CHARS) {
        throw refuse('REJECTION_REASON_TOO_LONG', `A rejection reason is at most ${PROFILE_REJECTION_REASON_MAX_CHARS} characters.`, {
            maxChars: PROFILE_REJECTION_REASON_MAX_CHARS,
        });
    }
    return runInTenantContext(ctx, async (db) => {
        const agent = await findAgent(db, ctx, agentId);
        const profile = await findProfile(db, ctx, agentId);
        const v = await findVersion(db, ctx, profile.id, version);
        if (v.status !== 'SUBMITTED') throw refuse('NOT_SUBMITTED', 'Only a submitted version can be rejected.');
        assertMayDecide(ctx, v.authoredByUserId);
        const claimed = await db.agentProfileVersion.updateMany({
            where: { id: v.id, tenantId: ctx.tenantId, status: 'SUBMITTED' },
            data: { status: 'REJECTED', decidedAt: new Date(), decidedByUserId: ctx.userId, rejectionReason: reason },
        });
        if (claimed.count !== 1) throw refuse('CONCURRENT_CHANGE', 'This version changed while it was being rejected.');
        await logEvent(db, ctx, {
            action: 'AGENT_PROFILE_REJECTED',
            entityType: 'AgentProfileVersion',
            entityId: v.id,
            details: `Rejected version ${v.version} of the profile of agent ${agent.name}`,
            detailsJson: {
                category: 'access',
                entityName: 'AgentProfileVersion',
                operation: 'updated',
                before: { status: 'SUBMITTED' },
                after: { status: 'REJECTED', agentId: agent.id, version: v.version, instructionsHash: v.instructionsHash },
            },
        });
        return { status: 'REJECTED' as const };
    });
}

/**
 * Take a version out: any status but RETIRED → RETIRED. Retiring the version in
 * force clears the pointer, so the profile runs nothing until another version
 * is approved. Allowed on a retired agent: taking something out of service is
 * the safe direction.
 */
export async function retireAgentProfileVersion(ctx: RequestContext, agentId: string, version: number): Promise<{ status: 'RETIRED' }> {
    await assertMayManageProfiles(ctx);
    return runInTenantContext(ctx, async (db) => {
        const agent = await findAgent(db, ctx, agentId);
        const profile = await findProfile(db, ctx, agentId);
        const v = await findVersion(db, ctx, profile.id, version);
        if (v.status === 'RETIRED') throw refuse('ALREADY_RETIRED', 'This version is already retired.');
        const claimed = await db.agentProfileVersion.updateMany({
            where: { id: v.id, tenantId: ctx.tenantId, status: v.status },
            data: { status: 'RETIRED', retiredAt: new Date(), retiredByUserId: ctx.userId },
        });
        if (claimed.count !== 1) throw refuse('CONCURRENT_CHANGE', 'This version changed while it was being retired.');
        if (v.status === 'APPROVED') {
            await db.agentProfile.updateMany({
                where: { id: profile.id, tenantId: ctx.tenantId, currentApprovedVersion: version },
                data: { currentApprovedVersion: null },
            });
        }
        await logEvent(db, ctx, {
            action: 'AGENT_PROFILE_RETIRED',
            entityType: 'AgentProfileVersion',
            entityId: v.id,
            details: `Retired version ${v.version} of the profile of agent ${agent.name}`,
            detailsJson: {
                category: 'access',
                entityName: 'AgentProfileVersion',
                operation: 'updated',
                before: { status: v.status },
                after: {
                    status: 'RETIRED',
                    agentId: agent.id,
                    version: v.version,
                    instructionsHash: v.instructionsHash,
                    wasInForce: v.status === 'APPROVED',
                },
            },
        });
        return { status: 'RETIRED' as const };
    });
}

// ─── Read ───────────────────────────────────────────────────────────

/** A person on a version, as the tab shows them: a label, and whether it is the viewer. */
export interface AgentProfilePerson {
    label: string | null;
    isViewer: boolean;
}

export interface AgentProfileVersionView {
    id: string;
    version: number;
    status: string;
    instructions: string;
    instructionsHash: string;
    toolNames: string[];
    skillRefs: ProfileSkillRef[];
    modelTier: string;
    effort: string;
    maxTurns: number;
    outputKind: string;
    allowedTriggers: string[];
    author: AgentProfilePerson;
    submittedAt: string | null;
    decidedBy: AgentProfilePerson | null;
    decidedAt: string | null;
    rejectionReason: string | null;
    retiredAt: string | null;
    createdAt: string;
    /**
     * The four-eyes affordance, computed here so the page offers exactly what
     * the server would accept: a SUBMITTED version, a signed-in person, never
     * its author.
     */
    canDecide: boolean;
}

export interface AgentProfileView {
    /** Null before the agent's first version. */
    profile: { profileId: string; currentApprovedVersion: number | null; runKey: string | null } | null;
    /** Newest first. */
    versions: AgentProfileVersionView[];
    /**
     * What an editor may choose from: the tools the agent is granted NOW and
     * the skills it may mount. The pickers offer these and nothing else; the
     * save refuses anything outside them anyway.
     */
    options: { tools: string[]; skills: ProfileSkillOption[] };
    /**
     * Whether a Test run can start for this agent, and why not (Step 2c). The
     * version's own `allowedTriggers` decide per version; this is everything
     * that does not depend on the version.
     */
    testRun: ProfileTestRunState;
    limits: {
        instructionsMaxChars: number;
        maxTurns: number;
        rejectionReasonMaxChars: number;
        /** The per-run catalogue budget a version's skills are held to (#4523). */
        skillCatalogueBudgetBytes: number;
    };
}

/**
 * A skill the editor may offer, with what its catalogue line costs every
 * prompt of a run (#4523), measured here by the run's own measure. The editor
 * adds the chosen ones up to show a running total against
 * `limits.skillCatalogueBudgetBytes`; the save decides.
 */
export interface ProfileSkillOption extends ProfileSkillRef {
    catalogueBytes: number;
}

/**
 * Whether a Test run can start for an agent, before any version is named.
 *
 *   • `ENGINE_DOES_NOT_RUN_PROFILES`: the workspace chose an engine that does
 *     not run a profile, named, so the page can say which and where to change it;
 *   • `ENGINE_NOT_IN_FORCE`: it chose the Tool Runner, and the engine is not in
 *     force (the deployment's switch, or the build), so a run would refuse;
 *   • `AGENT_NOT_READY`: the agent is not ACTIVE and risk-assessed, which a
 *     reasoning-engine run requires of the agent it runs as.
 *
 * The start path asks the same questions again, and admission asks them a
 * third time: this state is for the button, not the gate.
 */
export type ProfileTestRunState =
    | { available: true }
    | { available: false; reason: 'ENGINE_DOES_NOT_RUN_PROFILES'; engine: 'STATIC' | 'FLUE' }
    | { available: false; reason: 'ENGINE_NOT_IN_FORCE' }
    | { available: false; reason: 'AGENT_NOT_READY' };

/** The Test run state from the engine setting and the agent. */
export function profileTestRunState(
    engine: { mode: string; effectiveDriver: string },
    agent: { status: string; riskTier: string | null },
): ProfileTestRunState {
    if (engine.mode !== 'TOOL_RUNNER') {
        return { available: false, reason: 'ENGINE_DOES_NOT_RUN_PROFILES', engine: engine.mode === 'FLUE' ? 'FLUE' : 'STATIC' };
    }
    if (engine.effectiveDriver !== 'tool-runner') return { available: false, reason: 'ENGINE_NOT_IN_FORCE' };
    if (agent.status !== 'ACTIVE' || agent.riskTier === null) return { available: false, reason: 'AGENT_NOT_READY' };
    return { available: true };
}

/** Display labels for members of this tenant, by user id. Unknown ids are absent. */
async function memberLabels(db: PrismaTx, ctx: RequestContext, userIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const members = await db.tenantMembership.findMany({
        where: { tenantId: ctx.tenantId, userId: { in: ids } },
        select: { userId: true, user: { select: { name: true, email: true } } },
        take: ids.length,
    });
    return new Map(members.map((m) => [m.userId, m.user.name ?? m.user.email]));
}

/**
 * The skills a profile may mount: the shipped skills the text scan did not
 * refuse and the tenant's APPROVED skills, each with the bytes its catalogue
 * line costs, measured by `runCatalogue`, which is what the save measures the
 * chosen set by. The repository names are the ones `assertSkillsFit` accepts,
 * from the same function, so the picker offers nothing the save refuses as
 * unknown.
 */
async function mountableSkills(db: PrismaTx, ctx: RequestContext): Promise<ProfileSkillOption[]> {
    const tenant = await db.tenantSkillVersion.findMany({
        where: { tenantId: ctx.tenantId, status: 'APPROVED' },
        select: { description: true, skill: { select: { name: true } } },
        take: 200,
    });
    const tenantLines = new Map<string, CatalogueLine>();
    for (const t of tenant) {
        if (!tenantLines.has(t.skill.name)) tenantLines.set(t.skill.name, { name: t.skill.name, description: t.description });
    }
    return [
        ...[...selectableRepositorySkillNames()].sort().map((name) => ({
            origin: 'repository' as const,
            name,
            catalogueBytes: runCatalogue([name], []).bytes,
        })),
        ...[...tenantLines.values()]
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .map((line) => ({ origin: 'tenant' as const, name: line.name, catalogueBytes: runCatalogue([], [line]).bytes })),
    ];
}

/** The stored skill refs, read back; anything malformed is dropped from the VIEW only. */
function viewSkillRefs(raw: unknown): ProfileSkillRef[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((r) => {
        const { origin, name } = (r ?? {}) as { origin?: unknown; name?: unknown };
        return (origin === 'repository' || origin === 'tenant') && typeof name === 'string' ? [{ origin, name }] : [];
    });
}

/**
 * One agent's profile, its newest versions, and what the tab may offer. An
 * agent with no profile yet answers with `profile: null` and the options, so
 * the first version can be written.
 */
export async function getAgentProfile(ctx: RequestContext, agentId: string): Promise<AgentProfileView> {
    await assertMayManageProfiles(ctx);
    // Read outside the transaction below: it opens its own, and it is the same
    // read the settings page and the run path make (Step 2c).
    const engine = await getAgentDriverSetting(ctx);
    return runInTenantContext(ctx, async (db) => {
        const agent = await findAgent(db, ctx, agentId);
        const grants = await db.registeredAgentTool.findMany({
            where: { tenantId: ctx.tenantId, agentId },
            select: { toolName: true },
            orderBy: { toolName: 'asc' },
            take: 500,
        });
        const options = { tools: grants.map((g) => g.toolName), skills: await mountableSkills(db, ctx) };
        const testRun = profileTestRunState({ mode: engine.mode, effectiveDriver: engine.effective.driver }, agent);
        const limits = {
            instructionsMaxChars: PROFILE_INSTRUCTIONS_MAX_CHARS,
            maxTurns: PROFILE_MAX_TURNS,
            rejectionReasonMaxChars: PROFILE_REJECTION_REASON_MAX_CHARS,
            skillCatalogueBudgetBytes: MAX_CATALOG_BYTES,
        };

        const profile = await db.agentProfile.findFirst({
            where: { tenantId: ctx.tenantId, agentId },
            select: { id: true, currentApprovedVersion: true },
        });
        if (!profile) return { profile: null, versions: [], options, testRun, limits };

        const rows = await db.agentProfileVersion.findMany({
            where: { tenantId: ctx.tenantId, profileId: profile.id },
            orderBy: { version: 'desc' },
            take: 50,
            select: {
                id: true,
                version: true,
                status: true,
                instructions: true,
                instructionsHash: true,
                toolNames: true,
                skillRefs: true,
                modelTier: true,
                effort: true,
                maxTurns: true,
                outputKind: true,
                allowedTriggers: true,
                authoredByUserId: true,
                submittedAt: true,
                decidedAt: true,
                decidedByUserId: true,
                rejectionReason: true,
                retiredAt: true,
                createdAt: true,
            },
        });
        const labels = await memberLabels(db, ctx, rows.flatMap((r) => [r.authoredByUserId, ...(r.decidedByUserId ? [r.decidedByUserId] : [])]));
        const person = (userId: string): AgentProfilePerson => ({ label: labels.get(userId) ?? null, isViewer: userId === ctx.userId });
        const versions: AgentProfileVersionView[] = rows.map((r) => ({
            id: r.id,
            version: r.version,
            status: r.status,
            instructions: r.instructions,
            instructionsHash: r.instructionsHash,
            toolNames: r.toolNames,
            skillRefs: viewSkillRefs(r.skillRefs),
            modelTier: r.modelTier,
            effort: r.effort,
            maxTurns: r.maxTurns,
            outputKind: r.outputKind,
            allowedTriggers: r.allowedTriggers,
            author: person(r.authoredByUserId),
            submittedAt: r.submittedAt?.toISOString() ?? null,
            decidedBy: r.decidedByUserId ? person(r.decidedByUserId) : null,
            decidedAt: r.decidedAt?.toISOString() ?? null,
            rejectionReason: r.rejectionReason,
            retiredAt: r.retiredAt?.toISOString() ?? null,
            createdAt: r.createdAt.toISOString(),
            canDecide: r.status === 'SUBMITTED' && !ctx.apiKeyId && r.authoredByUserId !== ctx.userId,
        }));
        return {
            profile: {
                profileId: profile.id,
                currentApprovedVersion: profile.currentApprovedVersion,
                runKey: profile.currentApprovedVersion === null ? null : profileRunKey(profile.id, profile.currentApprovedVersion),
            },
            versions,
            options,
            testRun,
            limits,
        };
    });
}

// ─── The Test run (Step 2c, #4150) ─────────────────────────────────

/**
 * START A TEST RUN of one version of an agent's profile, from its Behaviour tab.
 *
 * A person tries a version: the approved one in force, or the one submitted for
 * review, so a reviewer can see what they are asked to approve do something.
 * The run:
 *
 *   • runs AS THE AGENT, with the person's own context and the agent bound
 *     (`{ ...ctx, agentId }`, the interactive run's seam): the agent's grants,
 *     card, ceiling and kill switch apply, and the person's permissions are one
 *     term of the intersection, never a way around it;
 *   • is READ-ONLY: started with read authority, under a Test-run key whose
 *     definition withholds the propose surface, here and in the worker;
 *   • is refused, named, when the version does not allow `TEST_RUN`, when the
 *     workspace's engine does not run profiles, or when the agent is stopped.
 *
 * Admission (`startWorkflowRun` → `resolveRunDefinition`) checks the version,
 * its trigger, the engine and the agent's standing again. This usecase exists
 * for what admission cannot know: that a PERSON asked, and which agent.
 */
export async function startAgentProfileTestRun(
    ctx: RequestContext,
    agentId: string,
    version: number,
): Promise<{ runId: string; status: string; runKey: string }> {
    await assertMayManageProfiles(ctx);
    if (!isPersonContext(ctx)) {
        throw refuse(
            'TESTER_NOT_A_PERSON',
            'A Test run is started by a signed-in person from the Behaviour tab. An API key, an agent and a ' +
                'scheduled job each start runs their own way.',
        );
    }

    const engine = await getAgentDriverSetting(ctx);
    const { runKey } = await runInTenantContext(ctx, async (db) => {
        const agent = await findAgent(db, ctx, agentId);
        assertAgentNotRetired(agent);
        const state = profileTestRunState({ mode: engine.mode, effectiveDriver: engine.effective.driver }, agent);
        if (!state.available) {
            throw refuse('TEST_RUN_UNAVAILABLE', TEST_RUN_UNAVAILABLE_MESSAGE[state.reason], { state });
        }
        const profile = await db.agentProfile.findFirst({
            where: { tenantId: ctx.tenantId, agentId },
            select: { id: true, currentApprovedVersion: true },
        });
        if (!profile) throw refuse('PROFILE_NOT_FOUND', 'This agent has no profile.');
        const row = await db.agentProfileVersion.findFirst({
            where: { tenantId: ctx.tenantId, profileId: profile.id, version },
            select: { version: true, status: true, allowedTriggers: true },
        });
        if (!row) throw refuse('VERSION_NOT_FOUND', 'No such version of this profile.');
        const inForce = row.status === 'APPROVED' && profile.currentApprovedVersion === row.version;
        if (!inForce && row.status !== 'SUBMITTED') {
            throw refuse(
                'TEST_RUN_VERSION_NOT_ELIGIBLE',
                'A Test run tries the approved version in force or the version submitted for review.',
            );
        }
        if (!row.allowedTriggers.includes('TEST_RUN')) {
            throw refuse(
                'TEST_RUN_TRIGGER_NOT_ALLOWED',
                'This version does not allow Test runs. Write a version that allows them.',
            );
        }
        return { runKey: profileRunKey(profile.id, row.version, { testRun: true }) };
    });

    const kill = await resolveKillState(ctx.tenantId, agentId);
    if (kill) {
        throw refuse('AGENT_KILL_SWITCHED', `A kill switch is in force for this agent (scope: ${kill.scope}).`);
    }
    const latch = await readBreakerLatch(ctx.tenantId, agentId);
    if (latch?.state === 'OPEN') {
        throw refuse('AGENT_BREAKER_LATCHED', "This agent's circuit breaker is latched open and must be reset.");
    }

    // Lazily, as the interactive run does: `workflow-runs` imports this module's
    // neighbour (`agent-profile-runs`), which imports this one.
    const { startWorkflowRun } = await import('./workflow-runs');
    const started = await startWorkflowRun({ ...ctx, agentId }, runKey, {}, {
        readOnlyAuthority: true,
        profileTrigger: 'TEST_RUN',
    });
    return { runId: started.runId, status: started.status, runKey };
}

const TEST_RUN_UNAVAILABLE_MESSAGE: Record<Exclude<ProfileTestRunState, { available: true }>['reason'], string> = {
    ENGINE_DOES_NOT_RUN_PROFILES:
        'This workspace runs agents on an engine that does not run agent profiles. An owner can choose the ' +
        'Tool Runner engine under Admin, AI features, Agent engines.',
    ENGINE_NOT_IN_FORCE:
        'This workspace has chosen the Tool Runner engine, but it is not running on this deployment yet.',
    AGENT_NOT_READY: 'A Test run runs as the agent, so the agent must be active and risk-assessed.',
};
