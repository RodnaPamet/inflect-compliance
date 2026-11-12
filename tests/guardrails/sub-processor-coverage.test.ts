/**
 * Sub-processor coverage ratchet.
 *
 * Keeps the sub-processor inventory (docs/sub-processors.md) honest and
 * complete — it's a customer-facing legal artefact, so a sub-processor
 * present in code but missing from the doc is a compliance gap.
 *
 * Enforces:
 *   - the inventory + DPA template + change policy exist with their
 *     required structure;
 *   - every env var in src/env.ts that names an external service appears
 *     in the inventory, OR is in the non-sub-processor allowlist (so a
 *     NEW external-service env var forces a triage decision);
 *   - every tenant-optional integration provider is in the inventory.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';
import { mdSection } from '../helpers/markdown-regions';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

const SUBPROC = 'docs/sub-processors.md';
const DPA = 'docs/data-processing-agreement-template.md';
const POLICY = 'docs/sub-processor-change-policy.md';


/**
 * The document's ATX heading lines at ONE level, fenced blocks excluded.
 *
 * For the assertions whose subject IS the section structure — "the DPA
 * template has 15 numbered sections". `^##\s+7\.` against the whole document
 * is satisfied by a numbered line anywhere with two hashes in front of it;
 * against the level-2 heading lines only a heading satisfies it.
 *
 * `level` is a parameter because these assertions all mean `##`, and because
 * `tests/helpers/assertion-reach.ts` tells a narrowing from a mask by arity
 * — see the fuller note in `tests/guardrails/date-picker-guide.test.ts`.
 */
function headingLines(md: string, level: number): string {
    const out: string[] = [];
    const marker = new RegExp(`^#{${level}}\\s`);
    let open: string | null = null;
    for (const line of md.split('\n')) {
        const fence = /^\s*(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (open === null) open = fence[1][0];
            else if (fence[1][0] === open) open = null;
            continue;
        }
        if (open === null && marker.test(line)) out.push(line);
    }
    return out.join('\n');
}

/**
 * Env vars in src/env.ts that are NOT sub-processor endpoints: internal
 * secrets, operator config, feature flags, and self-hosted components.
 * Each must have a reason — adding a key here is an explicit "this is not
 * a sub-processor" decision.
 */
