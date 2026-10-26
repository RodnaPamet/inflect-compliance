/**
 * The OpenShell gateway boundary — types and the transport SEAM, no client.
 *
 * ═══ WHY THERE IS NO SDK IMPORT HERE ═══
 *
 * There is no OpenShell SDK in this repository, by decision: 0.2 of the phase-0
 * spike defers it, and nothing in `package.json` or `node_modules` provides one.
 * So this module declares the shape of the conversation and takes the transport
 * as an argument. When an SDK lands it is implemented behind
 * `SandboxTransport` and imported from a module of its own — which is also what
 * 4.2's "isolated boundary module" instruction asks for, and what
 * `flue/agent.ts` does for the ESM-only `@flue/runtime`.
 *
 * The unconfigured transport answers `unreachable`. It is not a stub that
 * pretends: a caller that reaches it gets a refusal it can act on, which is the
 * same choice `packages/agent-harness-scanner` made for its own OpenShell wire.
 *
 * ═══ THE VOCABULARY IS THE GATEWAY'S, READ FROM THE BINARY ═══
 *
 * Every constant below was read out of `openshell-gateway` v0.1.5 rather than
 * taken from documentation, because this phase has already been wrong twice
 * about names that documentation gave (`ocsf_log`'s TOML table does nothing;
 * `sandbox:read` is not what gates an mTLS identity).
 *
 * In particular the deletion outcome has FOUR members and 4.2's description
 * names three:
 *
 *     DELETION_OUTCOME_UNSPECIFIED      <- the proto3 zero value
 *     DELETION_OUTCOME_COMPLETED
 *     DELETION_OUTCOME_ACCEPTED
 *     DELETION_OUTCOME_ALREADY_ABSENT
 *
 * The missing one is the dangerous one. `UNSPECIFIED` is zero on the wire, so a
 * field that was never set, a field dropped by a proxy, and a field explicitly
 * set to zero are the same bytes. Treating it as "probably completed" is how a
 * sandbox that still exists gets recorded as deleted, so it is handled
 * explicitly and pessimistically below.
 */

/** Sandbox lifecycle phases, as the gateway spells them. */
export const SANDBOX_PHASES = [
    'SANDBOX_PHASE_UNSPECIFIED',
    'SANDBOX_PHASE_UNKNOWN',
    'SANDBOX_PHASE_STARTING',
    'SANDBOX_PHASE_READY',
    'SANDBOX_PHASE_RESTARTING',
    'SANDBOX_PHASE_STOPPING',
    'SANDBOX_PHASE_STOPPED',
] as const;
export type SandboxPhase = (typeof SANDBOX_PHASES)[number];

/** Deletion outcomes, all FOUR of them. */
export const DELETION_OUTCOMES = [
    'DELETION_OUTCOME_UNSPECIFIED',
    'DELETION_OUTCOME_COMPLETED',
    'DELETION_OUTCOME_ACCEPTED',
    'DELETION_OUTCOME_ALREADY_ABSENT',
] as const;
export type DeletionOutcome = (typeof DELETION_OUTCOMES)[number];

/**
 * Outcomes after which the sandbox is gone and nothing further is owed.
 *
 * `ACCEPTED` is NOT here, and that is the whole point of the set existing: the
 * gateway's own help text for it reads "Does not wait for" — the deletion was
 * admitted, not performed, so the caller owes a wait. `UNSPECIFIED` is not here
 * either, because a zero value is not an assurance.
 */
export const DELETION_IS_SETTLED: readonly DeletionOutcome[] = [
    'DELETION_OUTCOME_COMPLETED',
    'DELETION_OUTCOME_ALREADY_ABSENT',
];

export interface CreatedSandbox {
    readonly id: string;
    readonly phase: SandboxPhase;
}

export interface SandboxExecResult {
    /** Process exit code, or null when the sandbox reported a signal instead. */
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly stdout: string;
    readonly stderr: string;
}

export interface DeleteResult {
    readonly outcome: DeletionOutcome;
}

/**
 * What a transport must do. Deliberately four narrow calls rather than a client
 * object: each is a thing the executor needs, and nothing here can list, read
 * providers, or touch credentials.
 */
export interface SandboxTransport {
    createSandbox(input: { readonly labels?: Readonly<Record<string, string>> }): Promise<CreatedSandbox>;
    execSandbox(input: {
        readonly sandboxId: string;
        readonly file: string;
        readonly args: readonly string[];
        readonly env?: NodeJS.ProcessEnv;
        readonly signal: AbortSignal;
    }): Promise<SandboxExecResult>;
    deleteSandbox(input: { readonly sandboxId: string }): Promise<DeleteResult>;
    /** Resolve once the sandbox is absent. Only called after `ACCEPTED`. */
    awaitDeleted(input: { readonly sandboxId: string; readonly signal: AbortSignal }): Promise<void>;
}

/** Raised when the gateway cannot be reached or is not configured. */
export class SandboxUnreachableError extends Error {
    constructor(detail: string) {
        super(`the OpenShell gateway is not reachable: ${detail}`);
        this.name = 'SandboxUnreachableError';
    }
}

/**
 * The transport when none is configured. Every call refuses.
 *
 * This is what makes 4.2b (#3963) hold by construction: a deployment without a
 * gateway cannot silently run the tool locally, because the only thing it can
 * get from here is an error. There is no arm of this module that returns a
 * result without a transport.
 */
const refuse = (): never => {
    throw new SandboxUnreachableError('no transport is configured in this build');
};

/*
    `async` on every method, deliberately. The interface declares `Promise<…>`,
    and a method that throws SYNCHRONOUSLY while declaring a promise breaks the
    contract in the one way a caller cannot defend against: `transport
    .createSandbox(…).catch(handle)` never runs `handle`, because the throw
    happens before a promise exists. A test caught exactly that.
*/
export const unconfiguredTransport: SandboxTransport = {
    createSandbox: async () => refuse(),
    execSandbox: async () => refuse(),
    deleteSandbox: async () => refuse(),
    awaitDeleted: async () => refuse(),
};
