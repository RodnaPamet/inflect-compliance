/**
 * Which of the FIVE reasons a sandbox-runtime row is not a live switch —
 * decided here, not in JSX (#3999).
 *
 * ═══ WHY THIS MIRRORS ai-feature-display AND ADDS ONE KIND ═══
 *
 * `admin/ai-features/ai-feature-display.ts` solved the hard part, and its own
 * docblock says what it is: "The thing worth getting right about this page is
 * NOT that a toggle renders. It is that a toggle which cannot work says so."
 * Same shape here — a pure function returning `{kind, actionable}`, so the
 * failing input can be driven directly rather than by mounting the page with
 * five fixtures.
 *
 * It needs ONE kind the AI toggles never required:
 *
 *     declared-not-observed
 *
 * The AI toggles never needed it because the app OWNS those flags and reads
 * them itself, so "on" there is a fact. Here the app reads what a deploy
 * declared to a remote gateway that exposes no configuration read API, so
 * "on" is a claim about a process nobody asked. Rendering it as "on" would be
 * the #3909 defect: a control reading as confirmed while nothing verified it.
 *
 * Not "unknown", which would suggest a lookup that failed and might succeed on
 * retry. Nothing here can ever observe it; the name says which.
 *
 * ═══ ORDER IS THE CONTRACT ═══
 *
 * A row can be un-actionable for more than one reason at once, and the reader
 * needs the one that decides what to DO. Same discipline as the AI page, with
 * the new kind slotted by that rule rather than appended:
 *
 *   1. not-configured  — this deploy has no sandbox runtime. Nothing about
 *      channels or enforcement means anything yet, so it is reported first.
 *   2. set-in-code     — a CI gate guarantees this value in a committed
 *      policy. Reported before anything about the remote process, because the
 *      answer is "read the policy", not "look at the gateway".
 *   3. unreachable     — the runtime did not answer. Stated before the
 *      declaration, so a reader is not told what was declared to something
 *      that may not be running.
 *   4. declared-not-observed — the normal state for a channel. Last of the
 *      un-actionable kinds because it is the least urgent: the declaration IS
 *      the best available answer.
 *   5. unconfirmable   — the deploy says sandboxed execution is ON and has
 *      declared no runtime for it to happen in. Last because it is the only
 *      kind that reports an INCOHERENCE rather than a state: the other four
 *      describe a deploy that is consistent with itself.
 */
import type { ReportingChannelKey, SandboxRuntimeDeclaration } from '@/lib/sandbox-runtime/declarations';

export type RuntimeRowKind =
    /** No sandbox runtime is declared by this deploy. */
    | 'not-configured'
    /** Guaranteed in a committed policy by a CI gate. Read the policy, not this page. */
    | 'set-in-code'
    /** The runtime did not answer its health endpoint. */
    | 'unreachable'
    /** Declared to the runtime; the runtime exposes no way to read back what it uses. */
    | 'declared-not-observed'
    /**
     * The deploy claims sandboxed execution and declared no runtime. Availability
     * could not be confirmed — which is NOT the same as the feature being off,
     * and the distinction is the whole point of the kind.
     */
    | 'unconfirmable';

export interface RuntimeRowDisplay {
    readonly kind: RuntimeRowKind;
    /** May an administrator change this row from this page at all? */
    readonly actionable: boolean;
}

/** A reporting channel's row. Never actionable: it is another process's startup configuration. */
export function displayForChannel(
    _channel: ReportingChannelKey,
    declaration: SandboxRuntimeDeclaration,
): RuntimeRowDisplay {
    if (!declaration.configured) return { kind: 'not-configured', actionable: false };
    if (declaration.reachableVersion === null) return { kind: 'unreachable', actionable: false };
    return { kind: 'declared-not-observed', actionable: false };
}

/**
 * An enforcement setting's row. ALWAYS `set-in-code`, including when the
 * runtime is unreachable or unconfigured.
 *
 * That ordering is deliberate and is the one place this function departs from
 * the channel rule above. Whether the gateway is answering has no bearing on
 * where the value lives: it is in a committed policy, held by a CI gate, and
 * the honest affordance is "this is set in code, here is where" in every state.
 * Reporting `unreachable` for it would send a reader to look at a gateway for a
 * value the gateway is not the authority on.
 */
export function displayForEnforcement(): RuntimeRowDisplay {
    return { kind: 'set-in-code', actionable: false };
}

