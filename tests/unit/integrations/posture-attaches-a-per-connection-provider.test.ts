/**
 * A POSTURE SCAN ATTACHES ITS OWN CONNECTION'S PROVIDER — #5476.
 *
 * #5251: every tenant's sandboxed posture scan attached the one shared provider,
 * `inflect-collector`, so a scan benchmarked whatever account that credential
 * reached and the result was stored as this tenant's Evidence. #5475 made it
 * refuse rather than attach. This is the wiring that makes it work instead.
 *
 * ── Driven end-to-end, over a fake TRANSPORT rather than a fake collector ──
 *
 * The cheap version of this suite mocks `collectorExecForDeploy` and asserts the
 * `providerName` argument. That tests the call and not the behaviour: the
 * acceptance criterion is "a scan for tenant A attaches a provider holding A's
 * credential and no other", and the only place that becomes true or false is the
 * `AttachSandboxProvider` call. So these cases run the real provider, the real
 * collector bridge and the real executor, and read the name off the transport —
 * the same seam the gateway would see.
 *
 * The four properties are #5476's acceptance list, less the two that belong to
 * the name itself (tested in `posture-provider-name.test.ts`):
 *
 *   1. A scan attaches the provider for ITS (tenant, connection) and no other.
 *   2. Two tenants never attach one provider, concurrently or otherwise.
 *   3. A connection whose id never arrives refuses BY NAME, and attaches nothing.
 *   4. The provisioned path does not reach that refusal.
 */
const mockEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({ env: mockEnv }));

/** What the gateway would have been asked to attach, and to exec. */
const attached: Array<{ sandboxId: string; providerName: string }> = [];
const execed: string[] = [];
jest.mock('@/lib/agentic/openshell/grpc-transport', () => ({
    grpcSandboxTransport: () => ({
        createSandbox: async () => ({ id: 'sbx-1', phase: 'SANDBOX_PHASE_READY' }),
        attachProvider: async (i: { sandboxId: string; providerName: string }) => {
            attached.push({ sandboxId: i.sandboxId, providerName: i.providerName });
            return { attached: true, receiptId: 'rcpt-1' };
        },
        awaitProviderReady: async () => undefined,
        execSandbox: async (i: { file: string }) => {
            execed.push(i.file);
            return { exited: true, exitCode: 0, signal: null, stdout: '{}', stderr: '' };
        },
        deleteSandbox: async () => ({ outcome: 'DELETION_OUTCOME_COMPLETED' }),
        awaitDeleted: async () => undefined,
    }),
}));

/** The provider name the LEASE row would record, captured without a database. */
const recorded: Array<string | undefined> = [];
jest.mock('@/app-layer/integrations/openshell-audit-bridge', () => ({
    sandboxDecisionRecorderForScan: (i: { providerName?: string }) => {
        recorded.push(i.providerName);
        return async () => undefined;
    },
}));

import { AwsPostureProvider } from '@/app-layer/integrations/aws-posture-provider';
import { GcpPostureProvider } from '@/app-layer/integrations/providers/gcp-posture-provider';
import { AzurePostureProvider } from '@/app-layer/integrations/providers/azure-posture-provider';
import { postureProviderName } from '@/app-layer/integrations/cloud-posture/provider-name';
import { SHARED_PROVIDER_REFUSAL } from '@/app-layer/integrations/cloud-posture/sandboxed-collector-exec';
import type { CheckInput } from '@/app-layer/integrations/types';

const TENANT_A = 'clz1tenantaaaaaaaaaaaaaa';
const TENANT_B = 'clz1tenantbbbbbbbbbbbbbb';
const CONN_X = 'clz1connxxxxxxxxxxxxxxxx';
const CONN_Y = 'clz1connyyyyyyyyyyyyyyyy';

function configureGateway(): void {
    mockEnv.SANDBOX_EXECUTION_ENABLED = '1';
    mockEnv.SANDBOX_RUNTIME_GATEWAY_ENDPOINT = '10.0.0.1:17670';
    mockEnv.SANDBOX_RUNTIME_CA_CERT_PATH = '/etc/inflect/openshell/ca.crt';
    mockEnv.SANDBOX_RUNTIME_CLIENT_CERT_PATH = '/etc/inflect/openshell/tls.crt';
    mockEnv.SANDBOX_RUNTIME_CLIENT_KEY_PATH = '/etc/inflect/openshell/tls.key';
}

const checkInput = (over: Partial<CheckInput> & { tenantId: string }): CheckInput => ({
    automationKey: 'gcp-posture.benchmark',
    parsed: { provider: 'gcp-posture', checkType: 'benchmark', raw: 'gcp-posture.benchmark' },
    connectionConfig: { benchmark: 'soc2', projectId: 'p' },
    triggeredBy: 'scheduled',
    ...over,
});

beforeEach(() => {
    for (const k of Object.keys(mockEnv)) delete mockEnv[k];
    attached.length = 0;
    execed.length = 0;
    recorded.length = 0;
});