const NON_SUBPROCESSOR_ALLOWLIST: Record<string, string> = {
    // #3995 — the sandbox runtime's DECLARED configuration. None of these four
    // names an external service, and the triage is worth stating precisely
    // because one of them is about egress.
    //
    // `SANDBOX_RUNTIME_CHANNELS` lists which reporting channels a SEPARATE
    // process was told to use. The endpoints themselves are that process's own
    // environment (`OPENSHELL_OTLP_ENDPOINT` and friends), never this
    // application's, and nothing leaves this application through any of them.
    // The sub-processor question those channels DO raise — a runtime whose
    // anonymous telemetry defaults to ON reports to its maintainers — is a
    // property of deploying a runtime, not of this variable, and is recorded as
    // a note in docs/sub-processors.md where a reader of the inventory will
    // meet it.
    SANDBOX_RUNTIME_CHANNELS:
        'Records which reporting channels a separate sandbox runtime was ' +
        'declared with (#3995). The endpoints live in THAT process\'s own ' +
        'environment; no data leaves this application through this variable. ' +
        'The runtime\'s own telemetry default is covered by a note in the inventory.',
    SANDBOX_RUNTIME_CONFIG_DIGEST:
        'A sha256 digest of the configuration this deploy applied (#3995). ' +
        'An identifier, not an endpoint — nothing is sent anywhere.',
    SANDBOX_RUNTIME_APPLIED_AT:
        'Timestamp recording when that configuration was applied (#3995). ' +
        'Local provenance only; names no service.',
    SANDBOX_RUNTIME_HEALTH_URL:
        'Base URL of OUR OWN gateway\'s unauthenticated health port, probed for ' +
        'a version string (#4000). It does name an endpoint, which is why the ' +
        'triage has to be stated rather than assumed: the host is the ' +
        'openshell-gateway VM in this project\'s own VPC, reached on the ' +
        'INTERNAL address, and a firewall rule admits only the app VM. No third ' +
        'party is involved and nothing is SENT — the probe is a GET that ' +
        'deliberately carries no credentials, and the only thing read back is ' +
        'the gateway\'s own version. If this ever points outside the VPC it ' +
        'becomes an inventory entry, not an allowlist one.',
    // #4562 — WHICH gateway VM a scan may start, and where. These name a
    // project, a zone and an instance INSIDE Google Cloud, which is already in
    // the inventory as the platform this deployment runs on. They do not
    // introduce a new external service and they carry no personal data: a
    // project id, a zone and an instance name are identifiers of our own
    // infrastructure, visible to anybody with console access.
    //
    // The sub-processor question a sandbox DOES raise — that a third-party
    // runtime processes collector output on a machine we operate — is a
    // property of running the gateway, recorded in the inventory's note, not of
    // these three variables.
    SANDBOX_RUNTIME_GATEWAY_PROJECT:
        'Names our own Google Cloud project, already an inventoried platform. No new external service.',
    SANDBOX_RUNTIME_GATEWAY_ZONE:
        'Names a zone inside our own Google Cloud project. No new external service.',
    SANDBOX_RUNTIME_GATEWAY_INSTANCE:
        'Names one Compute Engine instance we operate. No new external service.',
    // #4561 — the gRPC endpoint and the three PEM PATHS. The endpoint is an
    // INTERNAL VPC address of our own gateway VM, reached over mTLS; the three
    // paths are local files on the app VM. No third party is named, nothing
    // leaves the VPC, and the key itself never appears here — the variable
    // holds a path because the owner decision of 2026-10-30 delivers the key
    // out of band as a root-owned 0400 file.
    SANDBOX_RUNTIME_GATEWAY_ENDPOINT:
        'host:port of OUR OWN gateway VM on the internal VPC address (#4561). ' +
        'Reached over mTLS with a client certificate; no third party, and nothing ' +
        'leaves the VPC.',
    SANDBOX_RUNTIME_CA_CERT_PATH:
        'Local path to the CA certificate our own gateway presents. A path, not a key.',
    SANDBOX_RUNTIME_CLIENT_CERT_PATH:
        'Local path to our client certificate. A path, not a key.',
    SANDBOX_RUNTIME_CLIENT_KEY_PATH:
        'Local path to the client private key, delivered out of band as a root-owned ' +
        '0400 file. The VALUE never reaches this file or any environment.',
    SANDBOX_EXECUTION_ENABLED:
        'Deployment feature flag for whether agent tool calls run inside the ' +
        'sandbox runtime (#3995/#3996). Chooses a LOCAL execution path; no ' +
        'data leaves and there is no processor either way.',
    // #3861 — A2A host consumers. NEITHER names an external service.
    // `A2A_HOST_CONSUMERS` is a deployment feature flag, and the direction of
    // travel is INBOUND: a host calls us. Nothing is sent anywhere by either.
    A2A_HOST_CONSUMERS:
        'Deployment feature flag admitting a host that calls US as a client ' +
        '(#3861). Inbound only — no data leaves, so there is no processor.',
    A2A_HOST_CONSUMER_TOKEN_SECRET:
        'OUR OWN HS256 signing secret for the access token we mint and then ' +
        'verify ourselves (#3861). It is never sent to anyone; a third party ' +
        'only ever presents a token signed with it back to us.',
    // #1309 NVD CVE feed — NIST's PUBLIC vulnerability database. We PULL
    // CVE data from it; no customer/personal data is ever sent to NVD, so
    // it is not a sub-processor. NVD_API_KEY is an optional rate-limit key;
    // NVD_SYNC_ENABLED is an operator feature flag (not an endpoint).
    NVD_API_KEY: 'optional rate-limit key for NIST NVD public CVE feed — pull-only, no data sent, not a sub-processor',
    NVD_SYNC_ENABLED: 'operator feature flag toggling the NVD CVE sync job — not an external endpoint',
    // Continuous vendor monitoring — the real providers PULL from public
    // signals (the keyless HIBP breach catalog filtered by a vendor DOMAIN
    // string; the vendor's OWN homepage security headers). No customer/personal
    // data is ever sent, so none is a sub-processor. Defaults are network-free stubs.
    VENDOR_MONITOR_ENABLED: 'operator feature flag toggling the vendor-monitoring sweep — not an external endpoint',
    VENDOR_MONITOR_BREACH_PROVIDER: 'selects the breach signal source; real value (hibp-domain) sends only a vendor domain string to the public keyless HIBP breach catalog — pull-only, no personal data, not a sub-processor',
    VENDOR_MONITOR_TLS_PROVIDER: "selects the TLS-grade source; real value (header-grade) reads the vendor's OWN public homepage security headers — no third-party processor, not a sub-processor",
    // pipelock MCP mediator — a SELF-HOSTED daemon we run in our own Docker
    // Compose stack (not a third-party SaaS). PIPELOCK_PUBLIC_KEY is the PUBLIC
    // half of the mediator's Ed25519 signing keypair, used only to VERIFY
    // ingested receipts — no customer/personal data is ever sent to a third
    // party, so pipelock is not a sub-processor. PIPELOCK_STRICT_MODE is an
    // operator feature flag.
    PIPELOCK_PUBLIC_KEY: 'public Ed25519 verify key for the self-hosted pipelock MCP mediator — verify-only, no data sent externally, not a sub-processor',
    PIPELOCK_STRICT_MODE: 'operator feature flag toggling strict receipt enforcement — not an external endpoint',
    // Agent DRIVER seam — selects which engine executes an agentic run. `flue`
    // names `@flue/runtime`, an IN-PROCESS framework library (an npm package we
    // import and run ourselves), not a hosted service: turning this flag on
    // opens no socket to a third party and sends no customer or personal data
    // anywhere. The model provider such a run would eventually call is a
    // separate question, configured by the AI_* / inference vars that are
    // triaged on their own above — which is exactly why this flag must not be
    // read as covering them.
    AGENT_DRIVER_FLUE: 'operator feature flag selecting the in-process agent execution engine — an imported library, not an external endpoint, and not a sub-processor',
    AGENT_DRIVER_TOOL_RUNNER: 'operator feature flag selecting the Tool Runner engine — an in-process loop over the existing Anthropic sub-processor, not an endpoint of its own; its data category ("tenant-authored agent instructions") is recorded on the Anthropic row since Step 2c',
    VECTOR_STORE_BACKEND: 'operator switch for the vector store (D-L4-1): `pgvector` keeps vectors in the deployment\'s own Postgres through an in-database extension, so no data leaves the database — not an external endpoint, and not a sub-processor',
    // Agent INTERACTIVE-RUN seam (#3868 step 2) — admits a new STARTER for a
    // run, a signed-in person in a browser, beside the job, credential and
    // automation-rule starters that already exist. It names no host, opens no
    // socket and sends nothing anywhere: WHICH engine executes the run, and
    // which model that engine calls, are the driver's question above and the
    // AI_* vars' question, both triaged on their own.
    //
    // The honest nuance, because this is a data-protection register and not a
    // lint list: turning this on means MORE runs happen, and those runs reach
    // whatever the configured driver reaches. That is true of the driver flag
    // too, and it is why the triage asks whether the VAR names an endpoint
    // rather than whether it can increase traffic. If the set of third parties
    // a run may reach ever changes, that is a change to the inventory above,
    // not to this entry — so this flag must not be read as covering it.
    AGENT_INTERACTIVE_RUNS: 'operator feature flag admitting a browser-started agent run — a new starter for the existing engine, not an external endpoint, and not a sub-processor',
    AGENT_PROFILES: 'operator feature flag exposing the agent profile surface — tables and routes in this deployment, not an external endpoint, and not a sub-processor; the Tool Runner engine sends profile instructions to the Anthropic row, which names that data category since Step 2c',
    AGENT_BEHAVIOUR_DETECTOR: 'operator switch for the nightly agent behaviour fingerprint (Morpheus Phase 1) — an in-worker computation over this deployment\'s own ledger, no external endpoint, not a sub-processor',
    AGENT_BEHAVIOUR_DETECTOR_LATCH: 'operator switch letting that detector latch the existing circuit breaker — in-process, no external endpoint, not a sub-processor',
    AGENT_BEHAVIOUR_DETECTOR_TENANTS: 'operator allowlist of tenant slugs the behaviour fingerprint scores — this deployment\'s own tenants, not an external endpoint, not a sub-processor',
    AGENT_PROFILES_TENANTS: 'operator allowlist of tenant slugs that opens the same agent profile surface to named tenants only — a list of this deployment\'s own tenants, not an external endpoint, and not a sub-processor',
    // Step 2a (#4148). The Tool Runner engine's two model pins and the SDK's
    // ambient-headers variable. The models are ids at the EXISTING Anthropic
    // row, the same kind of value as AGENT_FLUE_MODEL, named in that row's (d)
    // entry of docs/sub-processors.md since Step 2c turned the engine on. The
    // headers variable is read only to REFUSE a client.
    AGENT_TOOL_RUNNER_MODEL_BALANCED: 'model id the Tool Runner engine names for a profile\'s balanced tier at the existing Anthropic sub-processor, recorded in docs/sub-processors.md (Step 2c); names no endpoint',
    AGENT_TOOL_RUNNER_MODEL_DEEP: 'model id the Tool Runner engine names for a profile\'s deep tier at the existing Anthropic sub-processor, recorded in docs/sub-processors.md (Step 2c); names no endpoint',
    ANTHROPIC_CUSTOM_HEADERS: 'read only to refuse: while it is set, clientForRun builds no Anthropic client, because @anthropic-ai/sdk would add it to every request — it sends nothing anywhere',
    // AI sovereignty (DS-1) — the local/self-hosted LLM gateway. These configure
    // the TENANT'S OWN in-jurisdiction inference endpoint (Ollama / vLLM), the
    // OPPOSITE of an external sub-processor: a LOCAL_ONLY tenant's inference
    // never leaves its perimeter. Not a third-party processor.
    AI_LOCAL_BASE_URL: 'base URL of the tenant\'s OWN self-hosted OpenAI-compatible LLM gateway (AI sovereignty) — in-jurisdiction inference, not an external sub-processor',
    AI_LOCAL_MODEL: 'model name served by the tenant\'s self-hosted gateway — a config string, not an external endpoint',
    AI_LOCAL_API_KEY: 'optional bearer for the tenant\'s OWN local gateway — internal, not sent to any third party',
    // The embedding and rerank seam (Layer 4, src/lib/ai/embeddings/). Every
    // route is in-deployment (`inflect-local`); an external embedding
    // provider would be a sub-processor and does not exist.
    AI_EMBED_LOCAL_BASE_URL: 'base URL of the deployment\'s OWN embedding service (TEI inside the perimeter) — not an external sub-processor',
    AI_EMBED_LOCAL_MODEL: 'embedding model name served by the in-deployment service — a config string, not an endpoint',
    AI_EMBED_LOCAL_DIMENSIONS: 'vector length of the configured embedding model — a number, not an endpoint',
    AI_EMBED_LOCAL_QUERY_PREFIX: 'query prefix the configured embedding model expects — a config string, not an endpoint',
    AI_EMBED_LOCAL_PASSAGE_PREFIX: 'passage prefix the configured embedding model expects — a config string, not an endpoint',
    AI_RERANK_LOCAL_BASE_URL: 'base URL of the deployment\'s OWN rerank service (TEI inside the perimeter) — not an external sub-processor',
    AI_RERANK_LOCAL_MODEL: 'rerank model name served by the in-deployment service — a config string, not an endpoint',
    // The AI guard's second provider (NeMo Guardrails roadmap, Phase 1.4).
    // Every guarded text — LOCAL_ONLY tenants' included, and every egress
    // payload — is POSTed here, so the triage is a decision, not bookkeeping:
    // it is a host WE operate, never a vendor's. Pointing it at a third party's
    // endpoint would make that party a sub-processor of every tenant's AI
    // content and is the sub-processor change process, not a config change.
    AI_GUARD_NEMO_BASE_URL: 'base URL of a NeMo Guardrails server (open source, Apache-2.0) WE operate, running LLM-free rails; no data leaves our infrastructure, so not a sub-processor — operator deployment config, unreachable from any tenant setting; a third-party host here would be a sub-processor change',
    // PII detector (docs/ai-architecture/presidio.md, Phase 1). Presidio runs as
    // a CPU service INSIDE the deployment — the roadmap rejects a cloud PII API
    // precisely because it would be a sub-processor receiving every payload. The
    // service's register row (G2, legacy-mcp style) lands with its container in
    // Phase 1.1; these two vars only name where it is and what it was built from.
    // The base URL is held to the in-deployment rule (G6 as amended 2026-11-12):
    // every address it resolves to must be inside the deployment, so pointing it
    // at a third party's host refuses every call rather than making that party
    // a sub-processor.
    AI_PII_BASE_URL: 'base URL of the in-deployment Presidio PII analyzer — operator-run, inside the perimeter, not a third-party processor',
    AI_PII_CONFIG_HASH: 'hash naming the recogniser configuration the deployed PII analyzer was built from — a config string, not an endpoint',
    // Internal secrets (env-provided; stored in AWS Secrets Manager, itself listed).
    AUTH_SECRET: 'internal JWT/session signing secret',
    JWT_SECRET: 'internal JWT signing secret',
    DATA_ENCRYPTION_KEY: 'app master KEK (env-provided, not an external endpoint)',
    DATA_ENCRYPTION_KEY_PREVIOUS: 'previous master KEK for rotation',
    AV_WEBHOOK_SECRET: 'internal HMAC secret for the AV webhook',
    // Operator config / URLs.
    APP_URL: 'deployment URL config',
    BUILD_SHA: 'the commit the image was built from, reported by the health probes',
    AUTH_URL: 'deployment URL config',
    NEXTAUTH_URL: 'deployment URL config',
    NODE_ENV: 'runtime mode',
    CORS_ALLOWED_ORIGINS: 'CORS config',
    // Deployment-level CIDRs, not a service: it names address RANGES this
    // install may reach, and the destinations inside them are the operator's
    // own network (#3328). Nothing is sent to a third party by setting it, so
    // it is not a sub-processor question.
    EGRESS_PRIVATE_CIDR_ALLOWLIST: 'self-hosted private-address egress CIDRs',
    STORAGE_PROVIDER: 'storage backend selector (s3 vs local)',
    UPLOAD_DIR: 'local upload path config',
    FILE_STORAGE_ROOT: 'local storage root config',
    FILE_ALLOWED_MIME: 'upload MIME allowlist config',
    FILE_MAX_SIZE_BYTES: 'upload size limit config',
    // Feature flags.
    AUTH_REQUIRE_EMAIL_VERIFICATION: 'feature flag',
    AUTH_TEST_MODE: 'test-only flag',
    RATE_LIMIT_ENABLED: 'feature flag',
    RATE_LIMIT_MODE: 'feature flag',
    AI_RISK_DAILY_QUOTA: 'AI usage quota config',
    AI_RISK_USER_RPM: 'AI per-user rate config',
    // Self-hosted ClamAV daemon (in-VPC, not a sub-processor — see the doc's note).
    AV_SCAN_MODE: 'self-hosted antivirus mode',
    CLAMAV_HOST: 'self-hosted ClamAV daemon host (in-VPC, not a sub-processor)',
    // More feature flags / config / internal secrets.
    AI_RISK_ENABLED: 'AI feature flag',
    AI_RISK_PLAN_REQUIRED: 'AI plan-gating flag',
    AI_RISK_SUGGESTIONS_ENABLED: 'per-feature AI enable flag (GAP-2) — no external service',
    AI_ASSISTANT_ENABLED: 'per-feature AI enable flag (GAP-2) — no external service',
    AI_QUESTIONNAIRE_ENABLED: 'per-feature AI enable flag (GAP-2) — no external service',
    AUDIT_STREAM_RETRY_ENABLED: 'audit-stream retry flag (target SIEM is the customer\'s own per-tenant endpoint, not an env sub-processor)',
    ENCRYPTION_DECRYPT_FAIL_CLOSED: 'local kill-switch for the fail-closed decrypt posture — no third party, no egress; reverts a genuine decrypt failure to passing ciphertext through',
    NEXT_PUBLIC_NOTIFICATIONS_SSE: 'notifications transport feature flag',
    NOTIFICATIONS_TZ: 'notification timezone config',
    PLATFORM_ADMIN_API_KEY: 'internal platform-admin bootstrap secret',
    PLATFORM_ADMIN_API_KEY_PREVIOUS: 'internal platform-admin secret rotation',
    // Step 6b — Laya, Convai Innovations' open-weights System One model. We RUN it:
    // open weights under Apache-2.0 on infrastructure we operate, so nothing leaves
    // our boundary and there is no third party to be a processor. These are
    // deployment configuration that no tenant setting can reach — the same
    // restriction that makes the Jev host a code constant. Jev itself is NOT here:
    // TYPESAFE_API_KEY names a real sub-processor and is covered by the
    // docs/sub-processors.md row that Step 6a added.
    // ragflow.md Phase 1 (D-L4-4) — the Docling-class parsing service. The
    // owner's decision is that it is a service WE run inside the deployment,
    // and Phase 1.3 lands it as a worker-network container. Phase 1.5 adds the
    // inventory row then, describing the shipped deployment rather than a plan.
    DOC_PARSER_BASE_URL:
        'base URL of the Docling-class parsing-only service the OPERATOR runs ' +
        'inside the deployment (D-L4-4): stateless, keeps nothing, deployment ' +
        'config never reachable from a tenant setting. Pointing it at a host ' +
        'OUTSIDE the deployment makes that host a sub-processor (G2) — an ' +
        'inventory entry and a register change, not an allowlist one.',
    DOC_PARSER_API_KEY:
        'credential for that same operator-run parsing service (sent as ' +
        'X-Api-Key); names no service of its own and is sent only to ' +
        'DOC_PARSER_BASE_URL.',
    LAYA_BASE_URL: "base URL of a Laya System One server WE operate (open weights, Apache-2.0); no data leaves our infrastructure, so not a sub-processor — deployment config, unreachable from any tenant setting",
    LAYA_API_KEY: 'optional bearer for our own Laya server; most deployments sit behind a network boundary instead — our infrastructure, not a third party, so not a sub-processor',
    // Web Bot Auth Phase 1 (owner decisions D-L1-5/6/7, 2026-11-11). The
    // deployment's ONE Ed25519 signing seed, and its predecessor during a
    // rotation's grace. Neither names an external service: the seed signs our
    // own outbound requests and its public half is served from OUR OWN key
    // directory. Nothing is sent anywhere by holding it, and no third party
    // receives it — a site that verifies a signature fetches the public key
    // from us. If a hosted signing service ever replaces the local seed, that
    // service is an inventory entry, not an allowlist one.
    WEB_BOT_AUTH_SIGNING_KEY:
        'Deployment-held Ed25519 signing seed for Web Bot Auth (one per deployment, never per tenant). ' +
        'A local secret; names no external service, and only its public half is published, from our own key directory.',
    WEB_BOT_AUTH_PREVIOUS_SIGNING_KEY:
        'The previous Web Bot Auth signing seed, published beside the current one during a rotation\'s grace. ' +
        'A local secret; names no external service.',
};

