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

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

const SUBPROC = 'docs/sub-processors.md';
const DPA = 'docs/data-processing-agreement-template.md';
const POLICY = 'docs/sub-processor-change-policy.md';

/**
 * ONE `##` SECTION of a markdown document, heading line included (#2246).
 *
 * NARROWED RATHER THAN MASKED, and the measurement is what settles which.
 * `mdCodeOf` — the markdown masker — keeps a document's CODE (fences, inline
 * spans) and blanks its prose; every needle in the three document blocks
 * below is prose or table pipework, and all of them match ZERO times through
 * it. The assertions are not about code, so masking would delete the subject
 * rather than sharpen it.
 *
 * They are about REGIONS, and reading the whole document is what unbound
 * them: `| Name | Data shared |` was satisfied by any table anywhere in
 * `sub-processors.md`, and `30 days` by any of its three occurrences in the
 * change policy rather than the notice step that owes it.
 *
 * Throws when the heading is gone rather than returning '' — a guard whose
 * section was renamed must fail loudly, not assert against an empty string.
 */
function mdSection(md: string, heading: string): string {
    const lines = md.split('\n');
    const start = lines.findIndex((l) => l.trimEnd() === `## ${heading}`);
    if (start < 0) throw new Error(`section not found: ## ${heading}`);
    const rest = lines.slice(start + 1).findIndex((l) => /^##\s/.test(l));
    const end = rest < 0 ? lines.length : start + 1 + rest;
    return lines.slice(start, end).join('\n');
}

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

/**
 * Parse every `KEY: process.env.KEY` from the runtimeEnv block of src/env.ts.
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
function envKeys(): string[] {
    const src = codeOf(read('src/env.ts'));
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
