/**
 * Guardrail: Epic C.5 / D.2 — rich-text sanitiser coverage (structural).
 *
 * ─── Why this is structural, not a numeric floor ────────────────────
 *
 * The previous incarnation kept a hand-curated list of usecases plus
 * `SANITISER_COVERAGE_FLOOR = 8` — a MINIMUM. That was a weak signal:
 * the floor went green while the real coverage drifted to 15 sanitised
 * usecases, and — worse — a *new* rich-text write path could land with
 * no sanitiser and the floor-of-8 would never notice (the eight known
 * entries were all still present). "At least N" cannot prove
 * completeness.
 *
 * This version derives the rich-text inventory from an authoritative,
 * already-maintained registry: `ENCRYPTED_FIELDS` in
 * `src/lib/security/encrypted-fields.ts`. Epic B REQUIRES every
 * business-content text field to be listed there (it drives
 * encrypt-on-write / decrypt-on-read). So:
 *
 *   - every encrypted business-content model IS a rich-text surface;
 *   - this guardrail asserts every such model is CLASSIFIED — either
 *     `RICH_TEXT_COVERAGE` (a usecase sanitises it),
 *     `NON_RICH_TEXT_MODELS` (the encrypted value is not user-supplied
 *     rich text — e.g. a generated secret), or `KNOWN_UNCOVERED`
 *     (a real, named gap, ratcheting to zero);
 *   - a NEW encrypted model — which a new rich-text field forces into
 *     `ENCRYPTED_FIELDS` — that is in NONE of the three buckets fails
 *     this test. That is the completeness guarantee the floor lacked.
 *
 * Server-side sanitisation must run BEFORE the row is persisted:
 * render-time sanitisation alone leaves the row dangerous to PDF
 * export, audit-pack share links, and SDK consumers reading it
 * verbatim.
 */

import * as fs from 'fs';
import * as path from 'path';

import { codeOf } from '../helpers/source-blocks';

import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';

const REPO_ROOT = path.resolve(__dirname, '../..');

type Sanitizer = 'sanitizeRichTextHtml' | 'sanitizePlainText' | 'sanitizePolicyContent';

/**
 * Encrypted-content model → the usecase file(s) that route its
 * user-supplied free text through a sanitiser before the repository
 * write, and the sanitiser they are expected to use.
 *
 * Keyed by Prisma model name (matching `ENCRYPTED_FIELDS`). When a new
 * encrypted business-content model lands, add it here (or to one of
 * the two exclusion maps below) — the completeness test fails until
 * every `ENCRYPTED_FIELDS` model is classified.
 */
const RICH_TEXT_COVERAGE: Readonly<
    Record<string, { usecases: readonly string[]; sanitizer: Sanitizer }>
