/**
 * What the "Agent engines" section says and offers, decided here rather than in JSX.
 *
 * ═══ THE SECTION MUST NOT REPORT A CAPABILITY THE RUNTIME REFUSES ═══
 *
 * The server owns the conjunction. `GET /admin/agent-driver` returns the
 * engine a run would actually use and the reason, both computed by the
 * function the run path calls. Nothing here re-derives the AND. This module
 * only turns that answer into words, and decides which control a viewer gets.
 *
 * ═══ ONE SENTENCE PER REASON, TOTAL AT COMPILE TIME ═══
 *
 * `REASON_MESSAGE` is checked with `satisfies Record<StaticDriverReason, …>`.
 * A reason added to the union without a sentence therefore fails `tsc`, and
 * the rendered test iterates the record to check that each sentence exists in
 * both catalogues and differs from the others.
 *
 * ═══ TWO REASONING ENGINES, EACH WITH ITS OWN WORDS (Step 2c) ═══
 *
 * Flue and the Tool Runner each have their own operator switch and build flag,
 * so a reason such as "not turned on for this deployment" is a sentence about
 * one engine. `engineOf` picks the engine the workspace chose, and the reason,
 * the checklist and the stored-choice note name that engine. A workspace on the
 * built-in engine reads Flue's, as it did before the Tool Runner existed.
 *
 * @module admin/ai-features/agent-engine-display
 */
import {
    AGENT_DRIVER_MODES,
    type AgentDriverMode,
    type StaticDriverReason,
    type StoredDriverMode,
} from '@/lib/agentic/agent-driver';
import { switchActor, type AgentSwitchBasis } from '@/lib/agentic/agent-switches';

/** The response of `GET /api/t/{slug}/admin/agent-driver`. */
export interface AgentDriverSettingPayload {
    /** Any stored value, a READ_ONLY one included; only AGENT_DRIVER_MODES can be chosen. */
    mode: StoredDriverMode;
    effective: { driver: string; reason: string | null };
    /** Flue's operator switch and build flag. */
    envEnabled: boolean;
    implemented: boolean;
    /**
     * The Tool Runner's own switch and build flag (Step 2c). `envEnabled` is
     * "available to this workspace"; `basis` says whether the deployment or the
     * organization decided it (#4557). Absent from a server that predates it.
     */
    toolRunner: { envEnabled: boolean; implemented: boolean; basis?: AgentSwitchBasis };
}

/** A reasoning engine a workspace can choose. */
export type ReasoningEngineMode = 'FLUE' | 'TOOL_RUNNER';

/**
 * The engine the reason sentences and the checklist talk about: the Tool Runner
 * for a workspace that chose it, Flue otherwise.
 */
export function engineOf(setting: Pick<AgentDriverSettingPayload, 'mode'>): ReasoningEngineMode {
    return setting.mode === 'TOOL_RUNNER' ? 'TOOL_RUNNER' : 'FLUE';
}

/** Is this engine's operator switch on? */
function engineEnvEnabled(setting: AgentDriverSettingPayload, engine: ReasoningEngineMode): boolean {
    return engine === 'TOOL_RUNNER' ? setting.toolRunner.envEnabled : setting.envEnabled;
}

/** The checklist of `GET /api/t/{slug}/admin/flue-wiring` (OWNER-only), for the chosen engine. */
export type EngineTermKey =
    | 'ENV'
    | 'TENANT'
    | 'BUILD'
    | 'WORKFLOW'
    | 'REGISTERED_AGENT'
    | 'BOUND_KEY'
    | 'PROFILES'
    | 'MODEL_KEY';

export interface EngineTerm {
    key: EngineTermKey;
    satisfied: boolean;
    actor: 'operator' | 'organization' | 'tenant';
    count?: number;
}

export interface FlueWiringPayload {
    /** Which engine's checklist the terms are. */
    engine: ReasoningEngineMode;
    terms: EngineTerm[];
    ready: boolean;
    blockedOn: EngineTermKey | null;
}

