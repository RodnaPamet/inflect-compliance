/**
 * azure-posture provider (PR-3) — Azure cloud-posture compliance evidence.
 *
 * Engine: Powerpipe + the Apache-2.0 `steampipe-mod-azure-compliance` mod,
 * invoked as an EXTERNAL CLI. We consume its JSON and apply an ORIGINAL thin
 * control map (`azure-posture-control-map.ts`) — no HCL/SQL is ported.
 *
 * SECURITY: read-only service-principal credentials, passed via ENV, never
 * argv. Secrets scrubbed from any captured output.
 */
import type {
    ScheduledCheckProvider,
    ConnectionConfigSchema,
    ConnectionValidationResult,
    CheckInput,
    CheckResult,
    EvidencePayload,
} from '../types';
import { runPowerpipeBenchmark, type RunBenchmarkInput } from '../cloud-posture/powerpipe-core';

export interface AzurePostureSecrets {
    clientId?: string;
    clientSecret?: string;
}
export interface AzurePostureConfig {
    benchmark?: string;
    tenantId?: string;
    subscriptionId?: string;
}

const BENCHMARKS: Record<string, string> = {
    soc2: 'azure_compliance.benchmark.soc_2',
    cis: 'azure_compliance.benchmark.cis_v200',
};

const AZURE_CREDENTIAL_PATTERNS: RegExp[] = [
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, // tenant/subscription/client GUIDs
];

function buildEnv(secrets: AzurePostureSecrets, config: AzurePostureConfig): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (config.tenantId) env.AZURE_TENANT_ID = config.tenantId;
    if (config.subscriptionId) env.AZURE_SUBSCRIPTION_ID = config.subscriptionId;
    if (secrets.clientId) env.AZURE_CLIENT_ID = secrets.clientId;
    if (secrets.clientSecret) env.AZURE_CLIENT_SECRET = secrets.clientSecret;
    return env;
}

export class AzurePostureProvider implements ScheduledCheckProvider {
    readonly id = 'azure-posture';
    readonly displayName = 'Azure Cloud Posture';
    readonly description = 'Run a CIS / SOC 2 benchmark against an Azure subscription (read-only) and collect per-control evidence.';
    readonly supportedChecks = ['soc2', 'cis'];
    // P2 — validateConnection only checks field presence (no live Azure call).
    readonly liveValidation = false;
    // #3431 — nothing in this repo records a live mapping run for this
    // provider. A claim about the record, not about the vendor.
    readonly mappingVerifiedBy = null;
    readonly setupGuide =
        'Runs Powerpipe on the collector host against an Azure subscription. Register an app (service principal) with the Reader role on the subscription, and provide its tenant id, subscription id, client id + secret. Test connection validates field shape only — it does not call Azure live.';

    readonly configSchema: ConnectionConfigSchema = {
        configFields: [
            { key: 'benchmark', label: 'Benchmark', type: 'select', required: true, options: ['soc2', 'cis'] },
            { key: 'tenantId', label: 'Azure AD tenant id', type: 'string', required: true },
            { key: 'subscriptionId', label: 'Subscription id', type: 'string', required: true },
        ],
        secretFields: [
            { key: 'clientId', label: 'Service-principal client id', type: 'string', required: true },
            { key: 'clientSecret', label: 'Service-principal client secret', type: 'string', required: true },
        ],
    };

    /** Test seam — inject the Powerpipe runner instead of shelling out. */
    private readonly exec?: RunBenchmarkInput['exec'];
    constructor(deps: { exec?: RunBenchmarkInput['exec'] } = {}) {
        this.exec = deps.exec;
    }

    static benchmarkId(shorthand: string | undefined): string {
        return BENCHMARKS[(shorthand ?? 'soc2').toLowerCase()] ?? BENCHMARKS.soc2;
    }

    async validateConnection(config: Record<string, unknown>, secrets: Record<string, unknown>): Promise<ConnectionValidationResult> {
        const c = config as AzurePostureConfig;
        const s = secrets as AzurePostureSecrets;
        if (!c.tenantId || !c.subscriptionId) return { valid: false, error: 'Azure tenant id + subscription id are required.' };
        if (!s.clientId || !s.clientSecret) return { valid: false, error: 'A service-principal client id + secret are required.' };
        return { valid: true };
    }

    async runCheck(input: CheckInput): Promise<CheckResult> {
        const cfg = input.connectionConfig as AzurePostureConfig & AzurePostureSecrets;
        const secrets: AzurePostureSecrets = { clientId: cfg.clientId, clientSecret: cfg.clientSecret };
        const benchmarkId = AzurePostureProvider.benchmarkId(cfg.benchmark ?? input.parsed.checkType);
        const env = buildEnv(secrets, cfg);
        const secretValues = [secrets.clientSecret].filter((v): v is string => !!v);
        const { summaryObj: _s, ...result } = await runPowerpipeBenchmark({ benchmarkId, env, secretValues, patterns: AZURE_CREDENTIAL_PATTERNS, exec: this.exec });
        return result;
    }

    mapResultToEvidence(input: CheckInput, result: CheckResult): EvidencePayload | null {
        if (result.status === 'ERROR') return null;
        return { title: `Azure posture — ${input.parsed.checkType}`, content: result.summary, type: 'CONFIGURATION', category: `azure-posture:${input.parsed.checkType}` };
    }
}