> = {
    PolicyVersion: { usecases: ['src/app-layer/usecases/policy.ts'], sanitizer: 'sanitizePolicyContent' },
    Task: { usecases: ['src/app-layer/usecases/task.ts'], sanitizer: 'sanitizePlainText' },
    // `usecases/issue.ts` was the second write path here
    // (`addIssueComment`). Its `/issues` routes were retired, the
    // function was deleted with the rest of that parallel work-item
    // surface, and `usecases/task.ts::addTaskComment` is now the only
    // way a TaskComment body is written.
    TaskComment: {
        usecases: ['src/app-layer/usecases/task.ts'],
        sanitizer: 'sanitizePlainText',
    },
    // `protectionReason` is wholly operator-authored: a note saying why an
    // account must never be offboarded. It is read back by the roster page and
    // will be read by anything that later renders the protected set, so it is
    // sanitised at the write path rather than at each reader.
    ConnectedIdentityAccount: {
        usecases: ['src/app-layer/usecases/identity-account-protection.ts'],
        sanitizer: 'sanitizePlainText',
    },
    // `rejectionReason` and `fulfilmentNotes` on a GDPR data-subject request.
    // Operator-authored narrative about an identified person, written through
    // `sanitizeOptional` in `dsar-register.ts` — a three-state preserving
    // wrapper (undefined = leave, null = clear) over `sanitizePlainText`.
    //
    // This model reached the manifest only when it was listed for RLS: it is
    // deliberately USER-scoped with no `tenantId`, and both the encryption
    // coverage guard and this one scan tenant-scoped models, so its columns sat
    // outside every denominator at once. The sanitising was already correct —
    // what was missing was the model's membership in the lists that check.
    DataSubjectRequest: {
        usecases: ['src/app-layer/usecases/dsar-register.ts'],
        sanitizer: 'sanitizePlainText',
    },
    // `detail` is mixed provenance: a provider rejection message is machine
    // -generated, but a REVERTED reason is written by a person, and the row is
    // read back by an operator surface and an auditor export. Sanitised in
    // `settle` rather than trusted because of the second case.
    IdentityWriteJournal: {
        usecases: ['src/app-layer/usecases/identity-write-journal.ts'],
        sanitizer: 'sanitizePlainText',
    },
    // `description` on a registered agent is the operator's own account of what
    // the agent does and what it may touch. Sanitised at the single
    // agent-registry write seam before the Epic B middleware encrypts it — the
    // register export and the operator surface both decrypt and render it.
    RegisteredAgent: { usecases: ['src/app-layer/usecases/agent-registry.ts'], sanitizer: 'sanitizePlainText' },
    Finding: { usecases: ['src/app-layer/usecases/finding.ts'], sanitizer: 'sanitizePlainText' },
    Risk: { usecases: ['src/app-layer/usecases/risk.ts'], sanitizer: 'sanitizePlainText' },
    // MCP agent proposals — payloadJson (proposed entity content) + rationale
    // (agent reasoning) are sanitised in createAgentProposal (sanitizeDeep /
    // sanitizePlainText) at the propose boundary before the Epic B middleware
    // encrypts them. The highest-risk surface: external-agent output entering IC.
    AgentProposal: { usecases: ['src/app-layer/usecases/agent-proposals.ts'], sanitizer: 'sanitizePlainText' },
    // AI-governance self-assessment answer rationale — sanitised at the single
    // saveAiGovAnswer write seam before the Epic B middleware encrypts `note`.
    AiGovSelfAssessmentAnswer: { usecases: ['src/app-layer/usecases/ai-gov-self-assessment.ts'], sanitizer: 'sanitizePlainText' },
    // Vuln integration — analyst note on a CVE↔asset link, sanitised at the
    // linkCveToAsset / updateVulnerabilityStatus write seams (sanitizeOptional
    // wraps sanitizePlainText for the three-state contract).
    AssetVulnerability: { usecases: ['src/app-layer/usecases/vulnerability.ts'], sanitizer: 'sanitizePlainText' },
    // Scanner ingestion — ScannerFinding.description (scanner message; can
    // quote source/secrets), sanitised in ingestScannerRun at the upsert
    // seam before the Epic B middleware encrypts it.
    ScannerFinding: { usecases: ['src/app-layer/usecases/scanner-ingestion.ts'], sanitizer: 'sanitizePlainText' },
    // BIA — analyst `notes` (SPOFs / recovery gaps), sanitised in
    // createBia/updateBia before the Epic B middleware encrypts them.
    BusinessImpactAnalysis: { usecases: ['src/app-layer/usecases/business-impact-analysis.ts'], sanitizer: 'sanitizePlainText' },
    // RQ3-6 — loss-event narrative + reviewer justification; sanitised
    // at the single createLossEvent write seam before the Epic B
    // middleware persists them.
    LossEvent: { usecases: ['src/app-layer/usecases/loss-event.ts'], sanitizer: 'sanitizePlainText' },
    Vendor: { usecases: ['src/app-layer/usecases/vendor.ts'], sanitizer: 'sanitizePlainText' },
    VendorDocument: { usecases: ['src/app-layer/usecases/vendor.ts'], sanitizer: 'sanitizePlainText' },
    VendorAssessment: { usecases: ['src/app-layer/usecases/vendor.ts'], sanitizer: 'sanitizePlainText' },
    VendorEvidenceBundle: {
        usecases: ['src/app-layer/usecases/vendor-assessment-review.ts'],
        sanitizer: 'sanitizePlainText',
    },
    Audit: { usecases: ['src/app-layer/usecases/audit.ts'], sanitizer: 'sanitizePlainText' },
    AuditChecklistItem: { usecases: ['src/app-layer/usecases/audit.ts'], sanitizer: 'sanitizePlainText' },
    ControlTestRun: { usecases: ['src/app-layer/usecases/control/test-plans.ts'], sanitizer: 'sanitizePlainText' },
    AccessReview: { usecases: ['src/app-layer/usecases/access-review.ts'], sanitizer: 'sanitizePlainText' },
    // PR-6 — background-check result summary (adverse-action detail).
    BackgroundCheck: { usecases: ['src/app-layer/usecases/training.ts'], sanitizer: 'sanitizePlainText' },
    AccessReviewDecision: { usecases: ['src/app-layer/usecases/access-review.ts'], sanitizer: 'sanitizePlainText' },
    ControlException: { usecases: ['src/app-layer/usecases/control/exceptions.ts'], sanitizer: 'sanitizePlainText' },
    AiSystem: { usecases: ['src/app-layer/usecases/ai-system.ts'], sanitizer: 'sanitizePlainText' },
    // RQ2-1/RQ2-2 — score-change justification narrative; sanitised
    // at the single recordScoreEvent write seam.
    RiskScoreEvent: { usecases: ['src/app-layer/usecases/risk-score-events.ts'], sanitizer: 'sanitizePlainText' },
    RiskTreatmentPlan: { usecases: ['src/app-layer/usecases/risk-treatment-plan.ts'], sanitizer: 'sanitizePlainText' },
    TreatmentMilestone: { usecases: ['src/app-layer/usecases/risk-treatment-plan.ts'], sanitizer: 'sanitizePlainText' },
    // NIS2 Article 23 incident response — incident narrative, the filed
    // regulatory-report text, and the forensic timeline entries are all
    // user-supplied free text, sanitised at the incident usecase write
    // seams before the Epic B middleware persists them.
    Incident: { usecases: ['src/app-layer/usecases/incident.ts'], sanitizer: 'sanitizePlainText' },
    IncidentNotification: { usecases: ['src/app-layer/usecases/incident.ts'], sanitizer: 'sanitizePlainText' },
    IncidentTimelineEntry: { usecases: ['src/app-layer/usecases/incident.ts'], sanitizer: 'sanitizePlainText' },
    // feat/auditor-return-channel — AuditPackShareComment.body is external-
    // auditor free text (comment / evidence request / finding / question)
    // arriving over a public shared-pack token; sanitised at the single
    // addShareComment write seam before the Epic B middleware encrypts it.
    AuditPackShareComment: { usecases: ['src/app-layer/usecases/audit-readiness/sharing.ts'], sanitizer: 'sanitizePlainText' },
    // `EvidenceReview.comment` is the reviewer's rationale — including the
    // MANDATORY rejection reason. It is decrypted by the evidence UI, the owner
    // notification, the audit trail, PDF export and the audit-pack share link,
    // so it is sanitised at the single `reviewEvidence` write seam via the
    // three-state-preserving `sanitizeOptional` wrapper. The bulk-approve path
    // writes the source constant 'Bulk approved' — no user input reaches it.
    EvidenceReview: {
        usecases: ['src/app-layer/usecases/evidence.ts'],
        sanitizer: 'sanitizePlainText',
    },
    // `Nis2SelfAssessmentAnswer.note` (answer rationale) has TWO write seams and
    // both sanitise: the wizard autosave (`onboarding-nis2.ts::saveNis2Answer`)
    // and the delegated multi-respondent submit
    // (`gap-assessment-assignment.ts::submitAssignmentAnswers`). Listing both is
    // load-bearing — a sanitiser dropped from either one fails this guard.
    Nis2SelfAssessmentAnswer: {
        usecases: [
            'src/app-layer/usecases/onboarding-nis2.ts',
            'src/app-layer/usecases/gap-assessment-assignment.ts',
        ],
        sanitizer: 'sanitizePlainText',
    },
};

