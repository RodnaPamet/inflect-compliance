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

/*
 * Whether the profile surface is on for a workspace is no longer read here.
 * Since #4557 an organization can decide it when the deployment leaves
 * `AGENT_PROFILES` unset, so the answer needs a database read:
 * `agentProfilesDecisionFor` in `agent-switches-policy.ts`, over the pure rule
 * in `agent-switches.ts`. A synchronous reader of the environment alone would
 * report a switch an organization turned on as off.
 */
