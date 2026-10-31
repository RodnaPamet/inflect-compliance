/**
 * The collector constructs a real transport — #4561's last wiring.
 *
 * #4561's measurement was that nothing in `src/` ever built a
 * `SandboxTransport`: every path defaulted to `unconfiguredTransport`, which
 * refuses by design, so phases 4 and 5 were code-complete and zero of it could
 * execute. The client landed in #4661 and still nothing constructed it.
 *
 * ═══ AND IT IS THE FIRST CALLER OF THE POLICY ═══
 *
 * `collectorSandboxPolicy` existed and nothing used it — a grep for callers in
 * `src/` returned only docblock mentions. So the policy had never reached a
 * sandbox, and "the policy enforces" was true of the code that composes it and
 * of nothing that ran. The cases below assert the policy that arrives matches
 * the benchmark, because a transport carrying the WRONG cloud's allowlist is
 * worse than one carrying none: it would look enforced.
 *
 * @module unit/agentic/collector-constructs-the-transport
 */

const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({ env: mockEnv }));

/** Captures the config the real client would have been built with. */
const built: Array<Record<string, unknown>> = [];
jest.mock('@/lib/agentic/openshell/grpc-transport', () => ({
    grpcSandboxTransport: jest.fn((cfg: Record<string, unknown>) => {
        built.push(cfg);
        return {
            createSandbox: async () => {
                throw new Error('not reached in this suite');
            },
            execSandbox: async () => {
                throw new Error('not reached');
            },
            deleteSandbox: async () => ({ outcome: 'DELETION_OUTCOME_COMPLETED' }),
            awaitDeleted: async () => undefined,
            attachProvider: async () => undefined,
        };
    }),
}));

import {
    GATEWAY_WORKSPACE,
    gatewayTransportIsConfigured,
    sandboxedCollectorExec,
    transportFromEnv,
} from '@/app-layer/integrations/cloud-posture/sandboxed-collector-exec';
import { SandboxUnreachableError, type SandboxTransport } from '@/lib/agentic/openshell/transport';

const AWS = 'aws_compliance.benchmark.soc_2';
const GCP = 'gcp_compliance.benchmark.cis_v300';

function configure(): void {
    mockEnv.SANDBOX_RUNTIME_GATEWAY_ENDPOINT = '10.132.0.28:17670';
    mockEnv.SANDBOX_RUNTIME_CA_CERT_PATH = '/etc/inflect/openshell/ca.crt';
    mockEnv.SANDBOX_RUNTIME_CLIENT_CERT_PATH = '/etc/inflect/openshell/tls.crt';
    mockEnv.SANDBOX_RUNTIME_CLIENT_KEY_PATH = '/etc/inflect/openshell/tls.key';
}

beforeEach(() => {
    for (const k of Object.keys(mockEnv)) delete mockEnv[k];
    built.length = 0;
    jest.clearAllMocks();
});

describe('whether a transport can be built at all', () => {
    it('is NOT configured when the deploy names no client identity — today', () => {
        expect(gatewayTransportIsConfigured()).toBe(false);
        expect(transportFromEnv(AWS)).toBeNull();
    });

    it('needs ALL FOUR — a partial identity cannot authenticate', () => {
        const keys = [
            'SANDBOX_RUNTIME_GATEWAY_ENDPOINT',
            'SANDBOX_RUNTIME_CA_CERT_PATH',
            'SANDBOX_RUNTIME_CLIENT_CERT_PATH',
            'SANDBOX_RUNTIME_CLIENT_KEY_PATH',
        ] as const;
        // Each one missing in turn, so no single variable carries the decision.
        for (const omit of keys) {
            configure();
            delete mockEnv[omit];
            expect(gatewayTransportIsConfigured()).toBe(false);
            expect(transportFromEnv(AWS)).toBeNull();
        }
        configure();
        expect(gatewayTransportIsConfigured()).toBe(true);
    });

    it('an EMPTY value is not a value — compose delivers empty strings', () => {
        configure();
        mockEnv.SANDBOX_RUNTIME_CLIENT_KEY_PATH = '';
        expect(gatewayTransportIsConfigured()).toBe(false);
    });

    it('refuses to build without a benchmark — an unpoliced sandbox is not a narrower one', () => {
        /*
            `SandboxSpec` requires a policy and `collectorSandboxPolicy` is keyed
            by benchmark. Building without one would create a sandbox with no
            policy, which is not a smaller thing than the wrong policy.
        */
        configure();
        expect(transportFromEnv(undefined)).toBeNull();
        expect(built).toHaveLength(0);
    });
});

