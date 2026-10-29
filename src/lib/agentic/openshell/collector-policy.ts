/**
 * The sandbox policy for the Powerpipe collectors — 4.1 (#3961), D3's first
 * internal workload.
 *
 * ═══ WHAT THIS CAN AND CANNOT CLAIM ═══
 *
 * 4.1 asks for `network_policies` allowing "only the cloud provider API hosts
 * the benchmark needs". That set is NOT derivable from this repository, and
 * saying so is more useful than a list that looks precise:
 *
 *   - neither collector names a cloud host. Both `execFile` a third-party
 *     binary, and Powerpipe resolves endpoints through the AWS/GCP/Azure SDKs
 *     at run time, per region and per service the benchmark happens to touch;
 *   - a grep for `amazonaws.com`, `googleapis.com` and `azure.com` across both
 *     call sites and the whole `cloud-posture/` tree returns NOTHING.
 *
 * So what follows is a PROVIDER-SCOPED allowlist: narrower than unrestricted
 * egress by a wide margin, wider than per-service. It is derived from the
 * benchmark id's provider prefix, and the honest way to narrow it further is to
 * measure a real run's denials — which needs a deployed gateway, and must not
 * be done by shipping audit mode, because `agent-sandbox-policy-review` is
 * explicit that one endpoint in audit mode fails `H3.egress_enforced` outright:
 * "a policy is not partly enforced; the agent reaches whatever the weakest
 * endpoint allows."
 *
 * ═══ EVERY ENDPOINT CARRIES enforcement EXPLICITLY ═══
 *
 * `NETWORK_ENFORCEMENT_MODE_UNSPECIFIED` is zero on the wire and documented as
 * "log violations and allow traffic". An endpoint that omits the field, an
 * endpoint whose field a proxy dropped, and an endpoint explicitly set to audit
 * are therefore the same bytes — and all three are audit mode. The field is
 * written on every endpoint by construction below, and a test asserts it for
 * each one rather than for the policy as a whole.
 */

export const COLLECTOR_PROVIDERS = ['aws', 'azure', 'gcp'] as const;
export type CollectorProvider = (typeof COLLECTOR_PROVIDERS)[number];

/** Enforcement modes, spelled as the gateway spells them. */
export type NetworkEnforcement = 'NETWORK_ENFORCEMENT_MODE_ENFORCE';

export interface PolicyEndpoint {
    readonly host: string;
    /** Always present. The zero value means audit, so an absent field is a hole. */
    readonly enforcement: NetworkEnforcement;
    readonly reason: string;
}

export interface CollectorSandboxPolicy {
    readonly provider: CollectorProvider;
    readonly networkPolicies: readonly PolicyEndpoint[];
    readonly landlock: { readonly compatibility: 'hard_requirement' };
    readonly filesystem: {
        readonly rootReadOnly: true;
        /** The single writable path. Powerpipe needs somewhere for its mod cache. */
        readonly scratchDir: string;
    };
    readonly runAs: { readonly user: string; readonly allowRoot: false };
}

/** The scratch path, named once so the policy and the exec agree. */
export const COLLECTOR_SCRATCH_DIR = '/var/tmp/powerpipe';

/** Non-root, and pinned: `run_as` root would make the read-only root advisory. */
export const COLLECTOR_RUN_AS_USER = '65532';

/**
 * Which cloud a benchmark belongs to, from its id prefix
 * (`azure_compliance.benchmark.soc_2` → `azure`).
 *
 * REFUSES an unrecognised prefix rather than defaulting. A default would hand
 * one cloud's allowlist to another cloud's benchmark, which is an egress policy
 * that permits the wrong hosts and denies the right ones — the failure would
 * look like a broken collector and be read as a network problem.
 */
export function providerOfBenchmark(benchmarkId: string): CollectorProvider {
    const prefix = benchmarkId.split('_')[0];
    const match = COLLECTOR_PROVIDERS.find((p) => p === prefix);
    if (match === undefined) {
        throw new Error(
            `cannot derive a cloud provider from benchmark id "${benchmarkId}": ` +
                `expected one of ${COLLECTOR_PROVIDERS.join(', ')} as the prefix`,
        );
    }
    return match;
}

/**
 * The hosts each provider's SDKs reach. Wildcards are per-provider API domains,
 * not per-service, for the reason in the docblock above.
 */
