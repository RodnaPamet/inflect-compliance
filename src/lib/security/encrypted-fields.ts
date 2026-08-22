/**
 * # Performance expectations (Epic B.1 — pinned by perf test)
 *
 * Measured in `tests/unit/encryption-middleware.perf.test.ts`. These
 * are the numbers that matter for production sizing — reach for the
 * runbook (`docs/epic-a-security.md` cross-references this layer) if
 * a regression investigation needs them.
 *
 * | Scenario                                     | Observed | Threshold |
 * |----------------------------------------------|---------:|----------:|
 * | Raw `encryptField` / `decryptField`          |  <10 µs |     100 µs|
 * | Single-row detail (3 fields)                 |  <0.1 ms|       5 ms|
 * | List of 100 rows × 2 encrypted fields        |   ~3 ms |      50 ms|
 * | List + 10 nested comments per row (1000 ops) |  ~16 ms |     120 ms|
 * | Write with nested `createMany` of 50         | ~0.8 ms |      80 ms|
 * | Walk 100 rows of a NON-encrypted model       |  <0.5 ms|      15 ms|
 * | Middleware overhead vs raw decrypt (100×2)   |     17% |      100% |
 *
 * **Expected overhead:** ~15–20% above bare AES-GCM cost on realistic
 * list workloads. The traversal + per-value guard (`isEncryptedValue`)
 * fits comfortably inside the headroom of a typical request, and the
 * fast-path early-exit on nodes with no manifest field names means
 * included `User` / `Tenant` / framework-library relations cost
 * almost nothing (a single `Set.has` per node).
 *
 * **Where encryption overhead is acceptable:**
 *   - Every tenant-scoped API route — decryption of N×M fields per
 *     response is bounded by the network-response-size budget, which
 *     dominates the total latency.
 *   - Background jobs (compliance digest, evidence expiry sweeps) —
 *     they tolerate higher per-row cost because they don't affect
 *     request latency.
 *   - PDF exports — one-shot, operator-tolerant.
 *
 * **Where it should be watched:**
 *   - Very large list pages (10k+ rows) — paginate, don't fetch all.
 *     Current cursors in `@/lib/pagination` already cap at 100.
 *   - Dashboards that aggregate across an encrypted column — don't.
 *     Move aggregation to a plaintext analytics column (e.g.
 *     `Risk.score` / `Risk.status`) per the manifest's "fields
 *     explicitly excluded" section.
 *
 * # Epic B.1 — Encrypted field manifest.
 *
 * Lists business-content fields that the Prisma encryption middleware
 * (`src/lib/db/encryption-middleware.ts`) encrypts at rest. The manifest
 * drives encrypt-on-write and decrypt-on-read; no other code path
 * should consult these columns without going through the middleware.
 *
 * **Enforcement — this manifest is opt-OUT, not opt-in-by-memory.**
 * `tests/guardrails/encryption-manifest-coverage.test.ts` scans the live
 * Prisma schema and fails CI if any tenant-scoped `String` column whose
 * NAME looks sensitive (note / comment / description / summary / … — see
 * the guard's `SENSITIVITY_HEURISTIC`) is neither listed here NOR
 * justified in that guard's `NOT_SENSITIVE` allowlist with a written
 * reason. So a new sensitive column can no longer silently ship
 * plaintext just because nobody remembered this file: the author must
 * consciously encrypt it (add it below) or record why it stays
 * plaintext. Widen the heuristic there as new sensitive shapes appear.
 *
 * Pattern: **in-place encryption**. Unlike the PII middleware
 * (`src/lib/security/pii-middleware.ts`) which uses dual `*Encrypted`
 * sibling columns, the Epic B business-content fields are encrypted
 * into the same column that holds the plaintext today.
 *
 *   - No schema change required to ship the middleware. Existing
 *     rows stay plaintext until their next update (at which point the
 *     middleware rewrites them as ciphertext).
 *   - The one-shot backfill migration (later Epic B phase) iterates
 *     every row and `encryptField()`s each listed field in place.
 *   - Detection is idempotent: every ciphertext begins with the
 *     `v1:` version prefix (see `encryption.ts`). The middleware
 *     uses `isEncryptedValue()` before both encrypt and decrypt so
 *     double-encryption and plaintext-during-rollout are both safe.
 *
 * **Fields DELIBERATELY NOT in this manifest:**
 *   - PII fields (email, name, phone, tokens) — already handled by
 *     `pii-middleware.ts` with the dual-column convention.
 *   - `Risk.description`, `Policy.description`, `Evidence.content` —
 *     searched via `contains` LIKE in their repositories. A product
 *     decision on whether to sacrifice substring search for
 *     encryption is still pending. If ever added here, the
 *     RiskRepository / PolicyRepository / EvidenceRepository search
 *     branches must be removed in the same PR.
 *   - Operational keys (status, category, severity, FKs, dates) —
 *     load-bearing for filters, joins, and indexes.
 *   - Global library tables (Framework, Clause, ControlTemplate,
 *     PolicyTemplate, QuestionnaireTemplate, RiskTemplate) — no
 *     tenant-specific content, zero breach value.
 *   - `AuditLog.*` — append-only hash-chained audit trail. Encrypting
 *     would break `entryHash` integrity; investigation needs
 *     plaintext anyway.
 *
 * **Per-tenant keys (later Epic B phase):** the manifest shape is
 * stable across that change; only the envelope emitted by
 * `encryptField()` grows a `<tenantKeyId>` slot. The version prefix
 * in the ciphertext discriminates — readers keep working.
 */

