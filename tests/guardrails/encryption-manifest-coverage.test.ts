/**
 * Encryption-manifest coverage ratchet — makes field-level encryption
 * OPT-OUT-WITH-JUSTIFICATION instead of opt-in-by-memory.
 *
 * ## The gap this closes
 *
 * `src/lib/security/encrypted-fields.ts` (`ENCRYPTED_FIELDS`) is a
 * hand-maintained manifest: a column is encrypted at rest ONLY if a
 * human remembered to list it there. Nothing stopped a new sensitive
 * column — `Finding.investigationNotes`, say — from shipping in
 * plaintext simply because the author didn't know the manifest existed.
 * The architecture review flagged this as the last opt-in-safety gap.
 *
 * ## The invariant
 *
 * For every `String` / `String?` column on a **tenant-scoped** model
 * (`TENANT_SCOPED_MODELS`) whose NAME looks sensitive (matches
 * `SENSITIVITY_HEURISTIC` — note / comment / description / summary /
 * content / reason / answer / body / detail / finding / remediation /
 * treatment), that column MUST be one of:
 *
 *   (a) listed in `ENCRYPTED_FIELDS` — encrypted at rest; OR
 *   (b) listed in `NOT_SENSITIVE` below with a one-line written reason
 *       for why it ships plaintext.
 *
 * A brand-new sensitive-shaped column that is neither fails CI. The
 * author must then make a CONSCIOUS choice — encrypt it (add to the
 * manifest) or justify the plaintext (add to `NOT_SENSITIVE`) — rather
 * than silently shipping plaintext.
 *
 * ## Scope + limits (deliberate)
 *
 *   - NAME heuristic, not content analysis: a column called `status`
 *     that happens to hold a paragraph is invisible here, and a column
 *     called `description` that holds an enum is a false positive that
 *     `NOT_SENSITIVE` absorbs. The heuristic is tuned to the free-text
 *     columns this product actually ships; widen it as new shapes
 *     appear.
 *   - `String` scalars only. JSON/`Json` blobs (`payloadJson`,
 *     `contextJson`) are encrypted where needed but are not name-shaped
 *     for this scan; they are covered by the manifest + the write-path
 *     sanitisation guards, not here.
 *   - Tenant-scoped only. Global library tables (Framework, Clause,
 *     templates) carry no per-tenant content and are out of scope, the
 *     same carve-out `ENCRYPTED_FIELDS` documents.
 *
 * ## Ratchet policy
 *
 *   - `NOT_SENSITIVE` only shrinks in spirit: when a listed column is
 *     encrypted (moved into `ENCRYPTED_FIELDS`) or deleted, its
 *     `NOT_SENSITIVE` entry becomes stale and the no-stale test forces
 *     its removal in the same PR.
 *   - Seeded from the current schema so this lands GREEN with zero
 *     behaviour change; it bites only on NEW unclassified columns.
 */
import { parseSchemaModels } from '../helpers/prisma-schema-models';
import { TENANT_SCOPED_MODELS } from '@/lib/db/rls-middleware';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';

// A column name that *looks* like it holds free-text business content.
// Kept in sync (by intent) with the columns this product ships; widen
// as new sensitive shapes appear.
const SENSITIVITY_HEURISTIC =
    /note|comment|description|summary|content|reason|answer|body|detail|finding|remediation|treatment/i;

/**
 * Curated opt-out list: sensitive-SHAPED `String` columns on
 * tenant-scoped models that ship PLAINTEXT, each with a one-line reason.
 * Key is `Model.field`. Adding an entry is a conscious decision that a
 * reviewer can see; the no-stale test deletes it the moment the column
 * is encrypted or removed.
 */
