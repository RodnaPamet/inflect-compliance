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
 * granted now: an ungranted tool is refused BY NAME, never dropped. Approval
 * asks both again, because a grant can be revoked while a version waits.
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
import { env } from '@/env';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { AppError, ConflictError, ValidationError } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { scanSkillText } from '@/lib/agentic/flue/skills/text-scan';
import { repositorySkillNames } from '@/lib/agentic/flue/skills/resolve';
import {
    agentProfilesEnabledFor,
    PROFILE_INSTRUCTIONS_MAX_CHARS,
    PROFILE_MAX_TURNS,
    PROFILE_REJECTION_REASON_MAX_CHARS,
    profileRunKey,
    type ProfileSkillRef,
} from '@/lib/agentic/agent-profile';
import type { AgentProfileVersionInput } from '../schemas/agent-profile.schemas';

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
    | 'NOT_DRAFT'
    | 'NOT_SUBMITTED'
    | 'ALREADY_RETIRED'
    | 'SELF_DECISION'
    | 'DECIDER_NOT_A_PERSON'
    | 'HASH_CHANGED'
    | 'REJECTION_REASON_REQUIRED'
    | 'REJECTION_REASON_TOO_LONG'
    | 'CONCURRENT_CHANGE';

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
    NOT_DRAFT: 409,
    NOT_SUBMITTED: 409,
    ALREADY_RETIRED: 409,
    SELF_DECISION: 403,
    DECIDER_NOT_A_PERSON: 403,
    HASH_CHANGED: 409,
    REJECTION_REASON_REQUIRED: 400,
    REJECTION_REASON_TOO_LONG: 400,
    CONCURRENT_CHANGE: 409,
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
 * (Step 1H, #4145). No slug is never named, so the answer fails closed.
 */
export function agentProfilesOn(tenantSlug: string | null | undefined): boolean {
    return agentProfilesEnabledFor(env.AGENT_PROFILES, env.AGENT_PROFILES_TENANTS, tenantSlug);
}

/**
 * The flag, then the key. The flag first, so a deployment without the surface
 * answers every caller the same 404 and says nothing about who may act.
 */
function assertMayManageProfiles(ctx: RequestContext): void {
    if (!agentProfilesOn(ctx.tenantSlug)) throw refuse('PROFILES_DISABLED', 'Not found.');
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
}

async function findAgent(db: PrismaTx, ctx: RequestContext, agentId: string): Promise<AgentRow> {
    const agent = await db.registeredAgent.findFirst({
        where: { id: agentId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true, name: true, status: true },
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
 * skills. Mounting goes through the existing mount gate when a run is admitted
 * by an engine that runs profiles; this is the save-time refusal.
 */
async function assertSkillsKnown(db: PrismaTx, ctx: RequestContext, refs: readonly ProfileSkillRef[]): Promise<void> {
    const repository = repositorySkillNames();
    const tenantNames = refs.filter((r) => r.origin === 'tenant').map((r) => r.name);
    const approved = tenantNames.length
        ? await db.tenantSkillVersion.findMany({
              where: { tenantId: ctx.tenantId, status: 'APPROVED', skill: { name: { in: tenantNames } } },
              select: { skill: { select: { name: true } } },
              take: tenantNames.length,
          })
        : [];
    const approvedNames = new Set(approved.map((a) => a.skill.name));
    const unknown = refs
        .filter((r) => (r.origin === 'repository' ? !repository.has(r.name) : !approvedNames.has(r.name)))
        .map((r) => `${r.origin}:${r.name}`);
    if (unknown.length > 0) {
        throw refuse('SKILL_UNKNOWN', `No skill the agent may mount is called ${unknown.join(', ')}.`, { skills: unknown });
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
    assertMayManageProfiles(ctx);
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
            await assertSkillsKnown(db, ctx, prepared.skillRefs);
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
    assertMayManageProfiles(ctx);
    const prepared = prepareVersion(input);
    try {
        return await runInTenantContext(ctx, async (db) => {
            const agent = await findAgent(db, ctx, agentId);
            assertAgentNotRetired(agent);
            const profile = await findProfile(db, ctx, agentId);
            await assertToolsGranted(db, ctx, agentId, prepared.toolNames);
            await assertSkillsKnown(db, ctx, prepared.skillRefs);
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
    assertMayManageProfiles(ctx);
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
 * read. The stored text is re-scanned and re-hashed and every tool re-checked
 * against the agent's grants, because either can have changed while the version
 * waited. The version in force is retired and the pointer moves in the same
 * transaction.
 */
export async function approveAgentProfileVersion(
    ctx: RequestContext,
    agentId: string,
    version: number,
    input: { instructionsHash: string },
): Promise<{ status: 'APPROVED'; instructionsHash: string; runKey: string; supersededVersion: number | null }> {
    assertMayManageProfiles(ctx);
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
    assertMayManageProfiles(ctx);
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
    assertMayManageProfiles(ctx);
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
    options: { tools: string[]; skills: ProfileSkillRef[] };
    /**
     * Whether a test run can start, and why not. One state in this build: no
     * engine runs a profile (decision 7), so the Behaviour tab's Test run is
     * disabled and names the engine setting it needs. Step 2c adds the start
     * path and the state in which it is offered, together; until then there is
     * no `available: true` for a page to act on.
     */
    testRun: { available: false; reason: 'NO_ENGINE_RUNS_PROFILES' };
    limits: { instructionsMaxChars: number; maxTurns: number; rejectionReasonMaxChars: number };
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

/** The skills a profile may mount: the shipped corpus and the tenant's APPROVED skills. */
async function mountableSkills(db: PrismaTx, ctx: RequestContext): Promise<ProfileSkillRef[]> {
    const tenant = await db.tenantSkillVersion.findMany({
        where: { tenantId: ctx.tenantId, status: 'APPROVED' },
        select: { skill: { select: { name: true } } },
        take: 200,
    });
    return [
        ...[...repositorySkillNames()].sort().map((name) => ({ origin: 'repository' as const, name })),
        ...[...new Set(tenant.map((t) => t.skill.name))].sort().map((name) => ({ origin: 'tenant' as const, name })),
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
    assertMayManageProfiles(ctx);
    return runInTenantContext(ctx, async (db) => {
        await findAgent(db, ctx, agentId);
        const grants = await db.registeredAgentTool.findMany({
            where: { tenantId: ctx.tenantId, agentId },
            select: { toolName: true },
            orderBy: { toolName: 'asc' },
            take: 500,
        });
        const options = { tools: grants.map((g) => g.toolName), skills: await mountableSkills(db, ctx) };
        const testRun = { available: false, reason: 'NO_ENGINE_RUNS_PROFILES' } as const;
        const limits = {
            instructionsMaxChars: PROFILE_INSTRUCTIONS_MAX_CHARS,
            maxTurns: PROFILE_MAX_TURNS,
            rejectionReasonMaxChars: PROFILE_REJECTION_REASON_MAX_CHARS,
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
