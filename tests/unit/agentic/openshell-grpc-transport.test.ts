/**
 * The production gRPC transport (#4561).
 *
 * Two layers, because they fail differently.
 *
 * The REAL-SERVER cases stand up an in-process `@grpc/grpc-js` server from the
 * VENDORED contract and drive the transport against it. That is what proves the
 * wire shapes: a field named wrongly, a `oneof` read from the wrong member, or
 * a server stream consumed as a unary call all pass a hand-written double and
 * fail here.
 *
 * The INJECTED cases drive failure arms a real server cannot easily produce —
 * a stream that ends without an exit event, `UNAVAILABLE`, `NOT_FOUND` — and
 * assert the mapping onto this product's error vocabulary.
 *
 * ═══ WHAT THESE DO NOT PROVE, STATED ═══
 *
 * The in-process server uses INSECURE credentials. So this suite does not
 * exercise the mTLS handshake or the gateway's auth table; that was measured
 * against the running 0.1.6 gateway and recorded on #4561 (`CreateSandbox` over
 * mTLS answers `InvalidArgument: spec is required`, not `PermissionDenied`).
 * What IS asserted here is the half a test can own: that a missing key file is
 * fatal rather than a silent downgrade to an insecure channel.
 *
 * @module unit/agentic/openshell-grpc-transport
 */

import * as path from 'node:path';

import {
    DEFAULT_DEADLINE_MS,
    PROTO_DIR,
    PROTO_ENTRY,
    grpcSandboxTransport,
    type ExecStreamLike,
    type GrpcClientLike,
} from '@/lib/agentic/openshell/grpc-transport';
import {
    DELETION_IS_SETTLED,
    SandboxExecIncompleteError,
    SandboxUnreachableError,
} from '@/lib/agentic/openshell/transport';

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');

const POLICY = { network_policies: [] };

function loadContract() {
    const def = loader.loadSync(PROTO_ENTRY, {
        includeDirs: [path.resolve(process.cwd(), PROTO_DIR)],
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
    });
    return grpc.loadPackageDefinition(def);
}

// ── layer 1: a real server over the vendored contract ──────────────────────

interface Recorded {
    create: any[];
    exec: any[];
    del: any[];
    attach: any[];
    get: any[];
}

async function withRealServer(
    handlers: Record<string, (call: any, cb?: any) => void>,
    body: (client: GrpcClientLike) => Promise<void>,
): Promise<void> {
    const pkg = loadContract();
    const server = new grpc.Server();
    server.addService(pkg.openshell.v1.OpenShell.service, handlers);
    const port: number = await new Promise((resolve, reject) =>
        server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e: Error | null, p: number) =>
            e ? reject(e) : resolve(p),
        ),
    );
    const client = new pkg.openshell.v1.OpenShell(
        `127.0.0.1:${port}`,
        grpc.credentials.createInsecure(),
    ) as GrpcClientLike;
    try {
        await body(client);
    } finally {
        client.close?.();
        await new Promise<void>((r) => server.tryShutdown(() => r()));
    }
}

