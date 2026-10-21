/**
 * A2A PROTOCOL VERSION NEGOTIATION, and the v1.0 vocabulary (#3866).
 *
 * v1.0 changed the wire without changing the work: `SendMessage` / `GetTask`
 * instead of `message/send` / `tasks/get`, `TASK_STATE_*` instead of kebab-case
 * states, and a restructured agent card. This module is the whole of that
 * difference, so the handlers underneath it never learn there are two versions.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AN ABSENT HEADER MEANS 0.3, AND THE SPEC SAYS SO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `specification.md:712` at tag v1.0.1:
 *
 *   "Clients MUST send the `A2A-Version` header with each request to maintain
 *    compatibility after an agent upgrades to a new version of the protocol
 *    (except for 0.3 Clients - 0.3 will be assumed for empty header)."
 *
 * So defaulting to 0.3 is not our leniency, it is the rule — which matters,
 * because it is what leaves every existing caller untouched. The header's own
 * example value in the spec's service-parameter table is `0.3`, so a v0.3
 * client MAY send it too; both the absent and the explicit form resolve the
 * same way.
 *
 * An unsupported version returns `VersionNotSupportedError`, the spec's own
 * error for exactly this (`specification.md`, §3.3.2).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RECEIPT VOCABULARY IS DELIBERATELY NOT TOUCHED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `A2aMethod` in `receipt.ts` is the method name a PEER signs into its receipt
 * statement and verifies on the way back. Adding `SendMessage` to that set
 * would change a signed contract every pinned peer already agreed, to serve
 * callers that do not sign receipts at all — a host consumer has no key (R25).
 *
 * So v1.0 method names are NORMALISED here, at the edge, into the v0.3 names
 * the parser and handlers already use. One translation, in one place, and
 * everything downstream is version-blind.
 */

/** The header, lower-cased as Node delivers it. */
export const A2A_VERSION_HEADER = 'a2a-version';

export type A2aProtocolVersion = '0.3' | '1.0';

/** What we serve. Ordered oldest first, which is the order the card lists them. */
export const A2A_SUPPORTED_VERSIONS: readonly A2aProtocolVersion[] = ['0.3', '1.0'];

export type VersionResolution =
    | { readonly ok: true; readonly version: A2aProtocolVersion }
    | { readonly ok: false; readonly error: 'VersionNotSupportedError'; readonly requested: string };

/**
 * Which version this request speaks.
 *
 * Accepts `0.3`, `0.3.0`, `1.0` and `1.0.1` — the spec's example value is the
 * two-part `0.3` while the card's `protocolVersion` has carried the three-part
 * `0.3.0` since #3742, and a caller echoing what it read in the card must not
 * be refused for it.
 */
export function resolveA2aVersion(headerValue: string | null | undefined): VersionResolution {
    const raw = headerValue?.trim();
    // THE DEFAULT, and the reason every existing caller is unaffected.
    if (!raw) return { ok: true, version: '0.3' };

    const major = /^(\d+)\.(\d+)/.exec(raw);
    if (major) {
        const short = `${major[1]}.${major[2]}`;
        if (short === '0.3') return { ok: true, version: '0.3' };
        if (short === '1.0') return { ok: true, version: '1.0' };
    }
    return { ok: false, error: 'VersionNotSupportedError', requested: raw };
}

/**
 * v1.0 method names that map onto work we already do.
 *
 * The values are the v0.3 names, because those are what `parseA2aInboundRequest`
 * and the handlers understand.
 */
export const V1_METHOD_ALIASES: Readonly<Record<string, string>> = {
    SendMessage: 'message/send',
    GetTask: 'tasks/get',
};