/**
 * Encrypted models whose encrypted field is NOT user-supplied rich
 * text — sanitisation does not apply. Each carries a written reason.
 */
const NON_RICH_TEXT_MODELS: Readonly<Record<string, string>> = {
    TenantSecuritySettings:
        'auditStreamSecretEncrypted is a system-generated HMAC secret, ' +
        'never user-supplied free text — there is nothing to sanitise.',
    AutomationRule:
        'webhookSecretEncrypted is an HMAC signing key. It is opaque bytes ' +
        'used only as a crypto key — never rendered, never user rich text. ' +
        'Sanitising it would corrupt the signature.',
    WorkflowRun:
        'contextJson/summary are engine-internal accumulated state — a JSON ' +
        'snapshot of read-tool outputs (tenant data already sanitised at its own ' +
        'write path) plus engine-generated synthesis text. Not a new user-supplied ' +
        'rich-text input; any PROPOSED content is sanitised by createAgentProposal ' +
        'before it enters the AgentProposal queue.',
    WorkflowStep:
        'inputJson/outputJson are per-step tool payloads (engine-internal), same ' +
        'reasoning as WorkflowRun — derived from already-sanitised reads + engine ' +
        'synthesis, never rendered as HTML; proposed content is sanitised downstream.',
};

/**
 * Real, named coverage gaps — encrypted business-content models whose
 * write path is not yet proven to sanitise. This is a RATCHET: it must
 * trend to zero. Each entry carries a written reason + a ratchet
 * target. A new entry here is a deliberate, reviewed admission — not a
 * place to silently park new rich-text surfaces.
 */