describe('against a real gRPC server built from the vendored contract', () => {
    it('creates a sandbox and reads its id and phase off the response', async () => {
        const seen: Recorded['create'] = [];
        await withRealServer(
            {
                CreateSandbox: (call: any, cb: any) => {
                    seen.push(call.request);
                    cb(null, {
                        sandbox: {
                            metadata: { id: 'sbx-real-1' },
                            status: { phase: 'SANDBOX_PHASE_READY' },
                        },
                    });
                },
            },
            async (client) => {
                const t = grpcSandboxTransport({
                    endpoint: 'unused',
                    caCertPath: 'unused',
                    clientCertPath: 'unused',
                    clientKeyPath: 'unused',
                    workspace: 'default',
                    policy: POLICY,
                    clientForTests: client,
                });
                const made = await t.createSandbox({ labels: { owner: 'collector' } });
                expect(made).toEqual({ id: 'sbx-real-1', phase: 'SANDBOX_PHASE_READY' });
            },
        );
        /*
            Every request in this contract requires a workspace scope — a
            missing one is `InvalidArgument: workspace_scope is required` from
            the real gateway, measured.

            `WorkspaceSelector` is a `oneof selection`, so the decoded message
            carries the DISCRIMINATOR as well as the value. Both are asserted:
            the value alone would pass if the oneof had resolved to
            `all_workspaces`, which is a cross-workspace read this transport
            must never make.
        */
        expect(seen[0].workspace_scope.workspace).toBe('default');
        expect(seen[0].workspace_scope.selection).toBe('workspace');
        expect(seen[0].workspace_scope.all_workspaces).toBeFalsy();
        expect(seen[0].labels).toEqual({ owner: 'collector' });
        expect(seen[0].spec.policy).toBeDefined();
    });

    it('consumes ExecSandbox as a SERVER STREAM and separates stdout from stderr', async () => {
        /*
            The case a double cannot catch. `ExecSandbox` is the only streaming
            method of the five, and its events are a `oneof` — reading the wrong
            member yields empty output with no error anywhere.
        */
        await withRealServer(
            {
                ExecSandbox: (call: any) => {
                    call.write({ stdout: { data: Buffer.from('out-a') } });
                    call.write({ stderr: { data: Buffer.from('err-a') } });
                    call.write({ stdout: { data: Buffer.from('out-b') } });
                    call.write({ exit: { exit_code: 7 } });
                    call.end();
                },
            },
            async (client) => {
                const t = grpcSandboxTransport({
                    endpoint: 'unused',
                    caCertPath: 'u',
                    clientCertPath: 'u',
                    clientKeyPath: 'u',
                    workspace: 'default',
                    policy: POLICY,
                    clientForTests: client,
                });
                const res = await t.execSandbox({
                    sandboxId: 'sbx-1',
                    file: 'powerpipe',
                    args: ['benchmark', 'run'],
                    signal: new AbortController().signal,
                });
                expect(res.exited).toBe(true);
                expect(res.exitCode).toBe(7);
                expect(res.stdout).toBe('out-aout-b');
                expect(res.stderr).toBe('err-a');
                // The contract carries no signal field, so this is always null.
                expect(res.signal).toBeNull();
            },
        );
    });

    it('treats exit code 0 as an exit, not as "no exit seen"', async () => {
        // Zero is falsy. A flag-free implementation reads a clean success as a
        // dropped stream and throws, which would fail every passing collection.
        await withRealServer(
            {
                ExecSandbox: (call: any) => {
                    call.write({ stdout: { data: Buffer.from('{}') } });
                    call.write({ exit: { exit_code: 0 } });
                    call.end();
                },
            },
            async (client) => {
                const t = grpcSandboxTransport({
                    endpoint: 'u',
                    caCertPath: 'u',
                    clientCertPath: 'u',
                    clientKeyPath: 'u',
                    workspace: 'default',
                    policy: POLICY,
                    clientForTests: client,
                });
                const res = await t.execSandbox({
                    sandboxId: 'sbx-1',
                    file: 'x',
                    args: [],
                    signal: new AbortController().signal,
                });
                expect(res.exitCode).toBe(0);
                expect(res.exited).toBe(true);
            },
        );
    });

    it('sends the command as file-then-args, and attaches a provider BY NAME only', async () => {
        const execReq: any[] = [];
        const attachReq: any[] = [];
        await withRealServer(
            {
                ExecSandbox: (call: any) => {
                    execReq.push(call.request);
                    call.write({ exit: { exit_code: 0 } });
                    call.end();
                },
                AttachSandboxProvider: (call: any, cb: any) => {
                    attachReq.push(call.request);
                    cb(null, {});
                },
            },
            async (client) => {
                const t = grpcSandboxTransport({
                    endpoint: 'u',
                    caCertPath: 'u',
                    clientCertPath: 'u',
                    clientKeyPath: 'u',
                    workspace: 'default',
                    policy: POLICY,
                    clientForTests: client,
                });
                await t.execSandbox({
                    sandboxId: 'sbx-9',
                    file: 'powerpipe',
                    args: ['benchmark', 'run', 'all'],
                    env: { NODE_ENV: 'test', AWS_REGION: 'eu-west-1' },
                    signal: new AbortController().signal,
                });
                await t.attachProvider({
                    sandboxId: 'sbx-9',
                    providerName: 'inflect-collector',
                    signal: new AbortController().signal,
                });
            },
        );
        expect(execReq[0].command).toEqual(['powerpipe', 'benchmark', 'run', 'all']);
        // Forwarded verbatim. `NODE_ENV` rides along because this repo's
        // `ProcessEnv` requires it; what matters is that the collector's own
        // variables arrive unaltered.
        expect(execReq[0].environment).toEqual({ NODE_ENV: 'test', AWS_REGION: 'eu-west-1' });
        // 4.1's requirement, held at the wire: the attach request carries a
        // provider NAME and no credential field of any kind.
        expect(attachReq[0].provider).toBe('inflect-collector');
        expect(JSON.stringify(attachReq[0])).not.toMatch(/secret|credential|key|token/i);
    });

    it('carries the deletion outcome VERBATIM, including the proto3 zero', async () => {
        for (const [sent, expected] of [
            ['DELETION_OUTCOME_COMPLETED', 'DELETION_OUTCOME_COMPLETED'],
            ['DELETION_OUTCOME_ACCEPTED', 'DELETION_OUTCOME_ACCEPTED'],
            ['DELETION_OUTCOME_UNSPECIFIED', 'DELETION_OUTCOME_UNSPECIFIED'],
        ] as const) {
            await withRealServer(
                { DeleteSandbox: (_c: any, cb: any) => cb(null, { outcome: sent, sandbox_id: 'sbx-1' }) },
                async (client) => {
                    const t = grpcSandboxTransport({
                        endpoint: 'u',
                        caCertPath: 'u',
                        clientCertPath: 'u',
                        clientKeyPath: 'u',
                        workspace: 'default',
                        policy: POLICY,
                        clientForTests: client,
                    });
                    const res = await t.deleteSandbox({ sandboxId: 'sbx-1' });
                    expect(res.outcome).toBe(expected);
                },
            );
        }
        // And the zero is NOT settled — the caller still owes a wait.
        expect(DELETION_IS_SETTLED).not.toContain('DELETION_OUTCOME_UNSPECIFIED');
        expect(DELETION_IS_SETTLED).not.toContain('DELETION_OUTCOME_ACCEPTED');
    });
});