/**
 * v1.0 operations this agent does not implement, each refused with the spec's
 * own error rather than a generic one.
 *
 * ── WHY ListTasks AND CancelTask ARE REFUSED, not implemented ───────────────
 *
 * Both would grant an outside caller authority it has never had, and #3866 is
 * a WIRE BINDING. Adding authority inside one is how a binding becomes a
 * feature nobody reviewed.
 *
 *   ListTasks   is an enumeration of the tasks a caller started — and
 *               therefore a disclosure surface over another organisation's
 *               activity in this workspace, with pagination. What a caller may
 *               see of its own history is the same class of question #3862
 *               answered for the card, and it deserves its own decision rather
 *               than arriving as a side effect.
 *
 *   CancelTask  lets an outside caller ABORT a run. Aborting is an authority a
 *               person inside the workspace holds (`abortWorkflowRun`, which
 *               stamps the Art 14 outcome), and a run may already have queued
 *               proposals a person is reviewing. Handing that to a remote
 *               caller is a decision about who may stop work, not a mapping.
 *
 * `UnsupportedOperationError` is the spec's wording for "not supported by this
 * server agent implementation" (`specification.md` §3.3.2), so a conformant
 * client learns the right thing and can fall back.
 *
 * The streaming and push-notification operations are refused for a reason that
 * already exists rather than a new one: the card declares
 * `capabilities.streaming: false` and `pushNotifications: false`, and the spec
 * REQUIRES `UnsupportedOperationError` and `PushNotificationNotSupportedError`
 * respectively when a client uses a capability the card does not declare
 * (§3.3.4).
 */
export const V1_REFUSED_METHODS: Readonly<Record<string, string>> = {
    ListTasks: 'UnsupportedOperationError',
    CancelTask: 'UnsupportedOperationError',
    SendStreamingMessage: 'UnsupportedOperationError',
    SubscribeToTask: 'UnsupportedOperationError',
    GetExtendedAgentCard: 'UnsupportedOperationError',
    CreateTaskPushNotificationConfig: 'PushNotificationNotSupportedError',
    GetTaskPushNotificationConfig: 'PushNotificationNotSupportedError',
    ListTaskPushNotificationConfigs: 'PushNotificationNotSupportedError',
    DeleteTaskPushNotificationConfig: 'PushNotificationNotSupportedError',
};

export type V1MethodResolution =
    /** Rewrite the method to this v0.3 name and carry on. */
    | { readonly kind: 'ALIASED'; readonly v03Method: string }
    /** A v1.0 operation we do not serve; refuse with this spec error. */
    | { readonly kind: 'REFUSED'; readonly error: string }
    /** Not a v1.0 method name at all — the v0.3 names are still accepted. */
    | { readonly kind: 'NOT_V1' };

/** Translate a v1.0 method name, or say it is not one. */
export function resolveV1Method(method: string): V1MethodResolution {
    const aliased = V1_METHOD_ALIASES[method];
    if (aliased) return { kind: 'ALIASED', v03Method: aliased };
    const refused = V1_REFUSED_METHODS[method];
    if (refused) return { kind: 'REFUSED', error: refused };
    return { kind: 'NOT_V1' };
}

/**
 * The v1.0 spelling of a v0.3 task state.
 *
 * A pure RELABEL, deliberately: every state means the same thing in both
 * vocabularies, so a v0.3 caller and a v1.0 caller asking after the same task
 * learn the same fact. Deciding a run's state remains
 * `taskStateForRunStatus`'s job and is not duplicated here — a second mapping
 * from run status straight to `TASK_STATE_*` could disagree with the first, and
 * the disagreement would be invisible to a caller using only one version.
 *
 * Every value is in `TaskState` of the vendored proto, which the conformance
 * test checks against those bytes rather than against this list.
 */
const V1_TASK_STATES = {
    submitted: 'TASK_STATE_SUBMITTED',
    working: 'TASK_STATE_WORKING',
    'input-required': 'TASK_STATE_INPUT_REQUIRED',
    completed: 'TASK_STATE_COMPLETED',
    canceled: 'TASK_STATE_CANCELED',
    failed: 'TASK_STATE_FAILED',
    rejected: 'TASK_STATE_REJECTED',
} as const;

export type V1TaskState = (typeof V1_TASK_STATES)[keyof typeof V1_TASK_STATES];

export function v1TaskState(state: keyof typeof V1_TASK_STATES): V1TaskState {
    return V1_TASK_STATES[state];
}

/** Every v0.3 state this module can relabel, for a completeness test. */
export const V1_RELABELLED_STATES = Object.keys(V1_TASK_STATES) as ReadonlyArray<keyof typeof V1_TASK_STATES>;