const PROVIDER_ENDPOINTS: Readonly<Record<CollectorProvider, ReadonlyArray<{ host: string; reason: string }>>> = {
    aws: [
        { host: '*.amazonaws.com', reason: 'service APIs the benchmark queries, region-resolved by the SDK' },
        { host: 'sts.amazonaws.com', reason: 'credential identity resolution before any service call' },
    ],
    azure: [
        { host: 'management.azure.com', reason: 'the ARM control plane every azure_compliance control reads' },
        { host: 'login.microsoftonline.com', reason: 'token acquisition for the service principal' },
    ],
    //
    // ═══ EXPLICIT PER-SERVICE, NOT `*.googleapis.com` (4.1, #3961) ═══
    //
    // DERIVED, not guessed. The GCP collector runs Powerpipe over the steampipe
    // GCP plugin, and that plugin builds every API client it will ever use in
    // one file — `gcp/service.go` — so the services it queries are enumerable
    // from its imports: 35 under `google.golang.org/api/<service>/v*` plus
    // `aiplatform` and `redis` under `cloud.google.com/go`. A cross-check
    // against its 123 `table_gcp_*.go` files found no service family outside
    // that set.
    //
    // 4.1 recorded that the per-service host set "is not derivable from this
    // repository", and that stays true — it is derivable from the PLUGIN's
    // repository, which is a different claim and the one that closes this.
    //
    // ═══ WHAT THIS CLOSES, AND THE HALF IT CANNOT ═══
    //
    // 4.4 (#4409) pinned that `*.googleapis.com` admitted two inference hosts.
    // The explicit list drops `generativelanguage.googleapis.com` outright.
    //
    // It CANNOT drop `aiplatform.googleapis.com`, and the reason is worth
    // stating rather than leaving as an apparent oversight: the plugin has
    // Vertex AI tables and audits its configuration, and Vertex AI serves
    // configuration reads and `:predict` / `:generateContent` inference ON THE
    // SAME HOST. So no host-level allowlist can permit the audit and deny the
    // inference — they are one origin. Closing that needs an L7 rule on method
    // and path, which this gateway does support
    // (`host:port:METHOD:path_glob`), and which needs a real run's paths to
    // write safely. Recorded as the residual rather than implied away.
    //
    // ═══ THE FAILURE MODE IF THIS LIST IS WRONG ═══
    //
    // A service the plugin needs and this list omits makes that query fail,
    // which fails the collection CLOSED — `ERROR`, never a quiet `PASSED` —
    // because that is the existing check semantics. So an incomplete list is
    // observable rather than silent, which is what makes narrowing from a
    // derived set an acceptable risk instead of a guess.
    gcp: [
        { host: 'accessapproval.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'alloydb.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'apikeys.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'appengine.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'artifactregistry.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'bigquery.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'bigtableadmin.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'billingbudgets.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'cloudasset.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'cloudbilling.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'cloudfunctions.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'cloudidentity.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'cloudkms.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'cloudresourcemanager.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'composer.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'compute.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'container.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'dataplex.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'dataproc.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'dns.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'essentialcontacts.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'firestore.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'iam.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'logging.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'metastore.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'monitoring.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'pubsub.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'run.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'secretmanager.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'serviceusage.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'sqladmin.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'storage.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'tpu.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'vpcaccess.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'workstations.googleapis.com', reason: 'queried by the GCP plugin' },
        // Vertex AI: audited for configuration, and the same origin serves
        // inference. See the note above — this entry is the residual.
        { host: 'aiplatform.googleapis.com', reason: 'Vertex AI config audited; same origin serves inference (L7 residual)' },
        { host: 'redis.googleapis.com', reason: 'queried by the GCP plugin' },
        { host: 'oauth2.googleapis.com', reason: 'token acquisition for the service account' },
    ],
};

/** Build the policy for one benchmark. Every endpoint enforces, by construction. */
export function collectorSandboxPolicy(benchmarkId: string): CollectorSandboxPolicy {
    const provider = providerOfBenchmark(benchmarkId);
    return {
        provider,
        networkPolicies: PROVIDER_ENDPOINTS[provider].map((e) => ({
            host: e.host,
            // Written here, for every endpoint, with no branch that can omit it.
            enforcement: 'NETWORK_ENFORCEMENT_MODE_ENFORCE',
            reason: e.reason,
        })),
        landlock: { compatibility: 'hard_requirement' },
        filesystem: { rootReadOnly: true, scratchDir: COLLECTOR_SCRATCH_DIR },
        runAs: { user: COLLECTOR_RUN_AS_USER, allowRoot: false },
    };
}