const KNOWN_UNCOVERED: Readonly<Record<string, string>> = {
    // EMPTY — the ratchet reached zero. The last two entries
    // (EvidenceReview, Nis2SelfAssessmentAnswer) were closed by wiring
    // sanitizePlainText into `evidence.ts::reviewEvidence` and
    // `gap-assessment-assignment.ts::submitAssignmentAnswers`. The
    // Nis2SelfAssessmentAnswer reason had also gone stale: it claimed "no write
    // usecase yet", but by then TWO existed — `onboarding-nis2.ts` (already
    // sanitising) and the delegated-submit path (not). A stale reason on a
    // ratchet entry is how a real gap hides in plain sight, which is why the
    // KNOWN_UNCOVERED cap below is now 0 rather than a standing allowance.
};

const fileExists = (rel: string) => fs.existsSync(path.join(REPO_ROOT, rel));
// codeOf() masks comments at the READ SEAM (#2246): the import/call assertions
// below are about CODE — a comment naming `sanitizePlainText(` must not stand
// in for the call. String literals are preserved (the import path is one).
const readFile = (rel: string) => codeOf(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));

describe('rich-text sanitiser coverage — structural completeness', () => {
    it('every encrypted-content model is classified (the completeness guarantee)', () => {
        // A new rich-text field forces its model into ENCRYPTED_FIELDS
        // (Epic B requirement). If that model is in none of the three
        // buckets, it is an unclassified rich-text surface — fail.
        const classified = new Set([
            ...Object.keys(RICH_TEXT_COVERAGE),
            ...Object.keys(NON_RICH_TEXT_MODELS),
            ...Object.keys(KNOWN_UNCOVERED),
        ]);
        const unclassified = Object.keys(ENCRYPTED_FIELDS).filter(
            (m) => !classified.has(m),
        );
        if (unclassified.length > 0) {
            throw new Error(
                [
                    `Encrypted business-content model(s) not classified for`,
                    `rich-text sanitiser coverage:`,
                    ...unclassified.map((m) => `  - ${m}`),
                    ``,
                    `Each ENCRYPTED_FIELDS model is a rich-text surface. Add`,
                    `it to RICH_TEXT_COVERAGE (with the sanitising usecase),`,
                    `NON_RICH_TEXT_MODELS (if the value is not user rich`,
                    `text), or KNOWN_UNCOVERED (a real gap, with a reason).`,
                ].join('\n'),
            );
        }
    });

    it('detects an unclassified new encrypted model (regression proof)', () => {
        // Simulate a new rich-text field landing on a new model — Epic B
        // forces it into ENCRYPTED_FIELDS. With no classification entry
        // it must be flagged: this is the bypass the old numeric floor
        // could not catch.
        const classified = new Set([
            ...Object.keys(RICH_TEXT_COVERAGE),
            ...Object.keys(NON_RICH_TEXT_MODELS),
            ...Object.keys(KNOWN_UNCOVERED),
        ]);
        const withNewModel = { ...ENCRYPTED_FIELDS, NewlyAddedRichTextModel: ['body'] };
        const unclassified = Object.keys(withNewModel).filter(
            (m) => !classified.has(m),
        );
        expect(unclassified).toEqual(['NewlyAddedRichTextModel']);
    });

    it('no classification entry references a model absent from ENCRYPTED_FIELDS (no stale)', () => {
        const stale = [
            ...Object.keys(RICH_TEXT_COVERAGE),
            ...Object.keys(NON_RICH_TEXT_MODELS),
            ...Object.keys(KNOWN_UNCOVERED),
        ].filter((m) => !(m in ENCRYPTED_FIELDS));
        expect(stale).toEqual([]);
    });

    it('NON_RICH_TEXT_MODELS + KNOWN_UNCOVERED each carry a written reason', () => {
        for (const reason of [
            ...Object.values(NON_RICH_TEXT_MODELS),
            ...Object.values(KNOWN_UNCOVERED),
        ]) {
            expect(reason.trim().length).toBeGreaterThan(20);
        }
    });

    it('KNOWN_UNCOVERED is a ratchet — it is now at zero', () => {
        // Reached zero. Re-admitting an entry here means raising this cap in
        // the same diff, which is the conversation the ratchet exists to force.
        expect(Object.keys(KNOWN_UNCOVERED).length).toBeLessThanOrEqual(0);
    });

    const coverageEntries = Object.entries(RICH_TEXT_COVERAGE).flatMap(
        ([model, { usecases, sanitizer }]) =>
            usecases.map((u) => [model, u, sanitizer] as const),
    );

    it.each(coverageEntries)(
        '%s — %s imports AND calls %s',
        (model, relPath, sanitizer) => {
            if (!fileExists(relPath)) {
                throw new Error(
                    `RICH_TEXT_COVERAGE[${model}] references a missing file: ` +
                        `${relPath}. If the usecase moved, update the path.`,
                );
            }
            const src = readFile(relPath);
            const importRe = new RegExp(
                String.raw`import\s+\{[^}]*\b${sanitizer}\b[^}]*\}\s+from\s+['"]@/lib/security/sanitize['"]`,
            );
            if (!importRe.test(src)) {
                throw new Error(
                    `${relPath} (rich-text writer for ${model}) does not ` +
                        `import { ${sanitizer} } from '@/lib/security/sanitize'. ` +
                        `Server-side sanitisation must run before the repository ` +
                        `write.`,
                );
            }
            const withoutImport = src.replace(src.match(importRe)?.[0] ?? '', '');
            if (!new RegExp(String.raw`\b${sanitizer}\s*\(`).test(withoutImport)) {
                throw new Error(
                    `${relPath} imports ${sanitizer} but never calls it — ` +
                        `a dangling import is a silent bypass for ${model}.`,
                );
            }
        },
    );
});