/**
 * The sentence for each reason a run is on the built-in engine, as a key under
 * `admin.agentEngines`.
 */
export const REASON_MESSAGE = {
    ENV_DISABLED: 'reason.ENV_DISABLED',
    TENANT_NOT_OPTED_IN: 'reason.TENANT_NOT_OPTED_IN',
    UNRECOGNISED_SETTING: 'reason.UNRECOGNISED_SETTING',
    DRIVER_NOT_IMPLEMENTED: 'reason.DRIVER_NOT_IMPLEMENTED',
    NO_WORKFLOW_REQUESTS_IT: 'reason.NO_WORKFLOW_REQUESTS_IT',
} as const satisfies Record<StaticDriverReason, string>;

/**
 * The same sentences for a workspace that chose the Tool Runner engine. Three
 * reasons are about the engine itself and name it. The other two arise only for
 * a stored value other than this engine's, so they share Flue's sentences.
 */
export const TOOL_RUNNER_REASON_MESSAGE = {
    ENV_DISABLED: 'reasonToolRunner.ENV_DISABLED',
    TENANT_NOT_OPTED_IN: 'reason.TENANT_NOT_OPTED_IN',
    UNRECOGNISED_SETTING: 'reason.UNRECOGNISED_SETTING',
    DRIVER_NOT_IMPLEMENTED: 'reasonToolRunner.DRIVER_NOT_IMPLEMENTED',
    NO_WORKFLOW_REQUESTS_IT: 'reasonToolRunner.NO_WORKFLOW_REQUESTS_IT',
} as const satisfies Record<StaticDriverReason, string>;

function isStaticDriverReason(value: string): value is StaticDriverReason {
    return Object.prototype.hasOwnProperty.call(REASON_MESSAGE, value);
}

/** The badge: the engine a run would use today, as a key under `admin.agentEngines`. */
export function effectiveEngineNameFor(setting: AgentDriverSettingPayload): string {
    if (setting.effective.driver === 'flue') return 'engine.FLUE.name';
    if (setting.effective.driver === 'tool-runner') return 'engine.TOOL_RUNNER.name';
    return 'engine.STATIC.name';
}

/**
 * The headline: which engine runs today, and why, as a message key.
 *
 * A reason this build does not know reads as the generic sentence rather than
 * a raw code. The client and the server ship together, so that only happens
 * mid-deploy, and a code shown to a reader explains nothing.
 *
 * The engine being chosen is not the same as a run being able to start. A
 * Flue run also needs an active registered agent and a key bound to it, and
 * without them every start is refused rather than moved to the built-in
 * engine. An owner holds the checklist that knows this, so when it says the
 * workspace is not ready the headline says so too. Somebody without the
 * checklist gets the sentence that names the condition instead.
 */
export function headlineFor(setting: AgentDriverSettingPayload, wiring?: FlueWiringPayload): string {
    const { reason, driver } = setting.effective;
    if (reason === null) {
        if (driver === 'flue') return wiring && !wiring.ready ? 'runsOnFlueNotReady' : 'runsOnFlue';
        if (driver === 'tool-runner') {
            return wiring && !wiring.ready ? 'runsOnToolRunnerNotReady' : 'runsOnToolRunner';
        }
        return 'reason.UNKNOWN';
    }
    if (!isStaticDriverReason(reason)) return 'reason.UNKNOWN';
    if (engineOf(setting) !== 'TOOL_RUNNER') return REASON_MESSAGE[reason];
    // The organization holds the switch (#4557): name it, not the operator,
    // who cannot help a workspace whose organization left the engine off.
    if (reason === 'ENV_DISABLED' && setting.toolRunner.basis === 'ORGANIZATION_OFF') {
        return 'reasonToolRunner.ORGANIZATION_OFF';
    }
    return TOOL_RUNNER_REASON_MESSAGE[reason];
}

export type HeadlineTone = 'success' | 'warning' | 'info';

/**
 * Success only when the engine is on AND nothing known stops a run. A green
 * headline over a checklist that blocks every run is the section reporting a
 * capability the runtime refuses.
 */