const NOT_SENSITIVE: Readonly<Record<string, string>> = {
    'TenantCalendarConsent.revokedReason': 'A fixed operator-facing phrase written by our own code and capped at 200 chars ("withdrawn by administrator"), shown on the admin settings page — never a provider body and never user text. Encrypting it would hide the one field that page exists to display.',
    'UserCalendarEventMapping.contentHash': 'A truncated SHA-256 DIGEST of the pushed event fields, never the fields themselves — it exists so a change can be detected without reading the remote back. Encrypting a hash defeats the equality comparison that is its only use, and the plaintext it summarises is a compliance deadline title the user can already see in their own calendar.',
    'UserCalendarConnection.revokedReason': 'A fixed operator-facing phrase shown in account settings ("consent withdrawn", "refresh returned invalid_grant"), written by our own code and capped at 200 chars — never a provider response body, never user text. Encrypting it would hide the one field the settings surface exists to display.',
    // ── Heuristic false positives: the name matched but the column is an
    //    identifier (FK), not free text. ──────────────────────────────
    'AiGovSelfAssessmentAnswer.answeredById':
        'FK — User id, not content (heuristic matched "answer").',
    'Nis2SelfAssessmentAnswer.answeredById':
        'FK — User id, not content (heuristic matched "answer").',
    'FindingEvidence.findingId':
        'FK — Finding id, not content (heuristic matched "finding").',
    'FindingRisk.findingId':
        'FK — Finding id, not content (heuristic matched "finding").',
    'FindingAsset.findingId':
        'FK — Finding id, not content (heuristic matched "finding").',
    'Task.findingId':
        'FK — Finding id (TP-3 remediation-task relation), not content (heuristic matched "finding").',
    'VendorPostureEvent.createdFindingId':
        'FK — created-Finding id, not content (heuristic matched "finding").',
    'VendorAnswerProposal.createdAnswerId':
        'FK — created-answer id, not content (heuristic matched "answer").',
    'RiskAppetiteBreach.remediationTaskId':
        'FK — Task id, not content (heuristic matched "remediation").',
    'AssetVulnerability.remediationTaskId':
        'FK — remediation Task id, not content (heuristic matched "remediation").',
    'KriReading.remediationTaskId':
        'FK — remediation Task id, not content (heuristic matched "remediation").',
    'TreatmentMilestone.treatmentPlanId':
        'FK — RiskTreatmentPlan id, not content (heuristic matched "treatment").',

    // ── Structured answer VALUES (enum-ish); the free-text rationale
    //    lives on the sibling `note` column, which IS encrypted. ───────
    'AiGovSelfAssessmentAnswer.answer':
        'Structured answer value (YES/NO/PARTIALLY); rationale is `note` (encrypted).',
    'Nis2SelfAssessmentAnswer.answer':
        'Structured answer value (YES/NO/PARTIALLY); rationale is `note` (encrypted).',

    // ── Deliberately plaintext to preserve substring search. Each is
    //    the documented "searched via <Repo> contains" carve-out in
    //    encrypted-fields.ts; encrypting requires dropping the search. ─
    'Risk.description':
        'Searched via RiskRepository `contains`; encryption pending a product decision (encrypted-fields.ts header).',
    'Policy.description':
        'Searched via PolicyRepository `contains` (encrypted-fields.ts header).',
    'Evidence.content':
        'Searched via EvidenceRepository `contains` (encrypted-fields.ts header).',

    // ── Admin-authored CONFIGURATION labels, not tenant business
    //    records. Low breach value; sanitised at the usecase. ──────────
    'AutomationRule.description': 'Automation-rule config label.',
    'ControlTestPlan.description': 'Test-plan configuration label.',
    'KeyRiskIndicator.description': 'KRI metric definition (config), not incident content.',
    'ProcessMap.description': 'Process-map config description.',
    'ReportTemplate.description': 'Report-template config description.',
    'TenantCustomRole.description': 'RBAC custom-role config description.',
    'VendorAssessmentTemplate.description': 'Questionnaire-template config description.',
    'VendorAssessmentTemplateSection.description':
        'Questionnaire-template section config description.',
    // ── DERIVED / aggregate summaries — computed from other columns,
    //    or bounded + sanitised by contract; not primary free text. ────
    'CompliancePostureSummary.summaryText':
        'Derived posture narrative computed from metrics, not primary user input.',
    'AiDecisionLog.outputSummary':
        'Bounded, sanitised AI-output summary — never raw content (schema contract).',
    'VendorPostureEvent.summary':
        'Derived vendor-monitoring event summary from public posture signals.',

    // ── PUBLIC content — published to external viewers by design, so
    //    encryption would defeat the purpose. ─────────────────────────
    'TrustCenter.postureSummary':
        'PUBLIC trust-center content, published to external viewers by design.',

    // ── Link/join-table + operational annotations. Short, low breach
    //    volume; the substantive rationale lives on the parent record. ─
    'AccessReviewConnectedDecision.notes':
        'Connector projection of AccessReviewDecision.notes (parent IS encrypted).',
    'ControlEvidenceLink.note': 'Short annotation on a control↔evidence join row.',
    'ControlTestEvidenceLink.note': 'Short annotation on a test↔evidence join row.',
    'ClauseProgress.notes': 'Progress annotation on a framework-clause tracking row.',
    'KriReading.note': 'Short annotation on a single KRI datapoint reading.',
    'PolicyApproval.comment': 'Approver comment on a policy-approval step; low breach volume.',
    'AuditPack.notes': 'Operator note on an audit-pack export.',
    'RiskAppetiteBreach.acknowledgementNote':
        'Short acknowledgement note on an appetite-breach alert.',

    // ── Transient send-outbox rows — rendered email bodies, purged
    //    after delivery. ──────────────────────────────────────────────
    'NotificationOutbox.bodyText':
        'Transient rendered email body in the send outbox; purged after delivery.',
    'NotificationOutbox.bodyHtml':
        'Transient rendered email body (HTML) in the send outbox; purged after delivery.',

    // ── Operational / technical short values. ────────────────────────
    'FileRecord.scanDetails': 'AV-scan engine verdict detail, not user content.',
    'UserSession.revokedReason':
        'Short operational revocation reason (e.g. "logout", "admin_revoke").',
    'IntegrationConnection.authFailureReason':
        'System-generated auth-failure line ("Integration auth failed (401): host/path"); URL is scrubbed to host+path by safeUrl so no query-string token reaches it.',

    // ── Ephemeral AI drafts — exist only until accepted into a real
    //    record. ──────────────────────────────────────────────────────
    'RiskSuggestionItem.description':
        'AI-suggested draft risk text, ephemeral until accepted into a Risk.',

    // ── Short label beside an encrypted narrative column. ────────────
    'Risk.treatmentOwner':
        'Short owner label (person/team) beside the encrypted `treatmentNotes`; not narrative content.',

    // ── Append-only audit trail — encrypting breaks hash-chain
    //    integrity; investigation needs plaintext (encrypted-fields.ts). ─
    'AuditLog.details':
        'Append-only hash-chained audit trail — encrypting breaks entryHash integrity (encrypted-fields.ts header).',

    // ── Candidates for encryption, consciously DEFERRED to a follow-up
    //    (no behaviour change in the PR that introduced this guard). The
    //    guard surfaces them so the deferral stays visible. ────────────
    'RiskScenario.description':
        'Scenario narrative — candidate for encryption alongside Risk.treatmentNotes; deferred.',
    'VendorAssessment.reviewerNotes':
        'Reviewer notes — candidate for encryption alongside VendorAssessment.notes; deferred.',
    'VendorAssessmentAnswer.reviewerNotes':
        'Per-answer reviewer notes — candidate for encryption; deferred.',
    'QuestionnaireAnswerLibrary.answerText':
        'Reusable canned questionnaire-answer library text; candidate for encryption, deferred.',
    'InboundQuestionnaireItem.draftAnswer':
        'AI-drafted inbound-questionnaire answer; candidate for encryption, deferred.',
    'InboundQuestionnaireItem.acceptedAnswer':
        'Accepted inbound-questionnaire answer (security-posture disclosure); candidate for encryption, deferred.',
};