// ── layer 2: failure arms, injected ────────────────────────────────────────

function stubStream(script: (s: { data: (c: unknown) => void; end: () => void; error: (e: unknown) => void }) => void): ExecStreamLike {
    const handlers: Record<string, ((a?: unknown) => void)[]> = { data: [], end: [], error: [] };
    const stream: ExecStreamLike = {
        on(event: string, cb: (a?: any) => void) {
            handlers[event].push(cb);
            return stream;
        },
        cancel: () => undefined,
    } as ExecStreamLike;
    setImmediate(() =>
        script({
            data: (c) => handlers.data.forEach((h) => h(c)),
            end: () => handlers.end.forEach((h) => h()),
            error: (e) => handlers.error.forEach((h) => h(e)),
        }),
    );
    return stream;
}

const withCode = (code: number, msg = 'boom'): any => Object.assign(new Error(msg), { code });

function injected(over: Partial<GrpcClientLike>): GrpcClientLike {
    const unimplemented = () => {
        throw new Error('not expected in this case');
    };
    return {
        CreateSandbox: unimplemented,
        GetSandbox: unimplemented,
        DeleteSandbox: unimplemented,
        AttachSandboxProvider: unimplemented,
        ExecSandbox: unimplemented as never,
        ...over,
    } as GrpcClientLike;
}

const t = (client: GrpcClientLike) =>
    grpcSandboxTransport({
        endpoint: 'u',
        caCertPath: 'u',
        clientCertPath: 'u',
        clientKeyPath: 'u',
        workspace: 'default',
        policy: POLICY,
        clientForTests: client,
    });

