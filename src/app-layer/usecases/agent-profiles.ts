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
 * skill must be one a run could mount (a shipped skill the text scan or the
 * mount gate refuses, and an approved tenant skill the tenant mount gate now
 * refuses, are not), and together they must fit the per-run catalogue budget
 * (`assertSkillsKnownAndWithinBudget`). Approval asks all of
 * it again, because a grant can be revoked, and a skill can stop mounting or
 * cost more, while a version waits.
 *
 * ── THE FLAG ────────────────────────────────────────────────────────────────
 *
 * With `AGENT_PROFILES` off every act answers 404 (`PROFILES_DISABLED`), before
 * any read, so the surface is absent rather than refused.
 *
 * ── THE FLOW (Phase 1 of `docs/ai-architecture/langflow.md`) ───────────────
 *
 * A version may carry a drawn flow (`src/lib/agentic/agent-flow.ts`): data,
 * checked by `checkAgentFlow`, its labels sanitised and scanned with the
 * instructions, stored canonical and encrypted in `flowJson`, and covered by
 * the content hash (`profileContentHash`) the approver names and the resolver
 * recomputes. With a flow the version's `toolNames` is DERIVED from it and
 * never entered beside it, so the existing grant check is the flow's grant
 * check; a `subagent` node must name an APPROVED profile in the caller's
 * tenant. No new route and no new permission: the version routes take `flow`.
 *
 * ── INLINE SUB-AGENTS (Step 2e of `docs/claude-tool-runner-design.md`) ──────
 *
 * A version may instead carry up to four sub-agents (never beside a flow):
 * each a name, its own instructions (sanitised, capped, scanned against ITS
 * tools), a subset of the version's tools and skills, and a turn limit no
 * higher than the version's. Every rule is a refusal by name (`SUBAGENT_*`),
 * asked at save and again at approval. They are stored canonical and
 * encrypted in `subagentsJson`, frozen by the version trigger, and covered by
 * the content hash under its own domain, so no existing version's hash moves.
 *
 * ── COMPACTION (Step 2g of `docs/claude-tool-runner-design.md`) ─────────────
 *
 * A version may turn the engine's context compaction off (`0`) or lower its
 * threshold, and never raise it: a value below the minimum
 * (`COMPACTION_THRESHOLD_BELOW_MINIMUM`) or above the tier's engine threshold
 * (`COMPACTION_THRESHOLD_ABOVE_TIER`) is refused at save and again at
 * approval, where a deploy may have lowered the tier's constant while the
 * version waited. It is frozen by the version trigger and shown to the
 * approver, and it is not in the content hash.
 *
 * Audit rows carry hashes, version numbers, tool names, sub-agent names and
 * rule ids, never the instructions, a sub-agent's instructions or a flow's
 * labels.
 */
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';

