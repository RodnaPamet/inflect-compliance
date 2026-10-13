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

/**
 * The Powerpipe benchmark the collector runs. Both shorthands resolve to
 * `all_controls` (#3434) — deliberately NOT the vendor's own SOC 2 / CIS
 * benchmarks, and this is the load-bearing comment on that choice.
 *
 * A CIS benchmark declares its OWN controls, named for the CIS item
 * (`cis_v200_6_1`), which merely reuse the shared service query. The control
 * ids our crosswalk maps are those shared controls, and they live under
 * `all_controls`. So a `cis_v200` run matched 0 of our 13 ids and minted
 * ZERO evidence — silently, because an unmapped control is simply skipped.
 * Azure has no SOC benchmark at ANY version — 774 benchmarks, no `soc_*` family — so the old `azure_compliance.benchmark.soc_2` named nothing at all.
 *
 * The vendor's badge is not what makes this SOC 2 evidence: the crosswalk in
 * `src/data/integrations/azure-posture-control-map.ts` IS the mapping layer
 * and carries the SOC 2 / NIST CSF codes itself. So run the widest root whose
 * ids the crosswalk speaks (11/13, 476 controls) and let the crosswalk decide what each
 * result evidences. Owner decision 2026-10-11.
 *
 * The shorthands are kept because `checkType` still carries one; they no
 * longer select different benchmarks. `tests/guards/aws-posture-connector.test.ts`
 * asserts every mapped id resolves against the vendored snapshot.
 */
const ALL_CONTROLS = 'azure_compliance.benchmark.all_controls';
const BENCHMARKS: Record<string, string> = {
    soc2: ALL_CONTROLS,
    cis: ALL_CONTROLS,
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
    readonly mappingVerifiedBy =
        // #3434 — proving run against a live Azure subscription on 2026-10-13.
        // Powerpipe v1.5.5 + steampipe v2.4.7 + azure plugin v1.16.0, mod
        // v2.5.2. Three mapped controls run for real and their JSON fed
        // through THIS product's `parsePowerpipeBenchmarkJson` and crosswalk:
        // 3/3 resolved. `iam_subscription_owner_max_3` returned real data
        // (ok, "1 owner(s) associated."); the other two returned zero rows.
        //
        // It also confirmed two shapes that were previously source-derived
        // rather than observed: the live `control_id` is `control.<name>`, NOT
        // `<mod>.control.<name>` as every fixture spells it — handled by
        // `shortControlName`'s last-segment fallback rather than its
        // `.control.` marker — and an empty control really does render
        // `results: null` beside an all-zero summary.
        //
        // SCOPE, precisely: this verifies the MAPPING against the vendor, which
        // is what this field claims. It did NOT exercise `runPowerpipeBenchmark`
        // spawning the collector CLI; powerpipe was invoked by hand and its
        // output fed to the parser. No collector host exists yet (#3458 census:
        // zero posture connections configured anywhere).
        '#3434 — live Azure run 2026-10-13: 3/3 mapped controls resolved through the parser and crosswalk';
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