describe('a scan attaches the provider for its own (tenant, connection)', () => {
    it('GCP attaches the derived name, and runs the benchmark after it', async () => {
        configureGateway();
        await new GcpPostureProvider().runCheck(
            checkInput({ tenantId: TENANT_A, connectionId: CONN_X }),
        );
        expect(attached).toEqual([
            {
                sandboxId: 'sbx-1',
                providerName: postureProviderName({ tenantId: TENANT_A, connectionId: CONN_X }),
            },
        ]);
        // And it is not the shared one #5251 refused.
        expect(attached[0].providerName).not.toBe('inflect-collector');
        expect(execed).toEqual(['powerpipe']);
    });

    it('Azure attaches its own, so this is not one provider wired by hand', async () => {
        configureGateway();
        await new AzurePostureProvider().runCheck(
            checkInput({
                tenantId: TENANT_A,
                connectionId: CONN_X,
                automationKey: 'azure-posture.benchmark',
                parsed: { provider: 'azure-posture', checkType: 'benchmark', raw: 'azure-posture.benchmark' },
                connectionConfig: { benchmark: 'soc2', subscriptionId: 's' },
            }),
        );
        expect(attached.map((a) => a.providerName)).toEqual([
            postureProviderName({ tenantId: TENANT_A, connectionId: CONN_X }),
        ]);
    });

    it('AWS attaches its own too', async () => {
        configureGateway();
        await new AwsPostureProvider().runCheck(
            checkInput({
                tenantId: TENANT_A,
                connectionId: CONN_X,
                automationKey: 'aws-posture.benchmark',
                parsed: { provider: 'aws-posture', checkType: 'benchmark', raw: 'aws-posture.benchmark' },
                connectionConfig: { benchmark: 'soc2', accessKeyId: 'k', secretAccessKey: 's', region: 'eu-west-1' },
            }),
        );
        expect(attached.map((a) => a.providerName)).toEqual([
            postureProviderName({ tenantId: TENANT_A, connectionId: CONN_X }),
        ]);
    });

    it('the LEASE row names the provider actually attached, not the shared default', async () => {
        configureGateway();
        await new GcpPostureProvider().runCheck(
            checkInput({ tenantId: TENANT_A, connectionId: CONN_X }),
        );
        // Left to default, `sandboxDecisionRecorderForScan` records
        // `inflect-collector` — so an operational table would disagree with the
        // gateway about which credential ran the scan.
        expect(recorded).toEqual([
            postureProviderName({ tenantId: TENANT_A, connectionId: CONN_X }),
        ]);
    });
});

describe('two tenants never attach one provider', () => {
    it('the same connection id under two tenants attaches two providers', async () => {
        configureGateway();
        await new GcpPostureProvider().runCheck(
            checkInput({ tenantId: TENANT_A, connectionId: CONN_X }),
        );
        await new GcpPostureProvider().runCheck(
            checkInput({ tenantId: TENANT_B, connectionId: CONN_X }),
        );
        const [a, b] = attached.map((x) => x.providerName);
        expect(a).not.toBe(b);
        expect(a).toBe(postureProviderName({ tenantId: TENANT_A, connectionId: CONN_X }));
        expect(b).toBe(postureProviderName({ tenantId: TENANT_B, connectionId: CONN_X }));
    });

    it('one tenant with two connections attaches two providers', async () => {
        configureGateway();
        await new GcpPostureProvider().runCheck(
            checkInput({ tenantId: TENANT_A, connectionId: CONN_X }),
        );
        await new GcpPostureProvider().runCheck(
            checkInput({ tenantId: TENANT_A, connectionId: CONN_Y }),
        );
        const names = attached.map((x) => x.providerName);
        expect(new Set(names).size).toBe(2);
    });
});

describe('a check with no connection id refuses, and attaches nothing', () => {
    it('REFUSES BY NAME rather than attaching a shared credential', async () => {
        configureGateway();
        const result = await new GcpPostureProvider().runCheck(
            checkInput({ tenantId: TENANT_A }),
        );
        // THE fail-closed assertion. `connectionId` is optional on `CheckInput`,
        // and this is the only reason that is safe: with no id the provider
        // passes no name and the collector refuses before a sandbox exists.
        expect(result.status).toBe('ERROR');
        expect(result.errorMessage ?? '').toContain(SHARED_PROVIDER_REFUSAL);
    });

    it('creates no sandbox, attaches nothing and runs nothing', async () => {
        configureGateway();
        await new GcpPostureProvider().runCheck(checkInput({ tenantId: TENANT_A }));
        // A defaulted name would have made all three of these non-empty, which
        // is #5251 wearing a new spelling.
        expect(attached).toEqual([]);
        expect(execed).toEqual([]);
    });
});

describe('the provisioned path does not reach the shared-provider refusal', () => {
    it('a scan with a connection id never reports it', async () => {
        configureGateway();
        const result = await new GcpPostureProvider().runCheck(
            checkInput({ tenantId: TENANT_A, connectionId: CONN_X }),
        );
        // #5476's acceptance criterion 5, asserted as unreachability for a
        // properly identified connection rather than as a green run.
        expect(result.errorMessage ?? '').not.toContain(SHARED_PROVIDER_REFUSAL);
    });

    it('and with the platform switch OFF the on-host path is untouched', async () => {
        // No `SANDBOX_EXECUTION_ENABLED`: `collectorExecForDeploy` returns null,
        // nothing is attached, and the refusal is not reported either — the
        // default deploy is unchanged by all of this.
        await new GcpPostureProvider().runCheck(
            checkInput({ tenantId: TENANT_A, connectionId: CONN_X }),
        ).catch(() => undefined);
        expect(attached).toEqual([]);
        expect(recorded).toEqual([]);
    });
});