import type { RequestContext } from '../types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { AppError, ConflictError, ValidationError } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { scanSkillText } from '@/lib/agentic/flue/skills/text-scan';
import { mountableTenantSkillLines, repositorySkillCatalogue } from '@/lib/agentic/flue/skills/resolve';
import { readApprovedTenantSkillsByNameIn, readMountableTenantSkillLines } from '@/lib/agentic/flue/skills/tenant-mount';
import { catalogBytes, MAX_CATALOG_BYTES } from '@/lib/agentic/flue/skills';
import { agentProfilesOnFor } from '@/lib/agentic/agent-switches-policy';
import {
    PROFILE_COMPACTION_THRESHOLD_MIN,
    PROFILE_INSTRUCTIONS_MAX_CHARS,
    PROFILE_MAX_SUBAGENTS,
    PROFILE_MAX_TURNS,
    PROFILE_REJECTION_REASON_MAX_CHARS,
    checkProfileDeferredTools,
    checkProfileSubagents,
    parseStoredProfileSubagents,
    profileNamesNoReadTool,
    profileRunKey,
    serializeProfileSubagents,
    type ProfileModelTier,
    type ProfileSkillOption,
    type ProfileSkillRef,
    type ProfileSubagent,
    type ProfileSubagentRefusal,
    type ProfileDeferredToolRefusal,
} from '@/lib/agentic/agent-profile';
import { compactionThresholdFor } from '@/lib/agentic/tool-runner/compaction';
import { COMPACTION_THRESHOLD_TOKENS } from '@/lib/agentic/tool-runner/params';
import { ENGINE_RUN_CAPS } from '@/lib/agentic/run-caps';
import type { AgentProfileVersionInput } from '../schemas/agent-profile.schemas';
import { getAgentDriverSetting } from './agent-driver-setting';
import {
    checkAgentFlow,
    flowLabels,
    flowSubagentRefs,
    flowToolNames,
    flowToolsAgree,
    parseStoredAgentFlow,
    serializeAgentFlow,
    type AgentFlow,
    type AgentFlowRefusal,
} from '@/lib/agentic/agent-flow';
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
    | 'TEST_RUN_NO_READ_TOOL'
    | 'AGENT_KILL_SWITCHED'
    | 'AGENT_BREAKER_LATCHED'
    | AgentFlowRefusal
    | 'FLOW_LABEL_EMPTY'
    | 'FLOW_OUTPUT_KIND_CONFLICT'
    | 'FLOW_SUBAGENT_SELF'
    | 'FLOW_SUBAGENT_NOT_APPROVED'
    | 'FLOW_UNREADABLE'
    | 'FLOW_TOOLS_DIVERGED'
    | ProfileSubagentRefusal
    | 'SUBAGENTS_UNREADABLE'
    | 'COMPACTION_THRESHOLD_BELOW_MINIMUM'
    | 'COMPACTION_THRESHOLD_ABOVE_TIER'
    | ProfileDeferredToolRefusal;

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
    SKILL_CATALOGUE_OVER_BUDGET: 409,
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
    TEST_RUN_NO_READ_TOOL: 409,
    AGENT_KILL_SWITCHED: 409,
    AGENT_BREAKER_LATCHED: 409,
    FLOW_INVALID: 400,
    FLOW_CHECKPOINT_UNENFORCED: 400,
    FLOW_TOO_MANY_NODES: 400,
    FLOW_DUPLICATE_KEY: 400,
    FLOW_UNKNOWN_EDGE_END: 400,
    FLOW_SELF_EDGE: 400,
    FLOW_DUPLICATE_EDGE: 400,
    FLOW_CYCLE: 400,
    FLOW_TOOL_KIND_MISMATCH: 400,
    FLOW_NAMES_NO_TOOL: 400,
    FLOW_LABEL_EMPTY: 400,
    FLOW_OUTPUT_KIND_CONFLICT: 400,
    FLOW_SUBAGENT_SELF: 400,
    FLOW_SUBAGENT_NOT_APPROVED: 400,
    FLOW_UNREADABLE: 409,
    FLOW_TOOLS_DIVERGED: 409,
    SUBAGENTS_TOO_MANY: 400,
    SUBAGENTS_WITH_FLOW: 400,
    SUBAGENT_NAME_INVALID: 400,
    SUBAGENT_NAME_DUPLICATE: 400,
    SUBAGENT_INSTRUCTIONS_EMPTY: 400,
    SUBAGENT_INSTRUCTIONS_TOO_LONG: 400,
    SUBAGENT_INSTRUCTIONS_REFUSED: 400,
    SUBAGENT_NAMES_NO_TOOL: 400,
    SUBAGENT_TOOL_NOT_IN_VERSION: 400,
    SUBAGENT_SKILL_NOT_IN_VERSION: 400,
    SUBAGENT_MAX_TURNS_ABOVE_VERSION: 400,
    SUBAGENTS_UNREADABLE: 409,
    COMPACTION_THRESHOLD_BELOW_MINIMUM: 400,
    COMPACTION_THRESHOLD_ABOVE_TIER: 400,
    DEFERRED_TOOL_NOT_IN_VERSION: 400,
    DEFERRED_TOOL_NOT_A_PROPOSE_TOOL: 400,
    DEFERRED_TOOLS_WITH_FLOW: 400,
    SUBAGENT_TOOL_DEFERRED: 400,
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
export async function assertMayManageProfiles(ctx: RequestContext): Promise<void> {
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

/** Names the flow-bearing form of the content hash, so it is never the bare-text form. */
const FLOW_CONTENT_HASH_DOMAIN = 'inflect-agent-profile-content/1';

/**
 * Names the sub-agent-bearing form (Step 2e, #4594): a second domain, so no
 * value of the first two forms can collide with it.
 */
const SUBAGENT_CONTENT_HASH_DOMAIN = 'inflect-agent-profile-content/2';

/**
 * THE VERSION'S CONTENT HASH, stored in `instructionsHash`: what the approver
 * names and what a run pins and recomputes.
 *
 *   - No flow, no sub-agents: the hash of the instructions alone, byte for
 *     byte what it has always been, so every version and every run pin
 *     written before flows existed still verifies.
 *   - A flow: the hash of `[domain/1, instructions, flowJson]` as JSON, an
 *     unambiguous encoding of both columns, so a changed flow is a changed
 *     hash exactly as changed instructions are (`PROFILE_HASH_MISMATCH` at the
 *     resolver, `HASH_CHANGED` at approval).
 *   - Any sub-agents (Step 2e): the hash of `[domain/2, instructions,
 *     flowJson ?? null, subagentsJson]`, over the STORED string, never a
 *     re-serialisation, so a later build that canonicalises differently
 *     cannot move it. A version with none stores NULL and takes one of the two
 *     forms above, byte for byte, so NO EXISTING VERSION'S HASH CHANGES: every
 *     approved version, every run pin and every hash an approver has named
 *     still verifies. Changing one sub-agent's text changes the hash.
 */
// `subagentsJson` is REQUIRED, never defaulted: a caller that left it out
// would hash a sub-agent version without its sub-agents, so the third argument
// is a compile error to forget rather than a silent mismatch to debug.
export function profileContentHash(instructions: string, flowJson: string | null, subagentsJson: string | null): string {
    if (subagentsJson !== null) {
        return createHash('sha256')
            .update(JSON.stringify([SUBAGENT_CONTENT_HASH_DOMAIN, instructions, flowJson, subagentsJson]), 'utf8')
            .digest('hex');
    }
    if (flowJson === null) return profileInstructionsHash(instructions);
    return createHash('sha256')
        .update(JSON.stringify([FLOW_CONTENT_HASH_DOMAIN, instructions, flowJson]), 'utf8')
        .digest('hex');
}

interface PreparedVersion {
    readonly instructions: string;
    readonly instructionsHash: string;
    readonly toolNames: string[];
    /** Canonical JSON of the checked flow, or null for a version with none. */
    readonly flowJson: string | null;
    /** The profiles the flow's `subagent` nodes hand work to. */
    readonly subagentRefs: string[];
    /** Node count, the only fact about a flow an audit row carries. */
    readonly flowNodeCount: number | null;
    /** Canonical JSON of the checked sub-agents, or null for a version with none. */
    readonly subagentsJson: string | null;
    readonly subagents: readonly ProfileSubagent[];
    /** The sub-agents' names and tools, for the audit row. */
    readonly subagentFacts: SubagentAuditFacts;
    readonly skillRefs: ProfileSkillRef[];
    /** `origin:name` per skill, the form an audit row carries. */
    readonly skillRefKeys: string[];
    readonly modelTier: string;
    readonly effort: string;
    readonly maxTurns: number;
    /** NULL takes the engine's threshold, 0 turns compaction off (Step 2g). */
    readonly compactionThresholdTokens: number | null;
    /** The propose tools whose calls wait for a person (Step 2f): sorted, checked. */
    readonly deferredToolNames: string[];
    readonly outputKind: AgentProfileVersionInput['outputKind'];
    readonly allowedTriggers: string[];
}

/**
 * A version's compaction threshold may only LOWER the engine's (Step 2g, owner
 * decision 2 of 2026-11-13): NULL and 0 always pass; any other value is the
 * minimum to the tier's engine threshold. Asked at save and at approval.
 */
function assertCompactionThreshold(value: number | null, tier: string): void {
    if (value === null || value === 0) return;
    if (!Number.isInteger(value) || value < PROFILE_COMPACTION_THRESHOLD_MIN) {
        throw refuse(
            'COMPACTION_THRESHOLD_BELOW_MINIMUM',
            `A compaction threshold is 0 (off) or at least ${PROFILE_COMPACTION_THRESHOLD_MIN} tokens.`,
            { min: PROFILE_COMPACTION_THRESHOLD_MIN, value },
        );
    }
    const max = COMPACTION_THRESHOLD_TOKENS[tier as ProfileModelTier];
    if (max === undefined || value > max) {
        throw refuse(
            'COMPACTION_THRESHOLD_ABOVE_TIER',
            `A version may lower the engine's compaction threshold, never raise it: at most ${max ?? 0} tokens for this tier.`,
            { tier, max: max ?? null, value },
        );
    }
}

/**
 * THE VERSION'S DEFERRED TOOLS (Step 2f): checked by the pure rule, refused by
 * name, never dropped. Asked at save and again at approval, where the stored
 * list must also be the canonical one this build would have written.
 */
function assertDeferredTools(
    names: readonly string[],
    version: Parameters<typeof checkProfileDeferredTools>[1],
): string[] {
    const checked = checkProfileDeferredTools(names, version);
    if (!checked.ok) throw refuse(checked.reason, checked.message, checked.tool ? { tool: checked.tool } : {});
    return checked.deferredToolNames;
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
    const flow = input.flow === undefined || input.flow === null ? null : prepareFlow(input.flow, input.outputKind);
    // With a flow the tools are the flow's, never a list entered beside it.
    const toolNames = flow ? flowToolNames(flow) : [...new Set((input.toolNames ?? []).map((t) => t.trim()))].sort();
    // A flow's labels reach the run message beside the instructions, so they
    // are scanned with them: one scan, one set of rule ids.
    const scannedText = flow ? [instructions, ...flowLabels(flow)].join('\n') : instructions;
    const scan = scanSkillText({ description: '', instructions: scannedText, declaredTools: toolNames });
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
    const flowJson = flow ? serializeAgentFlow(flow) : null;
    const subagents = prepareSubagents(input, { toolNames, skillRefs, maxTurns: input.maxTurns }, flow !== null);
    const subagentsJson = serializeProfileSubagents(subagents);
    const compactionThresholdTokens = input.compactionThresholdTokens ?? null;
    assertCompactionThreshold(compactionThresholdTokens, input.modelTier);
    const deferredToolNames = assertDeferredTools(input.deferredToolNames ?? [], {
        toolNames,
        subagents,
        hasFlow: flow !== null,
    });
    return {
        instructions,
        instructionsHash: profileContentHash(instructions, flowJson, subagentsJson),
        toolNames,
        flowJson,
        subagentRefs: flow ? flowSubagentRefs(flow) : [],
        flowNodeCount: flow ? flow.nodes.length : null,
        subagentsJson,
        subagents,
        subagentFacts: subagentAuditFacts(subagents),
        skillRefs,
        skillRefKeys: skillRefs.map((r) => `${r.origin}:${r.name}`),
        modelTier: input.modelTier,
        effort: input.effort,
        maxTurns: input.maxTurns,
        compactionThresholdTokens,
        deferredToolNames,
        outputKind: input.outputKind,
        allowedTriggers: [...new Set(input.allowedTriggers)].sort(),
    };
}

/** A sub-agent refusal from the pure check, as the usecase's error. */
function refuseSubagents(check: Extract<ReturnType<typeof checkProfileSubagents>, { ok: false }>): AppError {
    return refuse(check.reason, check.message, { ...check.details });
}

/**
 * Hold each sub-agent's instructions to the text scan, with `declaredTools`
 * set to THAT sub-agent's own tools: text naming a tool outside its subset is
 * refused by `skill.undeclared_tool`, exactly as the version's text is held to
 * the version's tools. Asked at save and again at approval.
 */
function assertSubagentTextScans(subagents: readonly ProfileSubagent[]): void {
    for (const s of subagents) {
        const scan = scanSkillText({ description: '', instructions: s.instructions, declaredTools: s.toolNames });
        if (scan.rules.length > 0) {
            throw refuse(
                'SUBAGENT_INSTRUCTIONS_REFUSED',
                `The text scan refused sub-agent ${s.name}'s instructions (${[...scan.rules, ...scan.guardRules].join(', ')}).`,
                { subagent: s.name, rules: [...scan.rules], guardRules: [...scan.guardRules] },
            );
        }
    }
}

/**
 * THE VERSION'S SUB-AGENTS (Step 2e, #4594): sanitised, checked against the
 * version's own sets, scanned, and canonical. Every rule is a refusal by name
 * (`SUBAGENT_*`), never a silent drop, and a version carries a flow or
 * sub-agents, never both (`SUBAGENTS_WITH_FLOW`, owner decision 1).
 *
 * The version's own grant, skill and catalogue checks need no change: each
 * sub-agent's sets are subsets of the version's, so a version whose sets pass
 * already covers its sub-agents.
 */
function prepareSubagents(
    input: AgentProfileVersionInput,
    version: { toolNames: readonly string[]; skillRefs: readonly ProfileSkillRef[]; maxTurns: number },
    hasFlow: boolean,
): readonly ProfileSubagent[] {
    const raw = input.subagents ?? [];
    if (raw.length === 0) return [];
    if (hasFlow) {
        throw refuse('SUBAGENTS_WITH_FLOW', 'A version carries a drawn flow or sub-agents, never both.');
    }
    if (raw.length > PROFILE_MAX_SUBAGENTS) {
        throw refuse('SUBAGENTS_TOO_MANY', `A version has at most ${PROFILE_MAX_SUBAGENTS} sub-agents.`, {
            max: PROFILE_MAX_SUBAGENTS,
            count: raw.length,
        });
    }
    const checked = checkProfileSubagents(
        raw.map((s) => ({ ...s, instructions: sanitizePlainText(s.instructions).trim() })),
        version,
        { instructionsMaxChars: PROFILE_INSTRUCTIONS_MAX_CHARS },
    );
    if (!checked.ok) throw refuseSubagents(checked);
    assertSubagentTextScans(checked.subagents);
    return checked.subagents;
}

/**
 * A stored list of sub-agents, read back for approval. Unreadable, or no longer
 * a subset of the version's own sets, is refused rather than approved as "no
 * sub-agents"; a version that also stores a flow was not written by the writer.
 */
function readStoredSubagents(
    v: { subagentsJson: string | null; flowJson: string | null; toolNames: string[]; skillRefs: unknown; maxTurns: number },
): readonly ProfileSubagent[] {
    if (v.subagentsJson === null) return [];
    if (v.flowJson !== null) throw refuse('SUBAGENTS_WITH_FLOW', 'A version carries a drawn flow or sub-agents, never both.');
    const parsed = parseStoredProfileSubagents(v.subagentsJson, {
        toolNames: v.toolNames,
        skillRefs: viewSkillRefs(v.skillRefs),
        maxTurns: v.maxTurns,
    });
    if (!parsed) {
        throw refuse('SUBAGENTS_UNREADABLE', 'This version\'s sub-agents cannot be read by this build; write a new version.');
    }
    return parsed;
}

/**
 * What an audit row says about a version's sub-agents: their names and each
 * one's tools, never their instructions. Computed here and NAMED at each sink
 * (`no-raw-prompt-logging`), so no field bag reaches a row.
 */
interface SubagentAuditFacts {
    readonly names: string[];
    readonly toolNames: Record<string, string[]>;
}

function subagentAuditFacts(subagents: readonly ProfileSubagent[]): SubagentAuditFacts {
    return {
        names: subagents.map((s) => s.name),
        toolNames: Object.fromEntries(subagents.map((s) => [s.name, [...s.toolNames]])),
    };
}

/**
 * Check a flow from a request body: its shape and graph rules, then every label
 * sanitised (`sanitizePlainText`) and the result checked AGAIN, so what is
 * stored and hashed is the sanitised, canonical flow. A propose node in a
 * version that answers only would be a step the run withholds, so it is
 * refused rather than silently ignored.
 */
function prepareFlow(raw: unknown, outputKind: AgentProfileVersionInput['outputKind']): AgentFlow {
    const first = checkAgentFlow(raw);
    if (!first.ok) throw refuse(first.reason, first.message, first.detail ? { detail: [...first.detail] } : {});
    const sanitised = {
        nodes: first.flow.nodes.map((n) => ({ ...n, label: sanitizePlainText(n.label).trim() })),
        edges: first.flow.edges,
    };
    const blank = sanitised.nodes.filter((n) => n.label === '').map((n) => n.key);
    if (blank.length > 0) throw refuse('FLOW_LABEL_EMPTY', 'Every step of a flow says what it does.', { detail: blank });
    const second = checkAgentFlow(sanitised);
    if (!second.ok) throw refuse(second.reason, second.message, second.detail ? { detail: [...second.detail] } : {});
    if (outputKind === 'ANSWER_ONLY' && second.flow.nodes.some((n) => n.kind === 'propose')) {
        throw refuse(
            'FLOW_OUTPUT_KIND_CONFLICT',
            'This version answers only, so a propose step in its flow would never run. Remove the step, or let ' +
                'the version propose.',
        );
    }
    return second.flow;
}

/**
 * Every `subagent` node must name an APPROVED profile in the caller's tenant,
 * never its own (a profile handing work to itself is a loop the graph check
 * cannot see). Read through the tenant filter and RLS both, so another
 * tenant's profile is indistinguishable from none: refused by reference, all
 * missing ones at once.
 */
async function assertSubagentRefsApproved(
    db: PrismaTx,
    ctx: RequestContext,
    refs: readonly string[],
    ownProfileId: string | null,
): Promise<void> {
    if (refs.length === 0) return;
    if (ownProfileId !== null && refs.includes(ownProfileId)) {
        throw refuse('FLOW_SUBAGENT_SELF', 'A profile cannot hand its own work to itself.', { profiles: [ownProfileId] });
    }
    const found = await db.agentProfile.findMany({
        where: { tenantId: ctx.tenantId, id: { in: [...refs] }, currentApprovedVersion: { not: null } },
        select: {
            id: true,
            currentApprovedVersion: true,
            agent: { select: { status: true, deletedAt: true } },
            versions: { where: { status: 'APPROVED' }, select: { version: true }, take: 1 },
        },
        take: refs.length,
    });
    const approved = new Set(
        found
            .filter((p) => p.agent.status !== 'RETIRED' && p.agent.deletedAt === null)
            .filter((p) => p.versions.length === 1 && p.versions[0].version === p.currentApprovedVersion)
            .map((p) => p.id),
    );
    const missing = refs.filter((r) => !approved.has(r));
    if (missing.length > 0) {
        throw refuse(
            'FLOW_SUBAGENT_NOT_APPROVED',
            'A subagent step names a profile that is not an approved profile of an agent in this workspace.',
            { profiles: missing },
        );
    }
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
 * skills, AND the catalogue they form must fit the per-run budget.
 *
 * ── WHY THE BUDGET BELONGS HERE AND NOT ONLY AT THE RUN (#4523) ─────────────
 *
 * A run is refused when its catalogue exceeds `MAX_CATALOG_BYTES` — since
 * #4151 that includes a profile's run, refused at ADMISSION by
 * `resolveRunSkills` before the run row exists. So without this check a version
 * naming too many skills could be saved, submitted, approved, and then never
 * run: the reviewer learns at the first Test run instead of at review.
 *
 * It is not hypothetical. The shipped corpus ALONE is over budget — its eleven
 * skills total 3,187 bytes against 2,048 — so a profile naming all of them is
 * reachable in two clicks.
 *
 * This is the same shape `tenant-skills.ts` already applies when a tenant skill
 * is approved (`CATALOGUE_OVER_BUDGET`, via `workflowsOverBudget`), and the
 * pricing is the same function the run uses, `catalogBytes`, so the two cannot
 * disagree about what a catalogue costs.
 *
 * **The run still applies the budget too, and must.** A later deploy can
 * lengthen a shipped skill's description, and approving a tenant skill does not
 * consider the profiles that name it — so a version that fit at approval can
 * stop fitting. This check moves the refusal earlier for the common case; it
 * does not make the run's check redundant.
 *
 * A repository ref must name a MOUNTABLE shipped skill (#4590): the keys of
 * `repositorySkillCatalogue()`, never `repositorySkillNames()`. The latter
 * includes skills the load-time text scan refused, by design, because a tenant
 * skill may take none of those names; but a refused skill cannot mount, so a
 * profile naming one could be saved and approved and then never run. It is
 * refused here as `SKILL_UNKNOWN`, by name, and the picker does not offer it.
 * The same holds for a shipped skill the mount gate refuses, for want of a
 * passing evaluation record for its text (owner decision, 2026-10-30): the
 * catalogue asks the gate's cached verdict, as a run's mount does.
 *
 * And for an APPROVED tenant skill the tenant mount gate now refuses (owner
 * decision, 2026-10-30). Its version is read as admission reads it
 * (`readApprovedTenantSkillsByNameIn`, the mount's own columns) and asked what
 * admission asks (`mountableTenantSkillLines`: the tenant mount gate, and no
 * shipped skill of its name). Its approval passed that gate once, but a deploy
 * can tighten the scan or the record check, and the pinned hash is recomputed
 * from the stored text. One read of the named versions, so the cost is the
 * number of tenant skills named.
 */
async function assertSkillsKnownAndWithinBudget(
    db: PrismaTx,
    ctx: RequestContext,
    refs: readonly ProfileSkillRef[],
): Promise<void> {
    const shipped = repositorySkillCatalogue();
    const tenantNames = refs.filter((r) => r.origin === 'tenant').map((r) => r.name);
    const mountable = mountableTenantSkillLines(await readApprovedTenantSkillsByNameIn(db, ctx.tenantId, tenantNames));
    const approvedByName = new Map(mountable.map((l) => [l.name, l.description]));
    const unknown = refs
        .filter((r) => (r.origin === 'repository' ? !shipped.has(r.name) : !approvedByName.has(r.name)))
        .map((r) => `${r.origin}:${r.name}`);
    if (unknown.length > 0) {
        // Checked FIRST: a wrong NAME is more useful to be told than a size,
        // and pricing an unknown skill would price it at zero.
        throw refuse('SKILL_UNKNOWN', `No skill the agent may mount is called ${unknown.join(', ')}.`, { skills: unknown });
    }

    const lines = refs
        .map((r) =>
            r.origin === 'repository'
                ? shipped.get(r.name)
                : { name: r.name, description: approvedByName.get(r.name) ?? '' },
        )
        .filter((d): d is { name: string; description: string } => d !== undefined);
    const bytes = catalogBytes(lines);
    if (bytes > MAX_CATALOG_BYTES) {
        throw refuse(
            'SKILL_CATALOGUE_OVER_BUDGET',
            `These ${refs.length} skills would cost ${bytes} bytes of catalogue on every turn, over the `
                + `${MAX_CATALOG_BYTES} budget, so no run could mount them. Name fewer skills, or shorten a `
                + 'description of one the workspace owns.',
            { bytes, budget: MAX_CATALOG_BYTES, skills: refs.map((r) => `${r.origin}:${r.name}`) },
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
            flowJson: v.flowJson,
            subagentsJson: v.subagentsJson,
            skillRefs: v.skillRefs.map((r) => ({ origin: r.origin, name: r.name })),
            modelTier: v.modelTier,
            effort: v.effort,
            maxTurns: v.maxTurns,
            compactionThresholdTokens: v.compactionThresholdTokens,
            deferredToolNames: v.deferredToolNames,
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
            await assertSkillsKnownAndWithinBudget(db, ctx, prepared.skillRefs);
            await assertSubagentRefsApproved(db, ctx, prepared.subagentRefs, null);
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
                        flowNodeCount: prepared.flowNodeCount,
                        subagents: {
                            count: prepared.subagentFacts.names.length,
                            names: prepared.subagentFacts.names,
                            toolNames: prepared.subagentFacts.toolNames,
                        },
                        skillRefs: prepared.skillRefKeys,
                        modelTier: prepared.modelTier,
                        effort: prepared.effort,
                        maxTurns: prepared.maxTurns,
                        compactionThresholdTokens: prepared.compactionThresholdTokens,
                        deferredToolNames: prepared.deferredToolNames,
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
            await assertSkillsKnownAndWithinBudget(db, ctx, prepared.skillRefs);
            await assertSubagentRefsApproved(db, ctx, prepared.subagentRefs, profile.id);
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
                        flowNodeCount: prepared.flowNodeCount,
                        subagents: {
                            count: prepared.subagentFacts.names.length,
                            names: prepared.subagentFacts.names,
                            toolNames: prepared.subagentFacts.toolNames,
                        },
                        skillRefs: prepared.skillRefKeys,
                        modelTier: prepared.modelTier,
                        effort: prepared.effort,
                        maxTurns: prepared.maxTurns,
                        compactionThresholdTokens: prepared.compactionThresholdTokens,
                        deferredToolNames: prepared.deferredToolNames,
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
    // Read so approval can re-check the flow the version carries (Phase 1).
    flowJson: true,
    // Read so approval can re-check the sub-agents the version carries (Step 2e).
    subagentsJson: true,
    // Read so approval can price the catalogue the version names (#4523).
    skillRefs: true,
    maxTurns: true,
    // Read so approval can hold the compaction threshold to the tier again (Step 2g).
    modelTier: true,
    compactionThresholdTokens: true,
    // Read so approval can re-check the deferred tools (Step 2f).
    deferredToolNames: true,
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

/**
 * A stored flow, read back for approval. Unreadable is refused rather than
 * approved as "no flow", and the stored `toolNames` must be exactly what the
 * flow derives: the two lists are one fact, and a row where they disagree was
 * not written by the writer.
 */
function readStoredFlow(flowJson: string, toolNames: readonly string[]): AgentFlow {
    const flow = parseStoredAgentFlow(flowJson);
    if (!flow) throw refuse('FLOW_UNREADABLE', 'This version\'s flow cannot be read by this build; write a new version.');
    if (!flowToolsAgree(flow, toolNames)) {
        throw refuse('FLOW_TOOLS_DIVERGED', 'This version\'s tools are not the tools its flow uses; write a new version.');
    }
    return flow;
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
    await assertMayManageProfiles(ctx);
    return runInTenantContext(ctx, async (db) => {
        const agent = await findAgent(db, ctx, agentId);
        assertAgentNotRetired(agent);
        const profile = await findProfile(db, ctx, agentId);
        const v = await findVersion(db, ctx, profile.id, version);
        if (v.status !== 'SUBMITTED') throw refuse('NOT_SUBMITTED', 'Only a submitted version can be approved.');
        assertMayDecide(ctx, v.authoredByUserId);
        if (
            input.instructionsHash !== v.instructionsHash ||
            profileContentHash(v.instructions, v.flowJson, v.subagentsJson) !== v.instructionsHash
        ) {
            throw refuse('HASH_CHANGED', 'The instructions you read are not this version\'s; read the version again before approving.');
        }
        const flow = v.flowJson === null ? null : readStoredFlow(v.flowJson, v.toolNames);
        // Every sub-agent rule asked again, as the version's own checks are:
        // the text scan's rules can change while a version waits (Step 2e).
        const subagents = readStoredSubagents(v);
        const stored = { subagentFacts: subagentAuditFacts(subagents) };
        const scannedText = flow ? [v.instructions, ...flowLabels(flow)].join('\n') : v.instructions;
        const scan = scanSkillText({ description: '', instructions: scannedText, declaredTools: v.toolNames });
        if (scan.rules.length > 0) {
            throw refuse(
                'INSTRUCTIONS_REFUSED',
                `The text scan refuses this version (${[...scan.rules, ...scan.guardRules].join(', ')}).`,
                { rules: [...scan.rules], guardRules: [...scan.guardRules] },
            );
        }
        assertSubagentTextScans(subagents);
        // Asked again (Step 2g): a deploy may have lowered the tier's engine
        // threshold while the version waited, and a version never raises it.
        assertCompactionThreshold(v.compactionThresholdTokens, v.modelTier);
        // Asked again (Step 2f), every rule by name, and the stored list must be
        // the canonical one: the approver approves the waits a run will make.
        const deferred = assertDeferredTools(v.deferredToolNames, {
            toolNames: v.toolNames,
            subagents,
            hasFlow: v.flowJson !== null,
        });
        if (deferred.join('\n') !== v.deferredToolNames.join('\n')) {
            throw refuse('DEFERRED_TOOL_NOT_IN_VERSION', 'The stored deferred tools are not in the form this build writes.');
        }
        await assertToolsGranted(db, ctx, agentId, v.toolNames);
        // Re-priced at APPROVAL, not just at save (#4523): a deploy between the
        // two can lengthen a shipped skill's description, and approving a tenant
        // skill does not consider the profiles that name it. The reviewer is the
        // last person who can act on it before a run is refused.
        await assertSkillsKnownAndWithinBudget(db, ctx, viewSkillRefs(v.skillRefs));
        // A subagent's profile can be retired, or its agent retired, while this
        // version waits: asked again, as the grants are.
        if (flow) await assertSubagentRefsApproved(db, ctx, flowSubagentRefs(flow), profile.id);

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
                    subagents: {
                        count: stored.subagentFacts.names.length,
                        names: stored.subagentFacts.names,
                        toolNames: stored.subagentFacts.toolNames,
                    },
                    // What the approver approved about compaction (Step 2g).
                    compactionThresholdTokens: v.compactionThresholdTokens,
                    // …and which calls wait for a person (Step 2f).
                    deferredToolNames: v.deferredToolNames,
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
    /** The drawn flow, or null. Read back for the reviewer; never in an audit row. */
    flow: AgentFlow | null;
    /**
     * The inline sub-agents (Step 2e), in name order, or `[]` for a version
     * with none. Read back for the reviewer, instructions included; never in
     * an audit row. A stored list this build cannot read is `[]` here and is
     * refused at approval (`SUBAGENTS_UNREADABLE`).
     */
    subagents: ProfileSubagent[];
    skillRefs: ProfileSkillRef[];
    modelTier: string;
    effort: string;
    maxTurns: number;
    /**
     * The version's compaction threshold (Step 2g): null takes the engine's,
     * 0 turns compaction off. Shown to the approver, so they know whether a run
     * of the version may summarise its own history.
     */
    compactionThresholdTokens: number | null;
    /**
     * The propose tools whose calls wait for a person (Step 2f). Shown to the
     * approver, so "this agent waits for a person on propose_finding" is part
     * of what is approved.
     */
    deferredToolNames: string[];
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
        /** The per-run catalogue budget the save and the run apply (#4590). */
        skillCatalogueBudgetBytes: number;
        /**
         * The bounds a version's compaction threshold takes (Step 2g): at least
         * `min`, at most the tier's engine threshold, and the threshold a run
         * of each tier takes when the version leaves it to the engine.
         */
        compactionThreshold: {
            min: number;
            maxByTier: Record<ProfileModelTier, number>;
            engineDefaultByTier: Record<ProfileModelTier, number>;
        };
    };
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

/**
 * The compaction bounds the Behaviour editor offers (Step 2g): the minimum, the
 * tier's engine threshold as the maximum, and the threshold a run takes by
 * default under the engine's TOKENS cap (no policy card raises it).
 */
function compactionThresholdLimits(): AgentProfileView['limits']['compactionThreshold'] {
    const tiers = Object.keys(COMPACTION_THRESHOLD_TOKENS) as ProfileModelTier[];
    return {
        min: PROFILE_COMPACTION_THRESHOLD_MIN,
        maxByTier: { ...COMPACTION_THRESHOLD_TOKENS },
        engineDefaultByTier: Object.fromEntries(
            tiers.map((tier) => [tier, compactionThresholdFor({ tier, tokensLimit: ENGINE_RUN_CAPS.TOKENS }) ?? 0]),
        ) as Record<ProfileModelTier, number>,
    };
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
 * The skills a profile may mount, each with what its catalogue line costs: the
 * MOUNTABLE shipped skills (one the text scan refused or the mount gate
 * refuses is absent, #4590) and the tenant's APPROVED skills a run could mount
 * (one the tenant mount gate refuses is absent). Exactly the population
 * `assertSkillsKnownAndWithinBudget` accepts, priced by the same
 * `catalogBytes`, so the editor's running total is the figure the save checks.
 *
 * THE COST of the tenant half, per load: at most `PICKER_TENANT_VERSIONS`
 * approved versions, read in pages of `MOUNTABLE_TENANT_SKILL_PAGE` (so at
 * most ten queries), each version's two encrypted columns decrypted, its
 * instructions hashed and scanned, and its evaluation record parsed and
 * recomputed. One page of records is held at a time.
 */
async function mountableSkills(db: PrismaTx, ctx: RequestContext): Promise<ProfileSkillOption[]> {
    const tenant = await readMountableTenantSkillLines(db, ctx.tenantId, PICKER_TENANT_VERSIONS);
    const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const shipped = [...repositorySkillCatalogue().values()].sort(byName);
    const own = [...new Map(tenant.map((t) => [t.name, t.description])).entries()]
        .map(([name, description]) => ({ name, description }))
        .sort(byName);
    return [
        ...shipped.map((s) => ({ origin: 'repository' as const, name: s.name, catalogueBytes: catalogBytes([s]) })),
        ...own.map((s) => ({ origin: 'tenant' as const, name: s.name, catalogueBytes: catalogBytes([s]) })),
    ];
}

/**
 * The newest this many versions are in the Behaviour tab's view, plus the
 * version in force whenever it is older than all of them (#5374).
 */
const VIEW_VERSIONS = 50;

/** At most this many approved tenant versions are read, and gated, for one picker. */
const PICKER_TENANT_VERSIONS = 200;

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
            compactionThreshold: compactionThresholdLimits(),
        };

        const profile = await db.agentProfile.findFirst({
            where: { tenantId: ctx.tenantId, agentId },
            select: { id: true, currentApprovedVersion: true },
        });
        if (!profile) return { profile: null, versions: [], options, testRun, limits };

        const versionSelect = {
            id: true,
            version: true,
            status: true,
            instructions: true,
            instructionsHash: true,
            toolNames: true,
            flowJson: true,
            subagentsJson: true,
            skillRefs: true,
            modelTier: true,
            effort: true,
            maxTurns: true,
            compactionThresholdTokens: true,
            deferredToolNames: true,
            outputKind: true,
            allowedTriggers: true,
            authoredByUserId: true,
            submittedAt: true,
            decidedAt: true,
            decidedByUserId: true,
            rejectionReason: true,
            retiredAt: true,
            createdAt: true,
        } as const;
        const newest = await db.agentProfileVersion.findMany({
            where: { tenantId: ctx.tenantId, profileId: profile.id },
            orderBy: { version: 'desc' },
            take: VIEW_VERSIONS,
            select: versionSelect,
        });
        // THE VERSION IN FORCE IS ALWAYS IN THE VIEW (#5374). The page above is
        // the newest versions, and a profile edited more than `VIEW_VERSIONS`
        // times since its last approval would otherwise drop the approved one:
        // the tab then said no version was in force and offered no Test run,
        // while runs used it. One more bounded read, only when it fell off.
        const inForce = profile.currentApprovedVersion;
        const missing = inForce !== null && !newest.some((r) => r.version === inForce);
        const rows = missing
            ? [
                  ...newest,
                  ...(await db.agentProfileVersion.findMany({
                      where: { tenantId: ctx.tenantId, profileId: profile.id, version: inForce },
                      take: 1,
                      select: versionSelect,
                  })),
              ]
            : newest;
        const labels = await memberLabels(db, ctx, rows.flatMap((r) => [r.authoredByUserId, ...(r.decidedByUserId ? [r.decidedByUserId] : [])]));
        const person = (userId: string): AgentProfilePerson => ({ label: labels.get(userId) ?? null, isViewer: userId === ctx.userId });
        const versions: AgentProfileVersionView[] = rows.map((r) => ({
            id: r.id,
            version: r.version,
            status: r.status,
            instructions: r.instructions,
            instructionsHash: r.instructionsHash,
            toolNames: r.toolNames,
            flow: r.flowJson === null ? null : parseStoredAgentFlow(r.flowJson),
            subagents:
                r.subagentsJson === null
                    ? []
                    : [
                          ...(parseStoredProfileSubagents(r.subagentsJson, {
                              toolNames: r.toolNames,
                              skillRefs: viewSkillRefs(r.skillRefs),
                              maxTurns: r.maxTurns,
                          }) ?? []),
                      ],
            skillRefs: viewSkillRefs(r.skillRefs),
            modelTier: r.modelTier,
            effort: r.effort,
            maxTurns: r.maxTurns,
            compactionThresholdTokens: r.compactionThresholdTokens,
            deferredToolNames: r.deferredToolNames,
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
 *   • is refused, named, when the version does not allow `TEST_RUN`, when it
 *     names only propose tools (so a read-only run would be offered nothing,
 *     #5374), when the workspace's engine does not run profiles, or when the
 *     agent is stopped.
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
            select: { version: true, status: true, allowedTriggers: true, toolNames: true },
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
        // A Test run is read-only, so a version naming only propose tools would
        // be offered nothing and settle EMPTY_CATALOGUE having sent nothing
        // (#5374). Refused here, by name, before a run row exists.
        if (profileNamesNoReadTool(row.toolNames)) {
            throw refuse(
                'TEST_RUN_NO_READ_TOOL',
                'A Test run is read-only, so it is offered no propose tool, and this version names only propose ' +
                    'tools. Write a version that names a read tool to try it.',
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

// ─── The flow editor's subagent picker (Phase 3 of langflow.md) ─────

/** One profile a flow's `subagent` step may name. */
export interface FlowSubagentOption {
    profileId: string;
    agentName: string;
    version: number;
}

/**
 * The profiles a `subagent` step may hand work to: APPROVED, in force, in this
 * workspace, of an agent that is neither retired nor deleted, and never the
 * agent's own. The rule `assertSubagentRefsApproved` applies at save and at
 * approval, read here so the picker offers nothing the save would refuse. The
 * save still asks: a picker is a convenience, the writer is the gate.
 */
export async function listFlowSubagentOptions(ctx: RequestContext, agentId: string): Promise<FlowSubagentOption[]> {
    await assertMayManageProfiles(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rows = await db.agentProfile.findMany({
            where: { tenantId: ctx.tenantId, currentApprovedVersion: { not: null }, agentId: { not: agentId } },
            select: {
                id: true,
                currentApprovedVersion: true,
                agent: { select: { name: true, status: true, deletedAt: true } },
                versions: { where: { status: 'APPROVED' }, select: { version: true }, take: 1 },
            },
            orderBy: { createdAt: 'asc' },
            take: 200,
        });
        return rows
            .filter((p) => p.agent.status !== 'RETIRED' && p.agent.deletedAt === null)
            .filter((p) => p.versions.length === 1 && p.versions[0].version === p.currentApprovedVersion)
            .map((p) => ({ profileId: p.id, agentName: p.agent.name, version: p.currentApprovedVersion as number }));
    });
}