/** `Model.field` → true if the field is in the encryption manifest. */
function isEncrypted(model: string, field: string): boolean {
    const list = (ENCRYPTED_FIELDS as Record<string, readonly string[]>)[model];
    return list !== undefined && list.includes(field);
}

/**
 * Every sensitive-SHAPED `String` column on a tenant-scoped model:
 * `{ key: 'Model.field', model, field }`.
 */
function sensitiveShapedColumns(): { key: string; model: string; field: string }[] {
    const out: { key: string; model: string; field: string }[] = [];
    for (const m of parseSchemaModels()) {
        if (!TENANT_SCOPED_MODELS.has(m.name)) continue;
        for (const f of m.fields) {
            // Non-list String scalars only (`String` / `String?`).
            if (f.type !== 'String' || f.isList) continue;
            if (!SENSITIVITY_HEURISTIC.test(f.name)) continue;
            out.push({ key: `${m.name}.${f.name}`, model: m.name, field: f.name });
        }
    }
    return out;
}

describe('encryption-manifest coverage — no sensitive column ships plaintext by accident', () => {
    const columns = sensitiveShapedColumns();

    it('finds sensitive-shaped columns to police (sanity — the scan is live)', () => {
        // If this drops to ~0 the scan or the schema parser silently
        // broke; the whole ratchet would be a no-op.
        expect(columns.length).toBeGreaterThan(30);
    });

    it('every sensitive-shaped column is encrypted OR justified in NOT_SENSITIVE', () => {
        const offenders = columns.filter(
            (c) => !isEncrypted(c.model, c.field) && NOT_SENSITIVE[c.key] === undefined,
        );
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} tenant-scoped column(s) look sensitive but are neither ` +
                    `encrypted nor justified:\n` +
                    offenders.map((c) => `  ${c.key}`).join('\n') +
                    `\n\nField-level encryption is opt-OUT here. Choose one:\n` +
                    `  • Encrypt it: add "${'<field>'}" to the model's list in ` +
                    `src/lib/security/encrypted-fields.ts (follow the "Adding a new field" ` +
                    `checklist there — repository search + backfill).\n` +
                    `  • Justify plaintext: add '<Model>.<field>': '<one-line reason>' to ` +
                    `NOT_SENSITIVE in this file.\n\n` +
                    `Silently shipping a sensitive column in plaintext is exactly what this ` +
                    `guard exists to prevent.`,
            );
        }
    });

    it('has no NOT_SENSITIVE entries that are already encrypted (contradiction guard)', () => {
        const contradictory = Object.keys(NOT_SENSITIVE).filter((key) => {
            const [model, field] = key.split('.');
            return isEncrypted(model, field);
        });
        expect(contradictory).toEqual([]);
    });

    it('has no stale NOT_SENSITIVE entries (every entry is still a live plaintext sensitive column)', () => {
        const live = new Set(columns.map((c) => c.key));
        const stale = Object.keys(NOT_SENSITIVE)
            .filter((key) => !live.has(key))
            .sort();
        if (stale.length > 0) {
            throw new Error(
                `${stale.length} NOT_SENSITIVE entr(y/ies) are stale — the column was ` +
                    `encrypted, renamed, or deleted:\n` +
                    stale.map((k) => `  ${k}`).join('\n') +
                    `\n\nRemove them from NOT_SENSITIVE in this PR. The list only ` +
                    `moves down — a justified-plaintext exception must be deleted once ` +
                    `it is paid off.`,
            );
        }
    });

    it('every NOT_SENSITIVE reason is a non-trivial written sentence', () => {
        const tooShort = Object.entries(NOT_SENSITIVE)
            .filter(([, reason]) => reason.trim().length < 12)
            .map(([key]) => key);
        expect(tooShort).toEqual([]);
    });
});

