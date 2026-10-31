/**
 * The production `SandboxTransport` — gRPC over mTLS to the gateway (#4561).
 *
 * `transport.ts` declared the shape of the conversation and said what should
 * land here: "when an SDK lands it is implemented behind `SandboxTransport` and
 * imported from a module of its own". There is still no SDK, so this is a
 * client over the vendored contract rather than a wrapper around one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * mTLS ONLY, AND THAT IS SUFFICIENT — MEASURED, NOT ASSUMED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `CreateSandbox` declares `auth_mode: "bearer"` with `scope: "sandbox:write"`,
 * which reads as "a bearer token is required" — and the DPIA records that an
 * mTLS identity reports `Roles: openshell-user` with **no scopes at all**. If
 * scope were enforced on this path there would be no way to call the gateway:
 * the OIDC pair is deliberately unset for want of an identity provider, so no
 * token can be minted.
 *
 * Upstream's `options.proto` says which it is — `scope` is "Required OIDC scope
 * on the **bearer path**" — and that was confirmed against the running 0.1.6
 * gateway on 2026-10-30 rather than inferred from the comment:
 *
 *     ListWorkspaces        -> 200, returns `default`
 *     ListSandboxes         -> InvalidArgument: workspace_scope is required
 *     CreateSandbox         -> InvalidArgument: spec is required
 *
 * The discriminator is the error CODE. An unauthenticated call to this gateway
 * answers `missing authorization header`; an argument error can only come from
 * a call that passed the auth table. A `PermissionDenied` there would have made
 * this module impossible to write.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE KEY IS READ FROM DISK AT CONSTRUCTION, AND ABSENCE IS FATAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Owner decision, 2026-10-30: the client key reaches the app VM as a root-owned
 * `0400` file delivered out of band, chosen over an env-var PEM (which would
 * make the key process-wide, visible to anything that dumps env or ships a
 * crash report) and over Secret Manager (which the app uses for nothing today).
 *
 * So the key never crosses this interface, never appears in configuration this
 * repository holds, and a missing file THROWS rather than degrading to an
 * unauthenticated channel. Degrading would be the worst available behaviour:
 * the gateway's Docker socket is root-equivalent, and an unauthenticated
 * channel to it is what the whole mTLS arrangement exists to prevent.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * UNREACHABLE IS THE ORDINARY CASE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The gateway VM is `TERMINATED` almost always by design — the 5 USD/month cap
 * is a runtime budget. #4561 is explicit that a transport "that assumes a
 * reachable gateway will fail almost always", so every call maps gRPC
 * `UNAVAILABLE` and `DEADLINE_EXCEEDED` onto `SandboxUnreachableError`, which
 * the collector ladder already reports as ERROR rather than as a pass. Starting
 * the VM is the caller's act (#4603), not this module's.
 *
 * @module lib/agentic/openshell/grpc-transport
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {
    SandboxExecIncompleteError,
    SandboxUnreachableError,
    type CreatedSandbox,
    type DeleteResult,
    type DeletionOutcome,
    type SandboxExecResult,
    type SandboxPhase,
    type SandboxTransport,
} from './transport';

/** Where the vendored contract lives. Loaded lazily — see `serviceDefinition`. */
export const PROTO_DIR = 'vendor/openshell-proto/v0.1.6';
/** The one file to load; its imports resolve inside `PROTO_DIR`. */
export const PROTO_ENTRY = 'openshell.proto';

/** gRPC status codes this module reasons about, by name rather than number. */
const GRPC_UNAVAILABLE = 14;
const GRPC_DEADLINE_EXCEEDED = 4;
const GRPC_NOT_FOUND = 5;

export interface GrpcTransportConfig {
    /** `host:port`. The gateway listens on 17670 over the VPC. */
    readonly endpoint: string;
    /** The CA that signed the gateway's server certificate. */
    readonly caCertPath: string;
    /** The client certificate — `CN=openshell-client, OU=openshell-user`. */
    readonly clientCertPath: string;
    /** The client key. Root-owned `0400`, delivered out of band. */
    readonly clientKeyPath: string;
    /** Workspace scope. Every request in this contract requires one. */
    readonly workspace: string;
    /**
     * The sandbox policy, required by `SandboxSpec`. Supplied at CONSTRUCTION
     * rather than per call because `SandboxTransport.createSandbox` takes only
     * labels — #4561 requires that interface to survive, and threading a policy
     * through it would have widened the one contract the issue asks to preserve.
     */
    readonly policy: unknown;
    /** Optional container/VM template. The gateway defaults it when omitted. */
    readonly template?: unknown;
    /** Per-call deadline. Short, because an absent gateway must not hang a job. */
    readonly deadlineMs?: number;
    /** Injected for tests: a ready-made client. Production passes nothing. */
    readonly clientForTests?: GrpcClientLike;
}