/**
 * Map from Prisma model name → list of string fields to encrypt.
 * Field names match the Prisma schema exactly.
 *
 * Adding a new field requires:
 *   1. Append to the list here.
 *   2. Verify it's not used in a `contains` / `startsWith` /
 *      `orderBy` in any repository. If it is, either move the
 *      repository off the search (preferred) or skip this field
 *      (record the skip in the guard's `NOT_SENSITIVE` allowlist).
 *   3. Extend `tests/unit/encryption-middleware.test.ts` with a
 *      write-then-read round-trip assertion for the new field.
 *   4. Backfill existing rows as a follow-up migration before the
 *      next tenant writes to the column.
 *
 * If you instead add a NEW sensitive-shaped column and decide it does
 * NOT need encryption, the coverage guard
 * (`encryption-manifest-coverage.test.ts`) will fail until you justify
 * it in its `NOT_SENSITIVE` allowlist — that is the intended opt-out.
 */
/**
 * IntegrationConnection is DELIBERATELY ABSENT from this manifest.
 *
 * Its credentials do not live in a manifest-managed column: they go through an
 * explicit `secretEncrypted` field, written by `usecases/integrations.ts` as
 * `encryptField(JSON.stringify(input.secrets))` and decrypted at the read.
 * That is a separate, working mechanism.
 *
 * Do not "fix" the omission by adding `configJson` here. `configJson` is the
 * PUBLIC half of a connection — hostnames, thresholds, feature toggles — and
 * the admin UI renders it as ordinary form fields. Encrypting it would break
 * that rendering while protecting nothing that is not already protected, and
 * it would hide the real invariant, which is that a credential must never be
 * declared in `configFields` at all.
 *
 * That invariant is enforced by
 * `tests/guards/integration-credential-placement.test.ts`.
 */