// ─── Self-test: prove the heuristic + wiring actually fire ──────────
//
// Without this, a refactor that broke SENSITIVITY_HEURISTIC or the
// schema parse would make the forward test vacuously pass and let a
// plaintext-sensitive column slip through.
describe('encryption-manifest guard — detector self-test', () => {
    it('the heuristic matches the shapes the guard is meant to catch', () => {
        for (const name of [
            'investigationNotes', // the acceptance-criteria example
            'rootCauseSummary',
            'reviewerComment',
            'incidentDetail',
            'remediationPlan',
        ]) {
            expect(SENSITIVITY_HEURISTIC.test(name)).toBe(true);
        }
    });

    it('the heuristic ignores clearly non-content column names', () => {
        for (const name of ['status', 'tenantId', 'createdAt', 'score', 'slug', 'email']) {
            expect(SENSITIVITY_HEURISTIC.test(name)).toBe(false);
        }
    });

    it('a hypothetical new sensitive column with no classification WOULD fail', () => {
        // Simulate adding `Finding.investigationNotes`: sensitive-shaped,
        // not in ENCRYPTED_FIELDS, not in NOT_SENSITIVE. The forward
        // test's exact predicate must flag it.
        const model = 'Finding';
        const field = 'investigationNotes';
        const key = `${model}.${field}`;
        expect(SENSITIVITY_HEURISTIC.test(field)).toBe(true);
        expect(isEncrypted(model, field)).toBe(false);
        expect(NOT_SENSITIVE[key]).toBeUndefined();
        // => (not encrypted) && (not justified) === would-be offender.
        expect(!isEncrypted(model, field) && NOT_SENSITIVE[key] === undefined).toBe(true);
    });
});
