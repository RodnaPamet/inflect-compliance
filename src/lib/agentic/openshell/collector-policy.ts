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
/**
 * The ONE AWS region the operator boundary permits — #4569.
 *
 * A deployment constant, not a parameter. 124 of the AWS endpoints are
 * `<prefix>.<region>.amazonaws.com`, so the policy has to name a region; making
 * it an argument would change `collectorSandboxPolicy`'s signature, and that
 * signature's stability is itself a recorded tripwire for #3966's deferred
 * per-residency-class backstop.
 *
 * `eu-west-1` matches the placeholder the AWS connection form already shows and
 * this product's EU residency posture. A connection configured elsewhere fails
 * CLOSED: the host is absent from the policy, so the query fails and the
 * collection reports ERROR rather than a quiet PASSED.
 */
export const COLLECTOR_AWS_REGION = 'eu-west-1';

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
    //
    // ═══ EXPLICIT PER-SERVICE, NOT `*.amazonaws.com` (#4569) ═══
    //
    // The wildcard was not merely unprovable, it was MASKING a real failure.
    // `openshell-prover` declined to decide a policy mixing `*.amazonaws.com`
    // with `sts.amazonaws.com` — "overlapping exact and wildcard endpoints with
    // different implicit destination IP modes" — and the issue recorded that as
    // `unsupported`. Removing the redundant exact host to settle the shape
    // changed the verdict to `exceeds_boundary`, with a counterexample:
    //
    //     host a.amazonaws.com, destination_ip 8.8.8.8
    //
    // So the policy really did permit more than the operator boundary, and the
    // shape complaint had been standing in front of that.
    //
    // ═══ DERIVED FROM TWO PINNED SOURCES, NOTHING HAND-WRITTEN ═══
    //
    // The same method that fixed GCP, and it had to be: 33 of these prefixes
    // differ from the plugin's own package name, so a hand mapping would have
    // been wrong 33 times. `cloudwatch` is `monitoring`, `cloudwatchlogs` is
    // `logs`, `costexplorer` is `ce`, `ecr` is `api.ecr`.
    //
    //   PREFIX      aws-sdk-go-v2 @ 407b01fa1982d76a380501a2862a6d4d1c475db0
    //               service/<pkg>/internal/endpoints/endpoints.go, the template
    //               whose suffix is `amazonaws.com` — NOT the first one listed.
    //               S3 lists its dual-stack template first, so "first Hostname"
    //               yielded `s3.dualstack` and would have denied every S3
    //               control. The 141 service packages come from the plugin's
    //               own `aws/service.go`, which builds every client it can use.
    //
    //   REGIONAL?   botocore `endpoints.json`, keyed by endpoint prefix:
    //               `isRegionalized: false` means one global host. Eleven are.
    //               Three services it does not list are treated as regional,
    //               which is what their own SDK template says.
    //
    // ═══ ONE REGION, AND THAT IS THE BOUNDARY'S STATEMENT ═══
    //
    // 124 of these are `<prefix>.<region>.amazonaws.com`. The region is a
    // DEPLOYMENT CONSTANT rather than a parameter, which keeps
    // `collectorSandboxPolicy` a pure function of the benchmark — a property
    // `flue-provider-is-never-set-per-run` asserts by ARITY, deliberately, as
    // the tripwire for #3966's deferred per-residency-class backstop. A region
    // parameter would have tripped that guard for an unrelated reason.
    //
    // A connection configured for a different region fails CLOSED — the host is
    // not in the policy, so the query fails and the collection reports ERROR,
    // never a quiet PASSED. That is the same observable-failure argument the
    // GCP list rests on, and it is what makes one region an honest default
    // rather than a silent restriction.
    aws: [
        { host: 'account.amazonaws.com', reason: 'global endpoint, queried by the AWS plugin' },
        { host: 'budgets.amazonaws.com', reason: 'global endpoint, queried by the AWS plugin' },
        { host: 'ce.amazonaws.com', reason: 'global endpoint, queried by the AWS plugin' },
        { host: 'cloudfront.amazonaws.com', reason: 'global endpoint, queried by the AWS plugin' },
        { host: 'health.amazonaws.com', reason: 'global endpoint, queried by the AWS plugin' },
        { host: 'iam.amazonaws.com', reason: 'global endpoint, queried by the AWS plugin' },
        { host: 'organizations.amazonaws.com', reason: 'global endpoint, queried by the AWS plugin' },
        { host: 'route53.amazonaws.com', reason: 'global endpoint, queried by the AWS plugin' },
        { host: 'savingsplans.amazonaws.com', reason: 'global endpoint, queried by the AWS plugin' },
        { host: 'shield.amazonaws.com', reason: 'global endpoint, queried by the AWS plugin' },
        { host: 'waf.amazonaws.com', reason: 'global endpoint, queried by the AWS plugin' },
        { host: `access-analyzer.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `acm.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `acm-pca.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `amplify.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `api.ecr.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `api.ecr-public.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `api.pricing.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `api.sagemaker.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `apigateway.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `appconfig.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `application-autoscaling.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `apprunner.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `appstream2.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `appsync.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `athena.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `auditmanager.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `autoscaling.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `backup.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `batch.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `bedrock.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `bedrock-agent.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `bedrock-agentcore-control.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `cassandra.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `cloudcontrolapi.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `cloudformation.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `cloudsearch.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `cloudtrail.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `codeartifact.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `codebuild.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `codecommit.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `codedeploy.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `codepipeline.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `codestar-notifications.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `cognito-identity.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `cognito-idp.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `config.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `connect.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `cost-optimization-hub.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `datasync.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `dax.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `directconnect.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `dlm.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `dms.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `drs.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `ds.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `dynamodb.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `ec2.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `ecs.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `eks.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `elasticache.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `elasticbeanstalk.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `elasticfilesystem.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `elasticloadbalancing.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `elasticmapreduce.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `email.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `es.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `events.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `firehose.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `fms.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `fsx.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `glacier.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `globalaccelerator.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `glue.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `guardduty.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `identitystore.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `ingest.timestream.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `inspector.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `inspector2.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `iot.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `kafka.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `kafkaconnect.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `kinesis.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `kinesisanalytics.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `kinesisvideo.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `kms.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `lakeformation.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `lambda.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `lightsail.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `logs.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `macie2.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `mediastore.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `memory-db.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `mgn.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `monitoring.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `mq.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `network-firewall.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `oam.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `pinpoint.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `pipes.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `quicksight.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `ram.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `rds.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `redshift.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `redshift-serverless.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `resource-explorer-2.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `rolesanywhere.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `route53domains.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `route53resolver.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `s3.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `s3-control.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `s3tables.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `scheduler.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `secretsmanager.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `securityhub.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `securitylake.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `serverlessrepo.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `servicecatalog.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `servicediscovery.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `servicequotas.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `sns.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `sqs.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `ssm.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `ssm-incidents.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `sso.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `states.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `sts.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `support.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `synthetics.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `tagging.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `transfer.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `waf-regional.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `wafv2.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `wellarchitected.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
        { host: `workspaces.${COLLECTOR_AWS_REGION}.amazonaws.com`, reason: 'queried by the AWS plugin' },
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
