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

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

const SUBPROC = 'docs/sub-processors.md';
const DPA = 'docs/data-processing-agreement-template.md';
const POLICY = 'docs/sub-processor-change-policy.md';

/**
 * Env vars in src/env.ts that are NOT sub-processor endpoints: internal
 * secrets, operator config, feature flags, and self-hosted components.
 * Each must have a reason — adding a key here is an explicit "this is not
 * a sub-processor" decision.
 */
const NON_SUBPROCESSOR_ALLOWLIST: Record<string, string> = {
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
    // AI sovereignty (DS-1) — the local/self-hosted LLM gateway. These configure
    // the TENANT'S OWN in-jurisdiction inference endpoint (Ollama / vLLM), the
    // OPPOSITE of an external sub-processor: a LOCAL_ONLY tenant's inference
    // never leaves its perimeter. Not a third-party processor.
    AI_LOCAL_BASE_URL: 'base URL of the tenant\'s OWN self-hosted OpenAI-compatible LLM gateway (AI sovereignty) — in-jurisdiction inference, not an external sub-processor',
    AI_LOCAL_MODEL: 'model name served by the tenant\'s self-hosted gateway — a config string, not an external endpoint',
    AI_LOCAL_API_KEY: 'optional bearer for the tenant\'s OWN local gateway — internal, not sent to any third party',
    // Internal secrets (env-provided; stored in AWS Secrets Manager, itself listed).
    AUTH_SECRET: 'internal JWT/session signing secret',
    JWT_SECRET: 'internal JWT signing secret',
    DATA_ENCRYPTION_KEY: 'app master KEK (env-provided, not an external endpoint)',
    DATA_ENCRYPTION_KEY_PREVIOUS: 'previous master KEK for rotation',
    AV_WEBHOOK_SECRET: 'internal HMAC secret for the AV webhook',
    // Operator config / URLs.
    APP_URL: 'deployment URL config',
    AUTH_URL: 'deployment URL config',
    NEXTAUTH_URL: 'deployment URL config',
    NODE_ENV: 'runtime mode',
    CORS_ALLOWED_ORIGINS: 'CORS config',
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
};

/** Parse every `KEY: process.env.KEY` from the runtimeEnv block of src/env.ts. */
function envKeys(): string[] {
    const src = read('src/env.ts');
    const keys = new Set<string>();
    const re = /^\s*([A-Z][A-Z0-9_]+):\s*process\.env\./gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) keys.add(m[1]);
    return [...keys].sort();
}

describe('sub-processor coverage', () => {
    it('the three documents exist', () => {
        expect(exists(SUBPROC)).toBe(true);
        expect(exists(DPA)).toBe(true);
        expect(exists(POLICY)).toBe(true);
    });

    it('the inventory has its table', () => {
        const doc = read(SUBPROC);
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

    it('every integration provider is in the inventory', () => {
        const providersDir = path.join(ROOT, 'src/app-layer/integrations/providers');
        const dirs = fs
            .readdirSync(providersDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
        const doc = read(SUBPROC).toLowerCase();
        const missing = dirs.filter((d) => !doc.includes(d.toLowerCase()));
        expect(missing).toEqual([]);
    });

    it('the DPA template has 15 sections + [LEGAL REVIEW REQUIRED] on 10-12', () => {
        const dpa = read(DPA);
        for (let n = 1; n <= 15; n++) {
            expect(dpa).toMatch(new RegExp(`^##\\s+${n}\\.`, 'm'));
        }
        // Sections 10, 11, 12 each carry the marker. Assert it appears at
        // least 3 times AND those section headings exist (checked above).
        const markerCount = (dpa.match(/\[LEGAL REVIEW REQUIRED\]/g) ?? []).length;
        expect(markerCount).toBeGreaterThanOrEqual(3);
    });

    it('the change policy documents the 4-step process + 30-day notice', () => {
        const policy = read(POLICY);
        for (let n = 1; n <= 4; n++) {
            expect(policy).toMatch(new RegExp(`^${n}\\.`, 'm'));
        }
        expect(policy).toMatch(/30[\s-]day|30 days/);
        expect(policy).toMatch(/[Ee]ffective/);
    });
});