/**
 * The sandbox-execution switch this product owns — platform-only, per the owner
 * ruling of 2026-10-24.
 *
 * `platformEnabled` is what the deploy permits. False here cannot be changed
 * from any UI, exactly as `off-by-platform` works on the AI page.
 *
 * There is deliberately no tenant dimension, and as of the owner ruling of
 * 2026-10-25 there is no flippable control anywhere on this page. An earlier
 * version of this function returned `tenant-switch` with `actionable: true`
 * while this very docblock said the switch was platform-only — the code and
 * the tests agreed with each other and the NAME disagreed with the design.
 * Nothing caught it because `platformEnabled` is false in every environment
 * today, so the misnamed branch was unreachable: a name that lies survives
 * precisely where it is never exercised.
 */
export function displayForExecutionSwitch(
    platformEnabled: boolean,
    runtimeDeclared: boolean,
): RuntimeRowDisplay {
    if (!platformEnabled) return { kind: 'not-configured', actionable: false };
    // ON, with nothing declared to run in. Reported BEFORE the declaration
    // state, because a reader told "declared" about a deploy that named no
    // runtime has been told the reassuring half of a contradiction.
    if (!runtimeDeclared) return { kind: 'unconfirmable', actionable: false };
    return { kind: 'declared-not-observed', actionable: false };
}

/**
 * Every kind, for the renderer to exhaust and for a test to prove each is
 * reachable. A kind no input can produce is a branch that cannot be wrong,
 * which is the defect this module's AI-page ancestor was written to avoid.
 */
export const RUNTIME_ROW_KINDS: readonly RuntimeRowKind[] = [
    'not-configured',
    'set-in-code',
    'unreachable',
    'declared-not-observed',
    'unconfirmable',
] as const;

/**
 * The provenance line's shape — 5.6e (#4000).
 *
 * ═══ WHAT THIS DELIBERATELY CANNOT EXPRESS ═══
 *
 * There is no field here for a setting's value, and that is the design. The
 * issue contrasts a statement that is true —
 *
 *     declared, digest sha256:… , applied 2026-10-30T… — gateway reachable,
 *     reporting version 0.1.6
 *
 * with one that is not:
 *
 *     Telemetry: off
 *
 * The first is a fact about what was SENT and what ANSWERED. The second claims
 * knowledge of the gateway's internal state that no API provides — 0.1a
 * established there is no configuration read endpoint at all. So this type
 * carries a digest, a timestamp and a reachability verdict, and a renderer
 * cannot assert an effective value through it because there is nowhere to put
 * one.
 *
 * ═══ FOUR REACHABILITY VERDICTS, NOT A BOOLEAN ═══
 *
 * `not-probed` and `unreachable` are different facts: the first means this
 * deploy named no gateway, the second that one was named and did not answer.
 * Collapsing them would report someone else's infrastructure as broken because
 * we never asked. `answered-without-version` is separated for the operator
 * debugging a blank version — the gateway did answer.
 */
export interface ProvenanceDisplay {
    /** Is there a digest to show at all? */
    readonly declared: boolean;
    readonly configDigest: string | null;
    readonly appliedAtIso: string | null;
    readonly reachability: 'not-probed' | 'unreachable' | 'answered' | 'answered-without-version';
    /** The version the gateway reported. Null unless `reachability === 'answered'`. */
    readonly reportedVersion: string | null;
}

/**
 * Build the provenance row from a declaration and the probe's outcome.
 *
 * Takes the outcome rather than re-deriving it from `reachableVersion`: a null
 * version is produced by three different outcomes, and a renderer that inferred
 * "unreachable" from it would report a gateway that answered as one that did
 * not.
 */
export function displayForProvenance(
    declaration: Pick<SandboxRuntimeDeclaration, 'configured' | 'configDigest' | 'reachableVersion'>,
    appliedAtIso: string | null,
    probeOutcome: ProvenanceDisplay['reachability'],
): ProvenanceDisplay {
    return {
        declared: declaration.configured,
        configDigest: declaration.configured ? declaration.configDigest : null,
        appliedAtIso,
        reachability: probeOutcome,
        // Guarded here as well as at the probe: only an `answered` outcome may
        // carry a version, so a future caller cannot pass one alongside
        // `unreachable` and have it rendered.
        reportedVersion: probeOutcome === 'answered' ? declaration.reachableVersion : null,
    };
}