/** The five calls, in the shape `@grpc/grpc-js` generates for them. */
export interface GrpcClientLike {
    CreateSandbox(req: unknown, opts: unknown, cb: Callback<unknown>): void;
    GetSandbox(req: unknown, opts: unknown, cb: Callback<unknown>): void;
    DeleteSandbox(req: unknown, opts: unknown, cb: Callback<unknown>): void;
    AttachSandboxProvider(req: unknown, opts: unknown, cb: Callback<unknown>): void;
    ExecSandbox(req: unknown, opts: unknown): ExecStreamLike;
    close?(): void;
}

type Callback<T> = (err: GrpcError | null, value?: T) => void;
interface GrpcError extends Error {
    readonly code?: number;
}
export interface ExecStreamLike {
    on(event: 'data', cb: (chunk: unknown) => void): this;
    on(event: 'end', cb: () => void): this;
    on(event: 'error', cb: (err: GrpcError) => void): this;
    cancel?(): void;
}

export const DEFAULT_DEADLINE_MS = 30_000;
/** How often `awaitDeleted` asks. The gateway applies deletion asynchronously. */
export const DELETION_POLL_MS = 500;

/** `UNAVAILABLE` and a timeout both mean "the gateway did not answer". */
function asUnreachable(err: GrpcError, what: string): never {
    if (err.code === GRPC_UNAVAILABLE || err.code === GRPC_DEADLINE_EXCEEDED) {
        throw new SandboxUnreachableError(`${what}: ${err.message}`);
    }
    throw err;
}

function readPem(file: string, what: string): Buffer {
    try {
        return fs.readFileSync(file);
    } catch (e) {
        /*
            Fatal, never a fallback to an insecure channel. The file's absence
            means this deploy was not given a client identity, and an
            unauthenticated channel to a root-equivalent Docker socket is the
            thing the mTLS arrangement exists to prevent.
        */
        throw new SandboxUnreachableError(
            `the OpenShell client ${what} at ${file} could not be read ` +
                `(${(e as Error).message}); it is delivered out of band as a root-owned 0400 file`,
        );
    }
}

/**
 * Load the vendored contract. Cached, and lazy so importing this module reads
 * no files — a unit test that never calls the transport should not need the
 * proto on disk.
 *
 * The LIBRARIES are imported statically. An earlier draft `require()`d them to
 * defer the cost, and `logging-import-hygiene` refused it: dynamic require in
 * `src/` needs an allowlist entry and a justification. There is none to give —
 * the laziness that matters is the disk read below, which this cache already
 * defers, and the imports themselves read nothing.
 */
let cached: unknown;
function serviceDefinition(): unknown {
    if (cached !== undefined) return cached;
    const def = protoLoader.loadSync(PROTO_ENTRY, {
        /*
            The path is written as a LITERAL here, not as `PROTO_DIR`, and that
            is a requirement rather than a style choice.
            `catalogue-reaches-production` scans `src/` for
            `process.cwd()` reads and asserts the runtime image copies every
            directory one resolves to — it caught this module the moment it was
            written. The scan can only follow the literal form, so an indirected
            path reads as an unanalysable cwd read and fails that guard, which is
            the correct outcome: a path it cannot follow is a path it cannot
            prove is in the image.

            `PROTO_DIR` stays exported for tests and the provenance guardrail,
            and a test asserts the two spellings are the same string, because
            two paths that can disagree are worse than one.
        */
        includeDirs: [path.resolve(process.cwd(), 'vendor/openshell-proto/v0.1.6')],
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
    });
    cached = grpc.loadPackageDefinition(def);
    return cached;
}

/** Build the mTLS client. Separated so a test can supply its own. */
function buildClient(cfg: GrpcTransportConfig): GrpcClientLike {
    const pkg = serviceDefinition() as {
        openshell: { v1: { OpenShell: new (a: string, c: unknown) => GrpcClientLike } };
    };
    const creds = grpc.credentials.createSsl(
        readPem(cfg.caCertPath, 'CA certificate'),
        readPem(cfg.clientKeyPath, 'private key'),
        readPem(cfg.clientCertPath, 'certificate'),
    );
    return new pkg.openshell.v1.OpenShell(cfg.endpoint, creds);
}