describe('failure arms map onto this product error vocabulary', () => {
    it('a stream that ends with NO exit event throws rather than returning a result', async () => {
        /*
            The interface forbids returning a null code with a null signal,
            because that shape is ambiguous with a clean exit nobody recorded.
            "The tool succeeded and the connection dropped" and "the tool was
            killed mid-write" are indistinguishable from the bytes received.
        */
        const client = injected({
            ExecSandbox: () =>
                stubStream((s) => {
                    s.data({ stdout: { data: 'partial output' } });
                    s.end();
                }),
        });
        await expect(
            t(client).execSandbox({
                sandboxId: 'sbx-5',
                file: 'x',
                args: [],
                signal: new AbortController().signal,
            }),
        ).rejects.toThrow(SandboxExecIncompleteError);
    });

    it('the incomplete error names the sandbox and how many bytes were seen', async () => {
        const client = injected({
            ExecSandbox: () =>
                stubStream((s) => {
                    s.data({ stdout: { data: 'abc' } });
                    s.data({ stderr: { data: 'de' } });
                    s.end();
                }),
        });
        await expect(
            t(client).execSandbox({
                sandboxId: 'sbx-6',
                file: 'x',
                args: [],
                signal: new AbortController().signal,
            }),
        ).rejects.toThrow(/sbx-6[\s\S]*after 5 byte/);
    });

    it('UNAVAILABLE becomes SandboxUnreachableError — the ORDINARY case', async () => {
        // The VM is TERMINATED almost always by design, so this is the normal
        // reading rather than an exception, and the collector ladder scores it
        // ERROR rather than passing.
        const client = injected({
            CreateSandbox: (_r, _o, cb) => cb(withCode(14, 'no connection established')),
        });
        await expect(t(client).createSandbox({})).rejects.toThrow(SandboxUnreachableError);
    });

    it('a deadline becomes unreachable too, not a bare timeout', async () => {
        const client = injected({ CreateSandbox: (_r, _o, cb) => cb(withCode(4, 'Deadline exceeded')) });
        await expect(t(client).createSandbox({})).rejects.toThrow(SandboxUnreachableError);
    });

    it('a NON-transport error is NOT disguised as unreachable', async () => {
        // InvalidArgument means the gateway answered and refused the request.
        // Reporting that as "unreachable" would send an operator to check a
        // network that is fine.
        const client = injected({ CreateSandbox: (_r, _o, cb) => cb(withCode(3, 'spec is required')) });
        const err = await t(client).createSandbox({}).catch((e) => e);
        expect(err).not.toBeInstanceOf(SandboxUnreachableError);
        expect(String(err)).toContain('spec is required');
    });

    it('a create that returns no id is a failure, not a sandbox', async () => {
        // Nothing could later be exec'd in it or deleted, so reporting success
        // would strand a sandbox the caller cannot name.
        const client = injected({ CreateSandbox: (_r, _o, cb) => cb(null, { sandbox: {} }) });
        await expect(t(client).createSandbox({})).rejects.toThrow(SandboxUnreachableError);
    });

    it('an ABSENT deletion outcome defaults to the zero, never to COMPLETED', async () => {
        /*
            Found by mutation: changing the fallback to `DELETION_OUTCOME_COMPLETED`
            left every test green. It is the most dangerous line in the module —
            a response whose outcome field never arrived would be recorded as a
            sandbox that is gone, and `DELETION_IS_SETTLED` would tell the caller
            it owes no wait. The sandbox would still be running, on a host whose
            Docker socket is root-equivalent.

            The real gateway with `defaults: true` decodes an unset enum to the
            zero value rather than to undefined, so this arm is reached when a
            response is malformed or a proxy drops the field — which is exactly
            the case a zero value cannot be distinguished from.
        */
        const client = injected({ DeleteSandbox: (_r, _o, cb) => cb(null, {}) });
        const res = await t(client).deleteSandbox({ sandboxId: 'sbx-1' });
        expect(res.outcome).toBe('DELETION_OUTCOME_UNSPECIFIED');
        expect(DELETION_IS_SETTLED).not.toContain(res.outcome);
    });

    it('awaitDeleted resolves when the gateway says NOT_FOUND', async () => {
        let calls = 0;
        const client = injected({
            GetSandbox: (_r, _o, cb) => {
                calls += 1;
                if (calls < 3) cb(null, { sandbox: { metadata: { id: 'sbx-1' } } });
                else cb(withCode(5, 'not found'));
            },
        });
        await t(client).awaitDeleted({ sandboxId: 'sbx-1', signal: new AbortController().signal });
        // It really waited rather than returning on the first answer.
        expect(calls).toBe(3);
    });

    it('a missing client key is FATAL, never a downgrade to an insecure channel', () => {
        /*
            The owner's decision is a root-owned 0400 file delivered out of
            band. A deploy that was never given one has no client identity, and
            an unauthenticated channel to a root-equivalent Docker socket is
            precisely what the mTLS arrangement exists to prevent. So this
            throws at CONSTRUCTION rather than at first call.
        */
        expect(() =>
            grpcSandboxTransport({
                endpoint: '10.132.0.28:17670',
                caCertPath: '/nonexistent/ca.crt',
                clientCertPath: '/nonexistent/tls.crt',
                clientKeyPath: '/nonexistent/tls.key',
                workspace: 'default',
                policy: POLICY,
            }),
        ).toThrow(SandboxUnreachableError);
    });

    it('PROTO_DIR and the literal at the read site are the same path', () => {
        /*
            The read site must spell the path literally so
            `catalogue-reaches-production` can follow it into the Dockerfile.
            That leaves two spellings of one path, and a drift between them
            would mean the guard proves the image carries a directory the
            transport does not actually load from.
        */
        const src = require('node:fs').readFileSync(
            'src/lib/agentic/openshell/grpc-transport.ts',
            'utf8',
        ) as string;
        const literals = [...src.matchAll(/process\.cwd\(\),\s*'([^']+)'/g)].map((m) => m[1]);
        expect(literals).toEqual([PROTO_DIR]);
    });

    it('the default deadline is short enough not to hang a collection', () => {
        // A stopped gateway must fail a job quickly, not hold a worker.
        expect(DEFAULT_DEADLINE_MS).toBeLessThanOrEqual(60_000);
        expect(DEFAULT_DEADLINE_MS).toBeGreaterThanOrEqual(5_000);
    });
});