export const ENCRYPTED_FIELDS: Readonly<Record<string, readonly string[]>> = {
    // ─── Tenant security settings ──────────────────────
    //  Epic C.4 — audit-stream HMAC secret. URL stays plaintext so DBAs
    //  can audit which tenants are forwarding to which SIEM without
    //  holding the decryption key.
    TenantSecuritySettings: ['auditStreamSecretEncrypted'],

    // ─── Automation ────────────────────────────────────
    //  The WEBHOOK HMAC signing key. Previously lived in
    //  `actionConfigJson.secretRef` — a plain JSON column — despite the type
    //  documenting it as "never the raw secret".
    AutomationRule: ['webhookSecretEncrypted'],

    // ─── JML identity writes ───────────────────────────
    //  `detail` is free text about a NAMED person's access change: the
    //  provider's rejection message for a failed disable, or the human reason a
    //  change was reverted. Provider errors routinely echo the UPN and object
    //  id back, and a reverted-on-rehire note is written by a person.
    //
    //  No backfill was needed — the table shipped with this entry, so no row
    //  ever held plaintext here.
    //
    //  `priorStateJson` is NOT here and cannot be: this manifest encrypts
    //  STRING fields only. It holds structured directory attributes
    //  (`accountEnabled`, `userAccountControl`, group names) rather than
    //  credentials, and the table is RLS-scoped. If a provider is ever added
    //  whose prior state includes a secret, that field must move to the
    //  explicit `secretEncrypted` shape IntegrationConnection uses, not into
    //  this list.
    IdentityWriteJournal: ['detail'],
    // Operator free text saying WHY an account must never be offboarded. It
    // routinely names a person or the purpose of a credential — "Alice's
    // break-glass admin", "shared ops mailbox, do not disable" — which is the
    // same shape as IdentityWriteJournal.detail one line up. No repository
    // searches it, and the column is new, so nothing needs backfilling.
    ConnectedIdentityAccount: ['protectionReason'],

    // ─── Risk ──────────────────────────────────────────
    //  `description` omitted — searched via RiskRepository `contains`.
    Risk: ['treatmentNotes', 'threat', 'vulnerability'],

    // ─── Asset vulnerability (CVE↔asset link) ──────────
    //  Analyst note may describe exploitation status, compensating
    //  controls, or why a CVE is a false positive on this asset —
    //  confidential security context. The CVE catalog itself is public
    //  reference data (Cve table), so only the per-tenant note encrypts.
    AssetVulnerability: ['note'],

    // ─── Scanner finding (DevSecOps ingestion) ─────────
    //  A scanner message can quote the offending source line, a leaked
    //  secret (gitleaks), or an exploit payload (ZAP) — confidential and
    //  high attacker value. The run metadata (source/repoRef) is not
    //  content, so only the per-finding description encrypts. Mirrors the
    //  AssetVulnerability.note rationale in the same subsystem.
    ScannerFinding: ['description'],

    // ─── Business Impact Analysis (ISO 22301 / NIS2 continuity) ─
    //  Analyst notes can describe single points of failure, recovery
    //  gaps, and dependency weaknesses — a roadmap for an attacker who
    //  wants maximum disruption. Encrypt the free-text notes; the
    //  structured RTO/RPO/MTPD + impact profile are operational metrics,
    //  not secrets.
    BusinessImpactAnalysis: ['notes'],

    // ─── Loss-event register (RQ3-6) ───────────────────
    //  Loss narratives are confidential business content (customer
    //  data exposed, settlement amounts, vendor reputation): the
    //  attacker value if leaked is comparable to the Finding rows.
    LossEvent: ['description', 'justification'],

    // ─── Finding ───────────────────────────────────────
    //  Findings are audit artifacts — attacker value if leaked is high.
    Finding: [
        'description',
        'rootCause',
        'correctiveAction',
        'analysis',
        'verificationNotes',
    ],

    // ─── Evidence / review ─────────────────────────────
    //  Evidence.content omitted — searched via EvidenceRepository.
    EvidenceReview: ['comment'],

    // ─── Policy ────────────────────────────────────────
    //  Policy.description omitted — searched via PolicyRepository.
    //  The high-value target (the policy body itself) lives on
    //  PolicyVersion; encrypting it defends the real secret without
    //  breaking the list-page search UX.
    PolicyVersion: ['contentText', 'changeSummary'],

    // ─── Vendor ────────────────────────────────────────
    Vendor: ['description'],
    VendorDocument: ['notes'],
    VendorAssessment: ['notes'],
    VendorEvidenceBundle: ['description'],

    // ─── Tasks + comments ──────────────────────────────
    //  TaskRepository searches `title` + `key` only — `description`
    //  is safe to encrypt.
    Task: ['description', 'resolution'],
    TaskComment: ['body'],

    // ─── Compliance audits (model: Audit, not AuditLog) ────
    Audit: [
        'auditScope',
        'criteria',
        'auditors',   // legacy free-text "names" column
        'auditees',   // legacy free-text "names" column
        'departments',
    ],
    AuditChecklistItem: ['prompt', 'notes', 'evidenceRef'],

    // ─── Control test runs ─────────────────────────────
    ControlTestRun: ['notes', 'findingSummary'],

    // ─── Epic G-4 access review campaigns ──────────────
    //  Both columns can carry sensitive reviewer rationale that
    //  should be encrypted at rest:
    //  - AccessReview.description: campaign narrative ("Q1 2026
    //    SOC 2 access review — focus on engineering admin access").
    //  - AccessReviewDecision.notes: per-user justification for
    //    REVOKE / MODIFY ("Removed because user left engineering
    //    on 2026-04-15").
    //  Adding these to the manifest is also necessary because the
    //  fan-out write path encrypts any field NAMED `notes` (it
    //  appears on four other models). Without an explicit entry
    //  the read path wouldn't know to decrypt, returning the v2:
    //  ciphertext to callers.
    AccessReview: ['description'],
    // PR-6 — background-check result can quote adverse-action detail.
    BackgroundCheck: ['resultSummary'],
    AccessReviewDecision: ['notes'],

    // ─── Epic G-5 control exception register ───────────
    //  `justification` carries the rationale for accepting risk;
    //  surfaces in audit packs alongside the approver. The
    //  `rejectionReason` field is the parallel free-text capture
    //  on REJECTED rows. Both contain narrative that may name
    //  internal users / systems, so they're encrypted at rest.
    ControlException: ['justification', 'rejectionReason'],
    // GDPR data-subject requests. Both columns are narrative text ABOUT AN
    // IDENTIFIED PERSON who has exercised a privacy right — why their request
    // was refused, and what was done to fulfil it. That is the most sensitive
    // free text the platform holds by subject matter, and it was shipping in
    // plaintext until 20260822010000.
    //
    // Nothing was bypassed. The model is deliberately USER-scoped and carries
    // no `tenantId`, so it was outside `TENANT_SCOPED_MODELS` — and the
    // coverage guard scans tenant-scoped columns only. Listing the model for
    // RLS put these two into that guard's denominator for the first time, and
    // it failed immediately. One absence hid the table from two guards.
    //
    // The D.2 write-path requirement is met for both, but by TWO DIFFERENT
    // mechanisms, and the distinction is the point of this comment.
    //
    //   `fulfilmentNotes`  — genuinely free text, sanitised via
    //                        `sanitizeOptional` in `dsar-register.ts`.
    //   `rejectionReason`  — written RAW at `dsar-register.ts:236`
    //                        (`input.reason ?? null`) and NOT sanitised. What
    //                        protects it is the allowlist at :204-212: the
    //                        write is gated on `input.to === 'REJECTED'` and
    //                        `requiresReason` is exactly that same condition,
    //                        so the check always runs first and the column can
    //                        only ever hold one of the three values in
    //                        `DSAR_REJECTION_REASONS`. Sanitising a closed
    //                        vocabulary would be a no-op.
    //
    // Written out because the protection is easy to lose by accident. Add an
    // `other: please specify` reason, or widen the vocabulary to free text, and
    // the allowlist stops protecting anything — while the rich-text sanitiser
    // ratchet stays GREEN, because it is file-level and `dsar-register.ts` does
    // sanitise the sibling column.
    //
    // `tests/unit/dsar-rejection-reason-allowlist.test.ts` is what fails
    // instead: it pins every allowed value to a fixed token shape, and asserts
    // both that a free-text reason is refused and that each allowlisted one
    // gets through. Widening the vocabulary breaks the first; deleting the
    // check breaks the other two.
    //
    // Neither column is used in a `contains` / `startsWith` / `orderBy`
    // anywhere in `src/`, so encryption is safe.
    // No backfill migration: production holds zero DataSubjectRequest rows
    // (measured, not assumed).
    DataSubjectRequest: ['rejectionReason', 'fulfilmentNotes'],
    // EU AI Act registry — a system's purpose + use-context can describe
    // sensitive business processes / data flows. Sanitised on write, encrypted
    // at rest. NOT searched (no contains/orderBy), so encryption is safe.
    AiSystem: ['purpose', 'useContext'],

    // ─── RQ2-1 risk score provenance ───────────────────
    //  `justification` carries the assessor's narrative for a score
    //  change ("transferred via cyber insurance", "pen-test found
    //  the control bypassed") — business free-text that may name
    //  internal systems / vendors / people. Encrypted at rest like
    //  every other rationale column. The explicit entry also keeps
    //  the manifest aligned with the fan-out write path, which
    //  already encrypts any field NAMED `justification` (it appears
    //  on ControlException) — without this entry the encryption
    //  would be incidental rather than declared.
    RiskScoreEvent: ['justification'],

    // ─── Epic MCP Phase 3 — agent proposal queue ───────
    // `payloadJson` is the agent-proposed business content (risk/control/policy/
    // finding fields), `rationale` the agent's reasoning. Both are free-text
    // business content that lands before a human approves it into a real record
    // — encrypt at rest. Neither is used in a WHERE/orderBy (queries filter on
    // tenantId/status/createdAt), so encryption is safe.
    AgentProposal: ['payloadJson', 'rationale'],

    // ─── Epic Agentic 1A — workflow engine ─────────────
    // WorkflowRun.contextJson (accumulated run state — carries tenant business
    // content gathered by read steps) + .summary (the output readiness report).
    // WorkflowStep.inputJson/outputJson (per-step tool payloads). All free-text
    // business content that lands as the workflow runs — encrypt at rest. None
    // is used in a WHERE/orderBy (queries filter on tenantId/status/runId/seq).
    WorkflowRun: ['contextJson', 'summary'],
    WorkflowStep: ['inputJson', 'outputJson'],

    // ─── Epic G-7 risk treatment plans ─────────────────
    //  Both columns can name internal systems / vendors / users:
    //    - RiskTreatmentPlan.closingRemark — narrative rationale
    //      written when a plan is marked COMPLETED.
    //    - TreatmentMilestone.description — milestone detail; may
    //      reference vendors, internal teams, or sensitive
    //      infrastructure.
    RiskTreatmentPlan: ['closingRemark'],
    TreatmentMilestone: ['description'],
    // NIS2 gap-assessment answer rationale — free text the respondent
    // writes to justify a NO/PARTIALLY answer; may name internal systems,
    // gaps, or vendor exposure. Encrypted at rest like every other
    // business-content free-text field.
    Nis2SelfAssessmentAnswer: ['note'],
    // AI-governance self-assessment rationale — per-question free text that may
    // describe AI risk gaps or exposure. Encrypted at rest + sanitised on write.
    AiGovSelfAssessmentAnswer: ['note'],

    // ─── NIS2 Article 23 incident response ─────────────
    //  Live security-incident narrative — the highest attacker value
    //  in the product (what was breached, when, how, what data was
    //  exposed). Encrypted at rest like Finding.
    //    - Incident.description — the incident narrative.
    //    - IncidentNotification.submissionNote — the report text filed
    //      with the authority (may quote the breach scope verbatim).
    //      `submissionRef` stays plaintext (authority case ref — a
    //      load-bearing lookup key, not sensitive content).
    //    - IncidentTimelineEntry.entry — the forensic narrative log.
    Incident: ['description'],
    IncidentNotification: ['submissionNote'],
    IncidentTimelineEntry: ['entry'],

    // ─── Auditor return channel (feat/auditor-return-channel) ──
    //  `body` is free text authored by an EXTERNAL auditor over a
    //  shared-pack token — a comment, evidence request, or raised
    //  finding/question flowing back to the tenant. It can quote
    //  audit gaps, control weaknesses, or the auditor's own
    //  assessment narrative, so it carries the same attacker value
    //  as Finding.description. Sanitised on write (sanitizePlainText)
    //  + encrypted at rest. Not searched (no contains/orderBy).
    AuditPackShareComment: ['body'],
} as const;