export function grpcSandboxTransport(cfg: GrpcTransportConfig): SandboxTransport {
    const client = cfg.clientForTests ?? buildClient(cfg);
    const deadlineMs = cfg.deadlineMs ?? DEFAULT_DEADLINE_MS;
    const scope = { workspace: cfg.workspace };
    const opts = () => ({ deadline: new Date(Date.now() + deadlineMs) });

    /*
        The callback parameter is typed as the CLIENT declares it
        (`Callback<unknown>`) rather than as `Callback<T>`. Callback parameters
        are contravariant, so a `Callback<unknown>` consumer cannot be passed
        where a `Callback<Specific>` is expected — tsc caught exactly that. The
        narrowing happens once, at the resolve, where it is visible.
    */
    const unary = <T>(
        call: (req: unknown, o: unknown, cb: Callback<unknown>) => void,
        req: unknown,
        what: string,
    ): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            call(req, opts(), (err, value) => {
                if (err) {
                    try {
                        asUnreachable(err, what);
                    } catch (mapped) {
                        reject(mapped);
                    }
                    return;
                }
                resolve(value as T);
            });
        });

    return {
        async createSandbox(input): Promise<CreatedSandbox> {
            const res = await unary<{ sandbox?: { metadata?: { id?: string }; status?: { phase?: string } } }>(
                client.CreateSandbox.bind(client),
                {
                    workspace_scope: scope,
                    labels: input.labels ?? {},
                    spec: { policy: cfg.policy, ...(cfg.template ? { template: cfg.template } : {}) },
                },
                'creating a sandbox',
            );
            const id = res?.sandbox?.metadata?.id;
            if (!id) {
                // A create that returns no id is not a success we can act on:
                // nothing could later be exec'd in it or deleted.
                throw new SandboxUnreachableError('the gateway created a sandbox but returned no id');
            }
            return { id, phase: (res.sandbox?.status?.phase ?? 'SANDBOX_PHASE_UNSPECIFIED') as SandboxPhase };
        },

        async execSandbox(input): Promise<SandboxExecResult> {
            const stream = client.ExecSandbox(
                {
                    workspace_scope: scope,
                    sandbox: input.sandboxId,
                    command: [input.file, ...input.args],
                    environment: input.env ?? {},
                },
                opts(),
            );
            let stdout = '';
            let stderr = '';
            let exitCode: number | null = null;
            let sawExit = false;

            const onAbort = () => stream.cancel?.();
            input.signal.addEventListener('abort', onAbort, { once: true });

            try {
                await new Promise<void>((resolve, reject) => {
                    stream.on('data', (chunk) => {
                        const ev = chunk as {
                            stdout?: { data?: Buffer | string };
                            stderr?: { data?: Buffer | string };
                            exit?: { exit_code?: number };
                        };
                        if (ev.stdout?.data !== undefined) stdout += String(ev.stdout.data);
                        else if (ev.stderr?.data !== undefined) stderr += String(ev.stderr.data);
                        else if (ev.exit !== undefined) {
                            // The authoritative end of the run. Recorded as a
                            // flag as well as a value, because exit code 0 is
                            // falsy and must not read as "no exit seen".
                            sawExit = true;
                            exitCode = ev.exit.exit_code ?? 0;
                        }
                    });
                    stream.on('error', (err) => {
                        try {
                            asUnreachable(err, 'executing in a sandbox');
                        } catch (mapped) {
                            reject(mapped);
                        }
                    });
                    stream.on('end', () => resolve());
                });
            } finally {
                input.signal.removeEventListener('abort', onAbort);
            }

            if (!sawExit) {
                /*
                    The contract is explicit that a transport MUST throw rather
                    than return a null code with a null signal, because that
                    shape is ambiguous with a clean exit nobody recorded.
                */
                throw new SandboxExecIncompleteError(input.sandboxId, stdout.length + stderr.length);
            }
            return {
                exited: true,
                exitCode,
                /*
                    ALWAYS null, and that is the contract's limit rather than an
                    omission here: `ExecSandboxExit` carries exactly one field,
                    `int32 exit_code`. The gateway has no way to report a signal,
                    so a transport that synthesised one would be inventing it.
                */
                signal: null,
                stdout,
                stderr,
            };
        },

        async deleteSandbox(input): Promise<DeleteResult> {
            const res = await unary<{ outcome?: string }>(
                client.DeleteSandbox.bind(client),
                { workspace_scope: scope, name: input.sandboxId, allow_missing: true },
                'deleting a sandbox',
            );
            /*
                Carried VERBATIM, including the proto3 zero. `UNSPECIFIED` is
                indistinguishable from an unset field and from one a proxy
                dropped, so mapping it to "completed" is how a sandbox that
                still exists gets recorded as deleted. `DELETION_IS_SETTLED`
                deliberately excludes it, and the caller waits.
            */
            return { outcome: (res?.outcome ?? 'DELETION_OUTCOME_UNSPECIFIED') as DeletionOutcome };
        },

        async awaitDeleted(input): Promise<void> {
            // Polls GetSandbox until the gateway says NOT_FOUND. Only called
            // after ACCEPTED, which means admitted rather than performed.
            for (;;) {
                if (input.signal.aborted) throw new Error('aborted while awaiting sandbox deletion');
                try {
                    await unary(
                        client.GetSandbox.bind(client),
                        { workspace_scope: scope, name: input.sandboxId },
                        'reading a sandbox',
                    );
                } catch (e) {
                    if ((e as GrpcError).code === GRPC_NOT_FOUND) return;
                    throw e;
                }
                await new Promise((r) => setTimeout(r, DELETION_POLL_MS));
            }
        },

        async attachProvider(input): Promise<void> {
            // A NAME and nothing else. The credential is configured on the
            // gateway out of band and never crosses this interface.
            await unary(
                client.AttachSandboxProvider.bind(client),
                { workspace_scope: scope, sandbox: input.sandboxId, provider: input.providerName },
                'attaching a credential provider',
            );
        },
    };
}
