/**
 * AGENT PROFILES — the vocabulary, the run key and which engines run one
 * (Step 1a of `docs/claude-agent-sdk-design.md`, #4143).
 *
 * A profile is what a registered agent should DO, as its tenant wrote it: the
 * instructions, the tools it uses (a subset of its grants), the skills it
 * mounts, a model tier, an effort, a turn bound, what it may produce and what
 * may start it. A version runs only once a person other than its author has
 * approved it, and a run pins the version and the hash of its instructions.
 *
 * Pure: no Prisma, no server import and no Node built-in, so a client
 * component can hold the vocabularies the builder offers (Step 1b). The
 * instructions hash is computed on the server, in the writer. The writer is
 * `src/app-layer/usecases/agent-profiles.ts`; the resolver that turns an
 * approved version into a run definition is
 * `src/app-layer/usecases/agent-profile-runs.ts`.
 */
import { MCP_PROPOSE_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';

import type { AgentDriver } from './agent-driver';
import { ENGINE_CAPS } from './workflow-types';

/**
 * The model tiers a profile may name. A tier, never a model id: which model a
 * tier means is the deployment's decision, made by the engine's residency
 * resolver, so a tenant cannot name a model the deployment does not offer.
 * Pinned by the CHECK `AgentProfileVersion_model_tier_allowed`.
 */
export const PROFILE_MODEL_TIERS = ['balanced', 'deep'] as const;
export type ProfileModelTier = (typeof PROFILE_MODEL_TIERS)[number];

/** Pinned by the CHECK `AgentProfileVersion_effort_allowed`. */
export const PROFILE_EFFORTS = ['low', 'medium', 'high'] as const;
export type ProfileEffort = (typeof PROFILE_EFFORTS)[number];

/**
 * What may start a run of the profile: the Ask page, an automation rule's
 * `INVOKE_AGENT`, or the builder's Test run. Pinned by the CHECK
 * `AgentProfileVersion_triggers_allowed`. Each trigger site checks its own
 * value against the version it starts (Step 1b and Phase 2).
 */
export const PROFILE_TRIGGERS = ['ASK', 'AUTOMATION', 'TEST_RUN'] as const;
export type ProfileTrigger = (typeof PROFILE_TRIGGERS)[number];

export const PROFILE_OUTPUT_KINDS = ['ANSWER_ONLY', 'ANSWER_AND_PROPOSALS'] as const;
export type ProfileOutputKind = (typeof PROFILE_OUTPUT_KINDS)[number];

/**
 * The turn bound. A profile can only narrow the engine's step ceiling, never
 * raise it. Pinned by the CHECK `AgentProfileVersion_max_turns_bounded`.
 */
export const PROFILE_MAX_TURNS: number = ENGINE_CAPS.MAX_STEPS;

/** The instructions' size cap, after sanitising. */
export const PROFILE_INSTRUCTIONS_MAX_CHARS = 16_000;

/** A rejection reason's size cap, after sanitising. */
export const PROFILE_REJECTION_REASON_MAX_CHARS = 1_000;

/** At most this many tools and skills, as the CHECKs hold. */
export const PROFILE_MAX_TOOLS = 128;
export const PROFILE_MAX_SKILLS = 32;

/** A skill the profile mounts: one the product ships, or one of the tenant's own. */
export interface ProfileSkillRef {
    readonly origin: 'repository' | 'tenant';
    readonly name: string;
}

/**
 * A skill the Behaviour tab's picker offers (#4590): the ref, and what its one
 * catalogue line costs on every turn (`catalogBytes` of that skill alone).
 * Lines add, so the editor's running total of the chosen options is exactly
 * what the save prices against `limits.skillCatalogueBudgetBytes`. Never sent
 * back: the save takes `ProfileSkillRef` only.
 */
export interface ProfileSkillOption extends ProfileSkillRef {
    readonly catalogueBytes: number;
}

// ─── The run key ────────────────────────────────────────────────────

/**
 * The workflow key a profile run is started under. The prefix cannot collide
 * with a registered workflow key, which never contains a colon.
 *
 * A TEST RUN carries the suffix `:test-run` (Step 2c). The key is the one thing
 * about a run that every later reader sees, the worker that executes it
 * included, so it is where the run says it is a Test run: the worker rebuilds
 * the definition read-only from it, and the Runs tab can tell one apart.
 * Admission accepts the suffix only from the Test-run usecase.
 */
export const PROFILE_RUN_KEY_PREFIX = 'agent-profile:';

/** The suffix that marks a profile run as a Test run. */
export const PROFILE_TEST_RUN_SUFFIX = ':test-run';

const RUN_KEY = /^agent-profile:([a-z0-9]{1,64})@v([1-9][0-9]{0,8})(:test-run)?$/;

export function profileRunKey(profileId: string, version: number, opts: { testRun?: boolean } = {}): string {
    return `${PROFILE_RUN_KEY_PREFIX}${profileId}@v${version}${opts.testRun ? PROFILE_TEST_RUN_SUFFIX : ''}`;
}

/** Does this key ask for a profile, well-formed or not? */
export function isProfileRunKey(key: string): boolean {
    return key.startsWith(PROFILE_RUN_KEY_PREFIX);
}

/**
 * The profile id and version a key names, or null for a key that asks for a
 * profile but is not well formed. A malformed key is REFUSED by the resolver,
 * never treated as a registered workflow key.
 */
export function parseProfileRunKey(
    key: string,
): { profileId: string; version: number; testRun: boolean } | null {
    const m = RUN_KEY.exec(key);
    if (!m) return null;
    return { profileId: m[1], version: Number(m[2]), testRun: m[3] === PROFILE_TEST_RUN_SUFFIX };
}

/**
 * The `agents` message key, and its values, naming a profile run for a person
 * (#5374): "Behaviour v3" or "Behaviour v3 — Test run". Null for a key that is
 * not a well-formed profile run key, which the caller names as it always did.
 *
 * The run lists and the run page name a run by its workflow definition, and a
 * profile key has none, so they used to print the raw key.
 */
export function profileRunLabel(
    workflowKey: string,
): { key: 'runs.profileRun.run' | 'runs.profileRun.testRun'; values: { version: number } } | null {
    const parsed = parseProfileRunKey(workflowKey);
    if (!parsed) return null;
    return { key: parsed.testRun ? 'runs.profileRun.testRun' : 'runs.profileRun.run', values: { version: parsed.version } };
}

// ─── What a Test run can reach ──────────────────────────────────────

/**
 * Does a version name NO tool a read-only run is offered (#5374)?
 *
 * A Test run is read-only: it withholds the propose surface. A version whose
 * tools are all propose tools therefore offers it nothing, and the run would
 * settle `EMPTY_CATALOGUE` having sent nothing. The Test-run start refuses it
 * up front (`TEST_RUN_NO_READ_TOOL`), and the Behaviour tab disables the
 * button with the same reason. Every tool not on the propose catalogue is a
 * read tool, an external tool included, so this asks the propose list only.
 */
export function profileNamesNoReadTool(toolNames: readonly string[]): boolean {
    const propose: readonly string[] = MCP_PROPOSE_TOOL_NAMES;
    return !toolNames.some((name) => !propose.includes(name));
}

// ─── Which engines run a profile ────────────────────────────────────

/**
 * DOES THIS ENGINE RUN AN AGENT PROFILE — render its pinned instructions as the
 * operator's own fenced block, offer only its tools and mount its skills?
 *
 * TRUE FOR THE TOOL RUNNER ONLY (Step 2c). Flue stays false by decision, not
 * gap (owner, 2026-10-26): it builds its prompt from a workflow's description
 * and steps, so it would run a profile while ignoring the instructions.
 * Admission refuses a profile on an engine that cannot run one, before the run
 * row exists. Sending profile instructions to a model is a data category on
 * the Anthropic sub-processor row, recorded with this entry.
 *
 * A `Record<AgentDriver, boolean>`, as `REASONING_ENGINE` is, so a driver added
 * to `AGENT_DRIVERS` without a classification here is a compile error.
 */
const RUNS_PROFILES: Readonly<Record<AgentDriver, boolean>> = {
    static: false,
    flue: false,
    // TRUE since Step 2c (#4150): the driver renders the pinned instructions as
    // the operator's fenced block and offers only `profileTools`, and the
    // Anthropic row of `docs/sub-processors.md` names "tenant-authored agent
    // instructions" in the same diff.
    'tool-runner': true,
};

export function runsProfiles(driver: AgentDriver): boolean {
    return RUNS_PROFILES[driver];
}

/**
 * DOES THIS ENGINE PERFORM A PROFILE VERSION'S DRAWN FLOW — every step of it,
 * including a `subagent` step, which hands work to another profile?
 *
 * FALSE FOR EVERY ENGINE until Phase 5 of `docs/ai-architecture/langflow.md`.
 * No engine has a delegation tool, so a `subagent` step would reach the model
 * as a line it cannot act on, and the run would settle COMPLETED with the
 * delegation recorded as drawn and never performed: a step that looks enforced
 * and is not, the rule `agent-flow.ts` refuses a checkpoint by. So admission
 * refuses a flow version (`PROFILE_FLOW_NOT_RUNNABLE`) on every engine, before
 * the run row exists, and a version with a flow is created, approved and
 * resolved but never run. Turning an entry on is Phase 5's diff, beside the
 * engine support that makes every node kind real.
 *
 * A `Record<AgentDriver, boolean>`, as `RUNS_PROFILES` is, so a new driver is
 * a compile error until it is classified here.
 */
const RUNS_FLOWS: Readonly<Record<AgentDriver, boolean>> = {
    static: false,
    flue: false,
    'tool-runner': false,
};

export function runsFlows(driver: AgentDriver): boolean {
    return RUNS_FLOWS[driver];
}

/*
 * Whether the profile surface is on for a workspace is no longer read here.
 * Since #4557 an organization can decide it when the deployment leaves
 * `AGENT_PROFILES` unset, so the answer needs a database read:
 * `agentProfilesDecisionFor` in `agent-switches-policy.ts`, over the pure rule
 * in `agent-switches.ts`. A synchronous reader of the environment alone would
 * report a switch an organization turned on as off.
 */

// ─── Inline sub-agents (Step 2e, #4594) ─────────────────────────────

/**
 * At most this many sub-agents per version (Step 2e of
 * `docs/claude-tool-runner-design.md`, "Delegation → 1. The model").
 */
export const PROFILE_MAX_SUBAGENTS = 4;

/**
 * A sub-agent's name: snake case like a tool name, so it sits in a guard
 * source (`tool-runner-subagent.<name>-tool-args:…`), a ledger column and an
 * audit row as an identifier. The pattern admits no `-`, `:` or `.`, so in a
 * guard source the name ends exactly at the first `-tool-`. The CHECK
 * `WorkflowStep_subagent_name_shape` holds the same pattern.
 */
export const SUBAGENT_NAME_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

/**
 * One inline sub-agent of a profile version. It has NO description (owner
 * decision 2, 2026-11-13): the parent chooses by name alone, so nothing of a
 * child's text reaches the parent's context.
 *
 * Its tools and skills are SUBSETS of the version's, and its turn limit is at
 * most the version's: a sub-agent can do less than its parent, never more.
 */
export interface ProfileSubagent {
    readonly name: string;
    /** Sanitised and scanned at the write seam, as the version's are. */
    readonly instructions: string;
    /** Non-empty, deduplicated, sorted; every name one of the version's `toolNames`. */
    readonly toolNames: readonly string[];
    /** Deduplicated, sorted; every ref one of the version's `skillRefs`. */
    readonly skillRefs: readonly ProfileSkillRef[];
    /** 1 to the version's own `maxTurns`. */
    readonly maxTurns: number;
}

/** Why a version's sub-agents are refused. Each is a 400, named, never a silent drop. */
export type ProfileSubagentRefusal =
    | 'SUBAGENTS_TOO_MANY'
    | 'SUBAGENTS_WITH_FLOW'
    | 'SUBAGENT_NAME_INVALID'
    | 'SUBAGENT_NAME_DUPLICATE'
    | 'SUBAGENT_INSTRUCTIONS_EMPTY'
    | 'SUBAGENT_INSTRUCTIONS_TOO_LONG'
    | 'SUBAGENT_INSTRUCTIONS_REFUSED'
    | 'SUBAGENT_NAMES_NO_TOOL'
    | 'SUBAGENT_TOOL_NOT_IN_VERSION'
    | 'SUBAGENT_SKILL_NOT_IN_VERSION'
    | 'SUBAGENT_MAX_TURNS_ABOVE_VERSION';

/** What a sub-agent's sets are checked against: the version's own. */
export interface SubagentParentSets {
    readonly toolNames: readonly string[];
    readonly skillRefs: readonly ProfileSkillRef[];
    readonly maxTurns: number;
}

export type SubagentCheck =
    | { readonly ok: true; readonly subagents: readonly ProfileSubagent[] }
    | {
          readonly ok: false;
          readonly reason: ProfileSubagentRefusal;
          readonly message: string;
          /** The sub-agent's name and the offending tools or skills, for `details`. */
          readonly details: Readonly<Record<string, unknown>>;
      };

const skillRefKey = (r: ProfileSkillRef): string => `${r.origin}:${r.name}`;

function compareSkillRefs(a: ProfileSkillRef, b: ProfileSkillRef): number {
    const ka = a.origin + a.name;
    const kb = b.origin + b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * CHECK A VERSION'S SUB-AGENTS against the version's own sets, and put them in
 * canonical form. Pure: the instructions are taken as the caller sanitised
 * them, and the text scan is the caller's (it is a server module).
 *
 * Every rule is a refusal BY NAME, the first one found, naming the sub-agent
 * and what it named that the version does not hold. The canonical form sorts
 * the list by name and each list inside a sub-agent, so the stored string,
 * and therefore the content hash, does not depend on the order the editor sent.
 */
export function checkProfileSubagents(
    raw: ReadonlyArray<{
        readonly name: string;
        readonly instructions: string;
        readonly toolNames: readonly string[];
        readonly skillRefs: readonly ProfileSkillRef[];
        readonly maxTurns: number;
    }>,
    version: SubagentParentSets,
    limits: { readonly instructionsMaxChars: number },
): SubagentCheck {
    const refuse = (reason: ProfileSubagentRefusal, message: string, details: Record<string, unknown>): SubagentCheck => ({
        ok: false,
        reason,
        message,
        details,
    });
    if (raw.length > PROFILE_MAX_SUBAGENTS) {
        return refuse(
            'SUBAGENTS_TOO_MANY',
            `A version has at most ${PROFILE_MAX_SUBAGENTS} sub-agents.`,
            { max: PROFILE_MAX_SUBAGENTS, count: raw.length },
        );
    }
    const versionTools = new Set(version.toolNames);
    const versionSkills = new Set(version.skillRefs.map(skillRefKey));
    const seen = new Set<string>();
    const out: ProfileSubagent[] = [];
    for (const s of raw) {
        const name = s.name.trim();
        if (!SUBAGENT_NAME_PATTERN.test(name)) {
            return refuse(
                'SUBAGENT_NAME_INVALID',
                'A sub-agent\'s name is 2 to 40 lowercase letters, digits and underscores, starting with a letter.',
                { subagent: name },
            );
        }
        if (seen.has(name)) {
            return refuse('SUBAGENT_NAME_DUPLICATE', `Two sub-agents are called ${name}.`, { subagent: name });
        }
        seen.add(name);
        const instructions = s.instructions.trim();
        if (instructions === '') {
            return refuse('SUBAGENT_INSTRUCTIONS_EMPTY', `Sub-agent ${name} has no instructions.`, { subagent: name });
        }
        if (instructions.length > limits.instructionsMaxChars) {
            return refuse(
                'SUBAGENT_INSTRUCTIONS_TOO_LONG',
                `Sub-agent ${name}'s instructions are at most ${limits.instructionsMaxChars} characters.`,
                { subagent: name, maxChars: limits.instructionsMaxChars },
            );
        }
        const toolNames = [...new Set(s.toolNames.map((t) => t.trim()))].sort();
        if (toolNames.length === 0) {
            return refuse('SUBAGENT_NAMES_NO_TOOL', `Sub-agent ${name} names no tool.`, { subagent: name });
        }
        const outsideTools = toolNames.filter((t) => !versionTools.has(t));
        if (outsideTools.length > 0) {
            return refuse(
                'SUBAGENT_TOOL_NOT_IN_VERSION',
                `Sub-agent ${name} names ${outsideTools.join(', ')}, which this version does not. A sub-agent uses a ` +
                    'subset of its version\'s tools.',
                { subagent: name, tools: outsideTools },
            );
        }
        const skillRefs = [
            ...new Map(s.skillRefs.map((r) => ({ origin: r.origin, name: r.name.trim() })).map((r) => [skillRefKey(r), r])).values(),
        ].sort(compareSkillRefs);
        const outsideSkills = skillRefs.filter((r) => !versionSkills.has(skillRefKey(r))).map(skillRefKey);
        if (outsideSkills.length > 0) {
            return refuse(
                'SUBAGENT_SKILL_NOT_IN_VERSION',
                `Sub-agent ${name} names ${outsideSkills.join(', ')}, which this version does not mount. A sub-agent ` +
                    'uses a subset of its version\'s skills.',
                { subagent: name, skills: outsideSkills },
            );
        }
        if (!Number.isInteger(s.maxTurns) || s.maxTurns < 1 || s.maxTurns > version.maxTurns) {
            return refuse(
                'SUBAGENT_MAX_TURNS_ABOVE_VERSION',
                `Sub-agent ${name}'s turn limit is 1 to the version's own (${version.maxTurns}).`,
                { subagent: name, maxTurns: s.maxTurns, versionMaxTurns: version.maxTurns },
            );
        }
        out.push({ name, instructions, toolNames, skillRefs, maxTurns: s.maxTurns });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { ok: true, subagents: out };
}

/**
 * The canonical stored form: JSON of the list sorted by name, each object's
 * keys in a fixed order. NULL for an empty list, never `[]`, so a version with
 * no sub-agents takes the content hash it has always taken.
 */
export function serializeProfileSubagents(subagents: readonly ProfileSubagent[]): string | null {
    if (subagents.length === 0) return null;
    const sorted = [...subagents].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return JSON.stringify(
        sorted.map((s) => ({
            name: s.name,
            instructions: s.instructions,
            toolNames: [...s.toolNames],
            skillRefs: s.skillRefs.map((r) => ({ origin: r.origin, name: r.name })),
            maxTurns: s.maxTurns,
        })),
    );
}

/**
 * A stored list, read back STRICTLY: one this build cannot parse, one that is
 * not canonical, or one whose sets are no longer subsets of the version's own,
 * is `null`, and the resolver compiles it to nothing. A version with
 * sub-agents is never run as though it had none.
 */
export function parseStoredProfileSubagents(json: string, version: SubagentParentSets): readonly ProfileSubagent[] | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const raw: Array<Parameters<typeof checkProfileSubagents>[0][number]> = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        const keys = Object.keys(item).sort().join(',');
        if (keys !== 'instructions,maxTurns,name,skillRefs,toolNames') return null;
        const { name, instructions, toolNames, skillRefs, maxTurns } = item as Record<string, unknown>;
        if (typeof name !== 'string' || typeof instructions !== 'string' || typeof maxTurns !== 'number') return null;
        if (!Array.isArray(toolNames) || !toolNames.every((t) => typeof t === 'string')) return null;
        if (!Array.isArray(skillRefs)) return null;
        const refs: ProfileSkillRef[] = [];
        for (const r of skillRefs) {
            const { origin, name: refName } = (r ?? {}) as { origin?: unknown; name?: unknown };
            if ((origin !== 'repository' && origin !== 'tenant') || typeof refName !== 'string') return null;
            refs.push({ origin, name: refName });
        }
        raw.push({ name, instructions, toolNames: toolNames as string[], skillRefs: refs, maxTurns });
    }
    const checked = checkProfileSubagents(raw, version, { instructionsMaxChars: PROFILE_INSTRUCTIONS_MAX_CHARS });
    if (!checked.ok) return null;
    // Canonical or nothing: a list this build would have stored differently
    // was not written by this writer.
    if (serializeProfileSubagents(checked.subagents) !== json) return null;
    return checked.subagents;
}

/**
 * The sub-agents as the approver reads them: every field, every word of the
 * instructions, in name order. Text, rendered in a `<pre>` and diffed against
 * the version in force, so the approver approves every word a run can send.
 */
export function describeSubagentsForReview(subagents: readonly ProfileSubagent[]): string {
    return [...subagents]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((s) =>
            [
                `Sub-agent: ${s.name}`,
                `Tools: ${s.toolNames.join(', ')}`,
                `Skills: ${s.skillRefs.length > 0 ? s.skillRefs.map(skillRefKey).join(', ') : '(none)'}`,
                `Turn limit: ${s.maxTurns}`,
                'Instructions:',
                s.instructions,
            ].join('\n'),
        )
        .join('\n\n');
}

/**
 * DOES THIS ENGINE RUN A VERSION'S INLINE SUB-AGENTS — offer the parent the
 * `delegate` tool and run each delegation as a nested loop under the parent's
 * caps and identity?
 *
 * Admission refuses a version with sub-agents on an engine whose entry is
 * false (`PROFILE_SUBAGENTS_NOT_RUNNABLE`), before the run row exists, so a
 * version with sub-agents is never run as though it had none. Flue's stays
 * false: Flue runs no profile.
 *
 * A `Record<AgentDriver, boolean>`, as `RUNS_PROFILES` is, so a new driver is
 * a compile error until it is classified here.
 */
const RUNS_SUBAGENTS: Readonly<Record<AgentDriver, boolean>> = {
    static: false,
    flue: false,
    'tool-runner': false,
};

export function runsSubagents(driver: AgentDriver): boolean {
    return RUNS_SUBAGENTS[driver];
}