/** Set of model names with at least one encrypted field. Fast-path check. */
export const ENCRYPTED_MODELS: ReadonlySet<string> = new Set(
    Object.keys(ENCRYPTED_FIELDS),
);

/**
 * Union of every encrypted field name across every model in the
 * manifest. Used by the middleware's fan-out path to short-circuit
 * node traversal: if a node has no keys that intersect this set, it
 * contains no encrypted fields and we can skip the per-model
 * iteration entirely.
 *
 * Correctness note: multiple models share some field names
 * (`description` appears on Finding + Vendor + VendorEvidenceBundle;
 * `notes` on four models). The fan-out path does NOT distinguish
 * which model a nested node belongs to — it relies on the flat set
 * to gate whether decryption is even possible on this node. The
 * per-value `isEncryptedValue()` gate then decides whether to actually
 * decrypt. Plaintext fields that happen to share a name with an
 * encrypted field on another model (e.g. `Risk.description` — not in
 * the manifest) are safe: they don't have the `v1:` prefix so the
 * decrypt is skipped.
 */
export const ALL_ENCRYPTED_FIELD_NAMES: ReadonlySet<string> = new Set(
    Object.values(ENCRYPTED_FIELDS).flat(),
);

/**
 * Fast check: does this node contain any key that could possibly be
 * an encrypted field? Used by the middleware to skip the traversal
 * entirely when a node (or nested included relation) has no
 * manifest-visible fields.
 */
export function nodeHasAnyEncryptedFieldKey(
    node: Record<string, unknown>,
): boolean {
    for (const key of Object.keys(node)) {
        if (ALL_ENCRYPTED_FIELD_NAMES.has(key)) return true;
    }
    return false;
}

/**
 * Returns the encrypted-field list for a model, or `undefined` if
 * the model has no encrypted fields. Callers MUST NOT mutate the
 * returned array.
 */
export function getEncryptedFields(
    modelName: string | undefined,
): readonly string[] | undefined {
    if (!modelName) return undefined;
    return ENCRYPTED_FIELDS[modelName];
}

/** Predicate — is this model in the manifest? */
export function isEncryptedModel(modelName: string | undefined): boolean {
    return modelName !== undefined && ENCRYPTED_MODELS.has(modelName);
}