/**
 * Parse every `KEY: process.env.KEY` from the runtimeEnv blocks of BOTH env
 * modules — `src/env.ts` and `src/env-client.ts` (#4764).
 *
 * BOTH, because the population is "variables this deployment reads", and
 * splitting the server and client schemas into two files split that population
 * too. Reading only `src/env.ts` would let any future `NEXT_PUBLIC_` variable
 * reach a browser without a sub-processor triage decision, which is the one
 * thing this guard exists to prevent — and it would read the existing
 * `NEXT_PUBLIC_NOTIFICATIONS_SSE` allowlist entry as stale and demand its
 * deletion, losing the written reason with it.
 *
 *
 * `codeOf` masks COMMENTS at this one read, and only this one — the three
 * document reads below are markdown, where prose IS the content and masking
 * would destroy it. Without the mask, a BLOCK-commented entry
 *
 *     \/*  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,  *\/
 *
 * still satisfies `^\s*[A-Z]` and is counted as a live env var, so this guard
 * would demand an inventory entry for a variable the runtime no longer reads.
 * env.ts carries six block comments today, so the hazard is not hypothetical.
 * (A `//` line is already excluded — it fails `^\s*[A-Z]` on the slash.)
 */
const ENV_MODULES = ['src/env.ts', 'src/env-client.ts'] as const;

