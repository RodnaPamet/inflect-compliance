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
 *   5. tenant-switch   — the one row this product owns and can flip.
 */
import type { ReportingChannelKey, SandboxRuntimeDeclaration } from '@/app-layer/usecases/sandbox-runtime-config';

export type RuntimeRowKind =
    /** No sandbox runtime is declared by this deploy. */
    | 'not-configured'
    /** Guaranteed in a committed policy by a CI gate. Read the policy, not this page. */
    | 'set-in-code'
    /** The runtime did not answer its health endpoint. */
    | 'unreachable'
    /** Declared to the runtime; the runtime exposes no way to read back what it uses. */
    | 'declared-not-observed'
    /** This product's own switch, and the only actionable kind. */
    | 'tenant-switch';

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
 * There is deliberately no tenant dimension. A tenant opting out of sandboxing
 * would be choosing to run its own cloud credentials less safely, which is not
 * a product choice the way "does this workspace get the AI assistant" is.
 */
export function displayForExecutionSwitch(platformEnabled: boolean): RuntimeRowDisplay {
    if (!platformEnabled) return { kind: 'not-configured', actionable: false };
    return { kind: 'tenant-switch', actionable: true };
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
    'tenant-switch',
] as const;
