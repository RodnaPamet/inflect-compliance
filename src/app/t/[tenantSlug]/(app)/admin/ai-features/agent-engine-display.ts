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
 * @module admin/ai-features/agent-engine-display
 */
import {
    AGENT_DRIVER_MODES,
    type AgentDriverMode,
    type StaticDriverReason,
    type StoredDriverMode,
} from '@/lib/agentic/agent-driver';

/** The response of `GET /api/t/{slug}/admin/agent-driver`. */
export interface AgentDriverSettingPayload {
    /** Any stored value, a READ_ONLY one included; only AGENT_DRIVER_MODES can be chosen. */
    mode: StoredDriverMode;
    effective: { driver: string; reason: string | null };
    envEnabled: boolean;
    implemented: boolean;
}

/** The six-term checklist of `GET /api/t/{slug}/admin/flue-wiring` (OWNER-only). */
export type EngineTermKey = 'ENV' | 'TENANT' | 'BUILD' | 'WORKFLOW' | 'REGISTERED_AGENT' | 'BOUND_KEY';

export interface EngineTerm {
    key: EngineTermKey;
    satisfied: boolean;
    actor: 'operator' | 'tenant';
    count?: number;
}

export interface FlueWiringPayload {
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

function isStaticDriverReason(value: string): value is StaticDriverReason {
    return Object.prototype.hasOwnProperty.call(REASON_MESSAGE, value);
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
        if (driver !== 'flue') return 'reason.UNKNOWN';
        return wiring && !wiring.ready ? 'runsOnFlueNotReady' : 'runsOnFlue';
    }
    return isStaticDriverReason(reason) ? REASON_MESSAGE[reason] : 'reason.UNKNOWN';
}

export type HeadlineTone = 'success' | 'warning' | 'info';

/**
 * Success only when the engine is on AND nothing known stops a run. A green
 * headline over a checklist that blocks every run is the section reporting a
 * capability the runtime refuses.
 */
export function headlineToneFor(setting: AgentDriverSettingPayload, wiring?: FlueWiringPayload): HeadlineTone {
    if (setting.effective.driver !== 'flue') return 'info';
    return wiring && !wiring.ready ? 'warning' : 'success';
}

/**
 * Which control a viewer gets.
 *
 * - `read-only`: the viewer cannot change the engine (no
 *   `admin.tenant_lifecycle`). They still see everything, plus one sentence
 *   naming who can change it. Hiding the section would make a gate nobody can
 *   read look the same as one that is not there.
 * - `deployment-off`: an owner, on a deployment whose switch is off. Choosing
 *   Flue is disabled: the API would accept the write, but it changes no run
 *   until the operator turns the switch on, and a control whose success
 *   changes nothing is the trap this page exists to avoid (#3909). Returning
 *   to the built-in engine stays available (`choiceEnabled`).
 * - `editable`: an owner, on a deployment that allows the engine.
 *
 * Read-only is decided first. An admin on a switched-off deployment has
 * nothing to press either way, and the reason sentence already says the
 * deployment is off.
 */
export type EngineControl = 'read-only' | 'deployment-off' | 'editable';

export function engineControlFor(setting: AgentDriverSettingPayload, canChange: boolean): EngineControl {
    if (!canChange) return 'read-only';
    if (!setting.envEnabled) return 'deployment-off';
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
 */
export function choiceEnabled(control: EngineControl, option: AgentDriverMode): boolean {
    if (control === 'editable') return true;
    if (control === 'deployment-off') return option === 'STATIC';
    return false;
}