function envKeys(): string[] {
    const keys = new Set<string>();
    for (const rel of ENV_MODULES) {
        const src = codeOf(read(rel));
        const re = /^\s*([A-Z][A-Z0-9_]+):\s*process\.env\./gm;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) keys.add(m[1]);
    }
    return [...keys].sort();
}

describe('sub-processor coverage', () => {
    it('the three documents exist', () => {
        expect(exists(SUBPROC)).toBe(true);
        expect(exists(DPA)).toBe(true);
        expect(exists(POLICY)).toBe(true);
    });

    it('the inventory has its table', () => {
        // The table has to be IN the Inventory section, which the
        // whole-document read never required — `mdSection` throws if the
        // heading is gone, so both halves of this test still bind.
        const doc = mdSection(read(SUBPROC), 'Inventory');
        expect(doc).toMatch(/##\s+Inventory/i);
        expect(doc).toMatch(/\|\s*Name\s*\|\s*Data shared\s*\|/i);
    });

    describe('every env-var in src/env.ts is triaged (inventory or allowlist)', () => {
        const doc = read(SUBPROC);
        for (const key of envKeys()) {
            it(key, () => {
                const inDoc = doc.includes(key);
                const inAllow = key in NON_SUBPROCESSOR_ALLOWLIST;
                // Every env var must be triaged: either referenced in the
                // inventory (a sub-processor endpoint) OR allowlisted as a
                // non-sub-processor. (A var may also be *mentioned* in the
                // doc's clarifying notes while allowlisted — e.g. CLAMAV_HOST
                // in the self-hosted note — which is fine.)
                if (!inDoc && !inAllow) {
                    throw new Error(
                        `Env var '${key}' is neither referenced in docs/sub-processors.md ` +
                            `nor in NON_SUBPROCESSOR_ALLOWLIST. If it names a new external ` +
                            `service, add it to the inventory; otherwise allowlist it with a reason.`,
                    );
                }
            });
        }
    });

    /**
     * The `## Inventory` table ONLY — not the whole document (#2727).
     *
     * `doc.includes(slug)` over the entire file was green for the wrong
     * reason, and the reason is exact: `personnel`, `device` and `training`
     * appear NOWHERE except block-quote notes saying each one is **internal**,
     * i.e. explicitly NOT a sub-processor. A test named "every integration
     * provider is in the inventory" was passing for three providers BECAUSE
     * the document states they are not in it. `identity` was worse still — no
     * entry at all, matched only by the incidental phrase "identity provider".
     *
     * Masking cannot fix this and #2727's first framing was wrong about that:
     * the slugs are backticked CODE SPANS, so any masker that keeps code (and
     * one that did not would delete the inventory itself) keeps them. The
     * defect was never prose-versus-code — it was an assertion reading the
     * wrong REGION of the document.
     */
    const inventorySection = (): string => {
        const doc = read(SUBPROC);
        const start = doc.indexOf('## Inventory');
        expect(start).toBeGreaterThan(-1);
        const next = doc.indexOf('\n## ', start + 1);
        return doc.slice(start, next < 0 ? doc.length : next);
    };

    /**
     * Providers evaluated ENTIRELY inside this product — no third party
     * receives data, so they are deliberately absent from the inventory. Each
     * must still be documented as internal, which is the second half of the
     * assertion pair below: absence alone is indistinguishable from an
     * omission.
     */
    const INTERNAL_PROVIDERS: readonly string[] = ['personnel', 'device', 'training', 'identity'];

    it('every EXTERNAL integration provider is in the inventory table', () => {
        const providersDir = path.join(ROOT, 'src/app-layer/integrations/providers');
        const dirs = fs
            .readdirSync(providersDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .filter((d) => !INTERNAL_PROVIDERS.includes(d));

        // Positive control: if the provider directory were empty or the
        // filter over-matched, "none missing" would pass vacuously.
        expect(dirs.length).toBeGreaterThan(5);

        const inv = inventorySection().toLowerCase();
        const missing = dirs.filter((d) => !inv.includes(d.toLowerCase()));
        expect(missing).toEqual([]);
    });

    it('every INTERNAL provider is absent from the inventory AND says why', () => {
        const inv = inventorySection().toLowerCase();
        const doc = read(SUBPROC);
        for (const p of INTERNAL_PROVIDERS) {
            // Absent from the inventory — it is not a sub-processor...
            expect({ provider: p, inInventory: inv.includes(`\`${p}\``) }).toEqual({
                provider: p,
                inInventory: false,
            });
            // ...and the document SAYS SO, so the absence is a statement
            // rather than an omission nobody noticed.
            //
            // The property is "the doc declares this is not a sub-processor",
            // searched in a bounded window after the slug — NOT "the word
            // `internal` appears on the same line". The same-line form passed
            // only because three of the four notes happen to be written that
            // way; it failed the fourth for its wording rather than its
            // meaning, which is a test asserting prose style instead of fact.
            const at = doc.indexOf(`\`${p}\``);
            // Unwrap the block quote before matching. The sentence wraps as
            // `**not** a\n> sub-processor`, so a `\s+` between the words does
            // not cross the `> ` continuation marker — the assertion would be
            // testing where the author's line breaks fell, not what the
            // document says.
            // Bounded by the NOTE, not by a character count. A fixed 600-char
            // window bled into the NEXT block quote, so deleting one
            // provider's declaration still found its neighbour's — the
            // mutation proof caught that, and a fixed span is exactly the
            // unbounded-interior-span shape this repo ratchets against.
            const noteEnd = at < 0 ? -1 : doc.indexOf('\n\n', at);
            const window = (at < 0 ? '' : doc.slice(at, noteEnd < 0 ? doc.length : noteEnd))
                .replace(/\n>\s*/g, ' ')
                .replace(/\s+/g, ' ');
            expect({
                provider: p,
                declaredNotASubProcessor: /not\*{0,2}\s+a\s+sub-processor/i.test(window),
            }).toEqual({ provider: p, declaredNotASubProcessor: true });
        }
    });

    it('the DPA template has 15 sections + [LEGAL REVIEW REQUIRED] on 10-12', () => {
        const dpa = read(DPA);
        // "15 numbered sections" is a claim about the HEADINGS, so read the
        // headings — `^##\s+7\.` against the whole document is satisfied by
        // any line that happens to start with two hashes and a number.
        const sections = headingLines(dpa, 2);
        for (let n = 1; n <= 15; n++) {
            expect(sections).toMatch(new RegExp(`^##\\s+${n}\\.`, 'm'));
        }
        // Sections 10, 11, 12 each carry the marker. Assert it appears at
        // least 3 times AND those section headings exist (checked above).
        const markerCount = (dpa.match(/\[LEGAL REVIEW REQUIRED\]/g) ?? []).length;
        expect(markerCount).toBeGreaterThanOrEqual(3);
    });

    it('the change policy documents the 4-step process + 30-day notice', () => {
        // The four steps and the notice period belong to ONE section, and
        // the whole-document read did not require them to come from it: the
        // policy says "30 days" three times (the notice step, the removal
        // carve-out, and the effective-date note), so deleting the notice
        // step left the assertion standing on the other two.
        const process = mdSection(read(POLICY), 'The four-step process');
        for (let n = 1; n <= 4; n++) {
            expect(process).toMatch(new RegExp(`^${n}\\.`, 'm'));
        }
        expect(process).toMatch(/30[\s-]day|30 days/);
        // `/[Ee]ffective/` used to run against the whole policy, where it was
        // matched by the word "effective" in any sentence. What it reaches
        // for is the policy's EFFECTIVE-DATE section, so assert that — as a
        // heading, which is the thing that would be removed.
        expect(headingLines(read(POLICY), 2)).toMatch(/^##\s+Effective date/m);
    });
});