export function headlineToneFor(setting: AgentDriverSettingPayload, wiring?: FlueWiringPayload): HeadlineTone {
    const driver = setting.effective.driver;
    if (driver !== 'flue' && driver !== 'tool-runner') return 'info';
    return wiring && !wiring.ready ? 'warning' : 'success';
}

/**
 * Which control a viewer gets.
 *
 * - `read-only`: the viewer cannot change the engine (no
 *   `admin.tenant_lifecycle`). They still see everything, plus one sentence
 *   naming who can change it. Hiding the section would make a gate nobody can
 *   read look the same as one that is not there.
 * - `deployment-off`: an owner, on a deployment where neither reasoning engine's
 *   switch is on. Choosing one is disabled: the API would accept the write,
 *   but it changes no run until the operator turns the switch on, and a
 *   control whose success changes nothing is the trap this page exists to
 *   avoid (#3909). Returning to the built-in engine stays available
 *   (`choiceEnabled`).
 * - `editable`: an owner, on a deployment that allows at least one reasoning
 *   engine. Each engine is still offered only while its own switch is on.
 *
 * Read-only is decided first. An admin on a switched-off deployment has
 * nothing to press either way, and the reason sentence already says the
 * deployment is off.
 */
export type EngineControl = 'read-only' | 'deployment-off' | 'editable';

export function engineControlFor(setting: AgentDriverSettingPayload, canChange: boolean): EngineControl {
    if (!canChange) return 'read-only';
    if (!setting.envEnabled && !setting.toolRunner.envEnabled) return 'deployment-off';
    return 'editable';
}

/**
 * The checklist a viewer sees.
 *
 * An owner gets the six terms from `flue-wiring`. Anyone else gets the three
 * the driver GET reports, which are the three terms that response can answer
 * by itself: the deployment switch, the workspace's choice and the build.
 * The keys match the six-term list, so one renderer and one set of sentences
 * serve both.
 */
export function gateTermsFor(setting: AgentDriverSettingPayload): EngineTerm[] {
    if (engineOf(setting) === 'TOOL_RUNNER') {
        return [
            {
                key: 'ENV',
                satisfied: setting.toolRunner.envEnabled,
                actor: setting.toolRunner.basis ? switchActor(setting.toolRunner.basis) : 'operator',
            },
            { key: 'TENANT', satisfied: true, actor: 'tenant' },
            { key: 'BUILD', satisfied: setting.toolRunner.implemented, actor: 'operator' },
        ];
    }
    return [
        { key: 'ENV', satisfied: setting.envEnabled, actor: 'operator' },
        { key: 'TENANT', satisfied: setting.mode === 'FLUE', actor: 'tenant' },
        { key: 'BUILD', satisfied: setting.implemented, actor: 'operator' },
    ];
}

/** The engines the API accepts today, in the order they are offered. */
export const OFFERED_ENGINES: readonly AgentDriverMode[] = AGENT_DRIVER_MODES;

/**
 * Whether one engine can be chosen under a control.
 *
 * The built-in engine is ALWAYS reachable for somebody who can change the
 * engine, the deployment switch included. A stored Flue choice is not inert
 * while the switch is off: it takes effect, with nobody acting, the moment the
 * operator turns the switch back on. So narrowing is the one move that must
 * never wait on another key, which is what `setAgentDriverSetting` says of it
 * too ("the narrow is the one that has to be instant").
 *
 * Each reasoning engine is offered only while its OWN switch is on: with Flue
 * on and the Tool Runner off, choosing the Tool Runner would be the same trap
 * `deployment-off` exists for, one engine over.
 */
export function choiceEnabled(
    control: EngineControl,
    option: AgentDriverMode,
    setting: AgentDriverSettingPayload,
): boolean {
    if (control === 'read-only') return false;
    if (option === 'STATIC') return true;
    if (control === 'deployment-off') return false;
    return engineEnvEnabled(setting, option);
}