describe('what the constructed transport carries', () => {
    it('the paths, verbatim — a path, never a secret', () => {
        // Owner decision 2026-10-30: the key is a root-owned 0400 file
        // delivered out of band, so the environment names a PATH. A PEM in the
        // env file would make the key process-wide.
        configure();
        transportFromEnv(AWS);
        expect(built).toHaveLength(1);
        expect(built[0].endpoint).toBe('10.132.0.28:17670');
        expect(built[0].caCertPath).toBe('/etc/inflect/openshell/ca.crt');
        expect(built[0].clientCertPath).toBe('/etc/inflect/openshell/tls.crt');
        expect(built[0].clientKeyPath).toBe('/etc/inflect/openshell/tls.key');
        // Nothing resembling a PEM reached the config.
        expect(JSON.stringify(built[0])).not.toMatch(/BEGIN (RSA )?PRIVATE KEY/);
    });

    it('the ONE workspace, never all_workspaces', () => {
        // Measured: ListWorkspaces returned exactly `default`. A
        // cross-workspace read is one this product must never make.
        configure();
        transportFromEnv(GCP);
        expect(built[0].workspace).toBe(GATEWAY_WORKSPACE);
        expect(GATEWAY_WORKSPACE).toBe('default');
        expect(JSON.stringify(built[0])).not.toContain('all_workspaces');
    });

    it("the policy matches the BENCHMARK's cloud, not some default", () => {
        /*
            The first-caller claim, asserted. A transport carrying the wrong
            cloud's allowlist is worse than one carrying none, because it would
            look enforced: an AWS collector permitted to reach GCP's 38 hosts
            is a wider sandbox wearing a narrower policy's shape.
        */
        configure();
        transportFromEnv(AWS);
        transportFromEnv(GCP);
        expect(built).toHaveLength(2);
        const hostsOf = (i: number) =>
            ((built[i].policy as { networkPolicies: Array<{ host: string }> }).networkPolicies).map(
                (e) => e.host,
            );
        const aws = hostsOf(0);
        const gcp = hostsOf(1);
        expect(aws.every((h) => h.includes('amazonaws.com'))).toBe(true);
        expect(gcp.every((h) => h.includes('googleapis.com'))).toBe(true);
        // And neither leaks into the other.
        expect(aws.some((h) => h.includes('googleapis.com'))).toBe(false);
        expect(gcp.some((h) => h.includes('amazonaws.com'))).toBe(false);
    });

    it('every endpoint in the policy ENFORCES — no audit-mode entry rides along', () => {
        // `agent-sandbox-policy-review` is explicit that one endpoint in audit
        // mode fails H3.egress_enforced outright: "a policy is not partly
        // enforced; the agent reaches whatever the weakest endpoint allows."
        configure();
        transportFromEnv(AWS);
        const policy = built[0].policy as {
            networkPolicies: Array<{ enforcement: string }>;
        };
        expect(policy.networkPolicies.length).toBeGreaterThan(0);
        expect(
            policy.networkPolicies.every(
                (e) => e.enforcement === 'NETWORK_ENFORCEMENT_MODE_ENFORCE',
            ),
        ).toBe(true);
    });
});

describe('the runner uses it, and the injected seam still wins', () => {
    const run = (exec: ReturnType<typeof sandboxedCollectorExec>) =>
        exec('powerpipe', ['benchmark', 'run'], {} as NodeJS.ProcessEnv, [], []);

    it('builds one from the environment when the deploy is configured', async () => {
        configure();
        const exec = sandboxedCollectorExec({
            providerName: 'inflect-collector',
            benchmarkId: AWS,
            startGateway: async () => ({ outcome: 'already-running', waitedMs: 0 }),
        });
        const res = await run(exec);
        expect(built).toHaveLength(1);
        // It reached the transport, which refuses in this suite — so the
        // collection fails, which is the shape the ladder reads as ERROR.
        expect(res.ok).toBe(false);
    });

    it('an INJECTED transport wins over the environment', async () => {
        /*
            The test seam and the kill-switch drill's. It must not start
            depending on a deploy's environment — the drill runs in CI against a
            gateway that LIES, and a deploy-built transport would replace it.
        */
        configure();
        let reached = 0;
        const injected: SandboxTransport = {
            createSandbox: async () => {
                reached += 1;
                throw new SandboxUnreachableError('injected');
            },
            execSandbox: async () => {
                throw new Error('not reached');
            },
            deleteSandbox: async () => ({ outcome: 'DELETION_OUTCOME_COMPLETED' }),
            awaitDeleted: async () => undefined,
            attachProvider: async () => undefined,
        };
        const exec = sandboxedCollectorExec({
            providerName: 'inflect-collector',
            benchmarkId: AWS,
            transport: injected,
            startGateway: async () => ({ outcome: 'already-running', waitedMs: 0 }),
        });
        await run(exec);
        expect(reached).toBe(1);
        // Nothing was built from the environment at all.
        expect(built).toHaveLength(0);
    });

    it('falls back to the REFUSING transport when unconfigured, unchanged', async () => {
        // The refusing default is load-bearing: a deploy that turned the switch
        // on without a gateway gets SANDBOX_UNREACHABLE on every collection,
        // which the ladder reports as ERROR.
        const exec = sandboxedCollectorExec({
            providerName: 'inflect-collector',
            benchmarkId: AWS,
            startGateway: async () => ({ outcome: 'already-running', waitedMs: 0 }),
        });
        const res = await run(exec);
        expect(built).toHaveLength(0);
        expect(res.ok).toBe(false);
        expect((res.failure ?? '') + res.stderr).toMatch(/SANDBOX_UNREACHABLE|unreachable/i);
    });

    it('builds PER CALL, so a rotated key is picked up without a restart', async () => {
        // The paths are read at construction, and construction happens inside
        // the run. A key rotated on disk — which the regenerable-PKI decision
        // makes a routine act — reaches the next collection.
        configure();
        const exec = sandboxedCollectorExec({
            providerName: 'inflect-collector',
            benchmarkId: AWS,
            startGateway: async () => ({ outcome: 'already-running', waitedMs: 0 }),
        });
        await run(exec);
        await run(exec);
        expect(built).toHaveLength(2);
    });
});
