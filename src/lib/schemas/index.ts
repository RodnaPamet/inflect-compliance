/**
 * Zod schemas for all API request bodies.
 * All schemas use .strip() to remove unknown fields.
 *
 * Naming convention:
 *   Create<Entity>Schema — for POST (required fields)
 *   Update<Entity>Schema — for PUT (partial or full updates)
 *
 * GAP-10 — these schemas are also the single source of truth for the
 * generated OpenAPI spec. The `.openapi('Name', { description })` calls
 * below register each schema as a named component. Component naming
 * convention is documented in `src/lib/openapi/registry.ts`. Add
 * `.openapi(...)` to every NEW request schema when you add it.
 */
import { z } from '@/lib/openapi/zod';
// `AssetType` is a Prisma enum on a NOT NULL column. Declaring it as
// `z.string()` let any value through Zod and fail at the driver, which
// `withApiErrorHandling` could only render as a 500 — a validation error
// reported as a server fault. `z.nativeEnum` moves the rejection back to
// the boundary where it belongs. Safe to import here: this module is
// server-only (no 'use client' file imports it).
import { AssetType } from '@prisma/client';

export const EmptyBodySchema = z.object({}).strip().openapi('EmptyBody', {
    description: 'Empty request body. Used by mutation endpoints whose semantics live entirely in the URL (e.g. POST /restore on a soft-deleted resource).',
});

// ─── Assets ───

export const CreateAssetSchema = z.object({
    name: z.string().min(1, 'Name is required'),
    type: z.nativeEnum(AssetType),
    status: z.enum(['ACTIVE', 'RETIRED']).optional(),
    classification: z.string().optional(),
    owner: z.string().optional(),
    ownerUserId: z.string().optional().nullable(),    // Real user reference — the asset owner (people picker)
    location: z.string().optional(),
    confidentiality: z.coerce.number().int().min(1).max(5).optional().default(3),
    integrity: z.coerce.number().int().min(1).max(5).optional().default(3),
    availability: z.coerce.number().int().min(1).max(5).optional().default(3),
    dependencies: z.string().optional().nullable(),
    businessProcesses: z.string().optional().nullable(),
    dataResidency: z.string().optional().nullable(),
    retention: z.string().optional().nullable(),
    // Structured retention-expiry date (YYYY-MM-DD or ISO) — the machine date
    // the data-lifecycle sweep acts on, distinct from the free-text `retention`
    // policy note above. Coerced to a Date in the usecase.
    retentionUntil: z.string().optional().nullable(),
    // Product-identity fields — power CVE→asset matching (Asset.cpe/vendor/product/version).
    cpe: z.string().optional().nullable(),
    vendor: z.string().optional().nullable(),
    product: z.string().optional().nullable(),
    version: z.string().optional().nullable(),
    // External-system reference (CMDB id, ticket key, …). Displayed on the
    // detail page and editable in the create/edit forms — previously the
    // column existed and rendered but no schema accepted it, so it could
    // never be written via the API.
    externalRef: z.string().optional().nullable(),
}).strip().openapi('AssetCreateRequest', {
    description: 'Payload for creating a tenant asset. CIA scores default to 3 when omitted; classification + owner + location are free-text.',
});

export const UpdateAssetSchema = z.object({
    name: z.string().min(1).optional(),
    type: z.nativeEnum(AssetType).optional(),
    classification: z.string().optional(),
    owner: z.string().optional(),
    ownerUserId: z.string().optional().nullable(),    // Real user reference — "Assigned to"
    location: z.string().optional(),
    confidentiality: z.coerce.number().int().min(1).max(5).optional(),
    integrity: z.coerce.number().int().min(1).max(5).optional(),
    availability: z.coerce.number().int().min(1).max(5).optional(),
    dependencies: z.string().optional().nullable(),
    businessProcesses: z.string().optional().nullable(),
    dataResidency: z.string().optional().nullable(),
    retention: z.string().optional().nullable(),
    // Structured retention-expiry date (see CreateAssetSchema).
    retentionUntil: z.string().optional().nullable(),
    // Product-identity fields — power CVE→asset matching (Asset.cpe/vendor/product/version).
    cpe: z.string().optional().nullable(),
    vendor: z.string().optional().nullable(),
    product: z.string().optional().nullable(),
    version: z.string().optional().nullable(),
    // External-system reference (CMDB id, ticket key, …) — now editable.
    externalRef: z.string().optional().nullable(),
    // Item 29 — asset lifecycle status. Previously absent here, so the
    // schema's `.strip()` silently dropped any `status` in the body (the
    // edit modal's status field never persisted, and there was no
    // standalone status action). Now accepted so the detail-page status
    // control + the modal both take effect.
    status: z.enum(['ACTIVE', 'RETIRED']).optional(),
}).strip().openapi('AssetUpdateRequest', {
    description: 'Partial update for an asset. Every field is optional; only provided fields are persisted.',
});

/**
 * Bulk asset import — one request instead of N sequential client POSTs.
 * Each row mirrors CreateAssetSchema minus the derived `criticality`
 * (the server always derives it from the CIA triad — the CSV never had a
 * real criticality override, so the column was dead). The import usecase
 * dedupes by name (in-batch + against existing tenant assets) and resolves
 * a free-text `owner` to `ownerUserId` against the tenant roster. Capped at
 * 500 rows per request.
 */
export const BulkImportAssetsSchema = z.object({
    assets: z.array(z.object({
        name: z.string().min(1),
        type: z.nativeEnum(AssetType),
        status: z.enum(['ACTIVE', 'RETIRED']).optional(),
        classification: z.string().optional().nullable(),
        owner: z.string().optional().nullable(),
        ownerUserId: z.string().optional().nullable(),
        location: z.string().optional().nullable(),
        confidentiality: z.coerce.number().int().min(1).max(5).optional(),
        integrity: z.coerce.number().int().min(1).max(5).optional(),
        availability: z.coerce.number().int().min(1).max(5).optional(),
        externalRef: z.string().optional().nullable(),
        dependencies: z.string().optional().nullable(),
        businessProcesses: z.string().optional().nullable(),
        dataResidency: z.string().optional().nullable(),
        retention: z.string().optional().nullable(),
        // Structured retention-expiry date (YYYY-MM-DD or ISO) — matches the
        // per-asset create/update schemas so the CSV importer can bulk-set it.
        retentionUntil: z.string().optional().nullable(),
        cpe: z.string().optional().nullable(),
        vendor: z.string().optional().nullable(),
        product: z.string().optional().nullable(),
        version: z.string().optional().nullable(),
    }).strip()).min(1).max(500),
}).strip().openapi('AssetBulkImportRequest', {
    description: 'Bulk-create assets from a parsed CSV in a single request. Server derives criticality from CIA, dedupes by name, and resolves owner names to members.',
});

// ─── Risks ───

export const CreateRiskSchema = z.object({
    title: z.string().min(1, 'Title is required'),
    description: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    threat: z.string().optional(),
    vulnerability: z.string().optional(),
    impact: z.coerce.number().int().min(1).max(10).optional().default(3),
    likelihood: z.coerce.number().int().min(1).max(10).optional().default(3),
    treatment: z.string().optional().nullable(),
    treatmentOwner: z.string().optional().nullable(),
    treatmentNotes: z.string().optional().nullable(),
    ownerUserId: z.string().optional().nullable(),    // Real user reference — the risk owner (people picker)
    targetDate: z.string().optional().nullable(),
    nextReviewAt: z.string().optional().nullable(),
}).strip().openapi('RiskCreateRequest', {
    description: 'Payload for creating a risk. Inherent score = impact × likelihood; the server computes residualScore separately when treatment data lands. treatmentNotes is encrypted at rest (Epic B field-encryption manifest).',
});

export const UpdateRiskSchema = z.object({
    title: z.string().min(1).optional(),
    // description / category were MISSING here until 2026-08-05 while the
    // usecase wrote them (updateRisk) and the edit modal sent them — and
    // this schema ends in `.strip()`, so the values were silently dropped:
    // PUT returned 200, the modal closed, the edit was gone. That made
    // Risk.description and Risk.category effectively write-once-at-create
    // for the whole product. Shapes mirror CreateRiskSchema exactly so the
    // two paths cannot disagree about nullability.
    description: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    // `.nullable()` matters here, not just cosmetically: both columns are
    // `String?`, and the usecase honours an explicit null as "clear this".
    // Without it the schema rejected null with a 400, so the clear could
    // never reach the usecase — a second layer of the same unclearable-field
    // defect, found by the round-trip test rather than by reading the code.
    threat: z.string().optional().nullable(),
    vulnerability: z.string().optional().nullable(),
    impact: z.coerce.number().int().min(1).max(10).optional(),
    likelihood: z.coerce.number().int().min(1).max(10).optional(),
    // RQ2-1 — direct residual assessment (both-or-neither; the
    // usecase derives residualScore and rejects an incomplete pair).
    residualLikelihood: z.coerce.number().int().min(1).max(10).optional(),
    residualImpact: z.coerce.number().int().min(1).max(10).optional(),
    // RQ2-1 — optional rationale recorded on the score-provenance
    // ledger event when a score dimension changes.
    scoreJustification: z.string().max(2000).optional().nullable(),
    treatment: z.string().optional().nullable(),
    treatmentOwner: z.string().optional().nullable(),
    treatmentNotes: z.string().optional().nullable(),
    ownerUserId: z.string().optional().nullable(),    // Real user reference — "Assigned to"
    targetDate: z.string().optional().nullable(),
    // Same 2026-08-05 omission as description/category above: written by
    // updateRisk, sent by the detail page's Next-Review DatePicker, and
    // stripped in between.
    nextReviewAt: z.string().optional().nullable(),
}).strip().refine(
    (d) => (d.residualLikelihood === undefined) === (d.residualImpact === undefined),
    { message: 'residualLikelihood and residualImpact must be supplied together' },
).openapi('RiskUpdateRequest', {
    description: 'Partial update for a risk. All fields optional. residualLikelihood/residualImpact must be supplied together; residualScore is derived server-side and every score change lands a provenance event (RQ2-1).',
});

export const LinkRiskControlSchema = z.object({
    controlId: z.string().min(1, 'controlId is required'),
}).strip().openapi('RiskControlLinkRequest', {
    description: 'Body for linking an existing control to this risk (mitigation mapping).',
});

// ─── Risk Status & Mapping ───


export const SetRiskStatusSchema = z.object({
    // MITIGATED was missing until 2026-08-05 while it existed in the Prisma
    // RiskStatus enum, in BulkRiskStatusSchema, and in RISK_STATUS_VALUES —
    // which is what builds the detail page's status combobox. So the option
    // was offered, PATCHing it 400'd, and the identical transition succeeded
    // via bulk-select. Keep this list in step with BulkRiskStatusSchema; the
    // two are asserted equal in tests/unit/risk-status-enum-parity.test.ts.
    status: z.enum(['OPEN', 'MITIGATING', 'MITIGATED', 'ACCEPTED', 'CLOSED']),
}).strip().openapi('RiskSetStatusRequest', {
    description: 'Lifecycle transition for a risk. The five states form an open lattice; closed risks remain queryable via includeDeleted=true.',
});

export const MapRiskControlSchema = z.object({
    controlId: z.string().min(1, 'controlId is required'),
}).strip().openapi('RiskControlMapRequest', {
    description: 'Body for mapping a control to a risk (alternative endpoint to RiskControlLinkRequest; same shape, different surface).',
});

export const MapControlAssetSchema = z.object({
    assetId: z.string().min(1, 'assetId is required'),
}).strip().openapi('ControlAssetMapRequest', {
    description: 'Body for mapping an asset to a control (declares the asset is in scope for this control).',
});

// ─── Controls ───

export const CreateControlSchema = z.object({
    code: z.string().optional().nullable(),
    annexId: z.string().optional().nullable(),
    name: z.string().min(1, 'Name is required'),
    category: z.string().optional().nullable(),
    status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'IMPLEMENTED', 'NEEDS_REVIEW']).optional().default('NOT_STARTED'),
    frequency: z.enum(['AD_HOC', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY']).optional().nullable(),
    ownerUserId: z.string().optional().nullable(),
    evidenceSource: z.enum(['MANUAL', 'INTEGRATION']).optional().nullable(),
    automationKey: z.string().optional().nullable(),
    automationType: z.enum(['AUTOMATED', 'MANUAL', 'IT_DEPENDENT_MANUAL']).optional().nullable(),
    mitigationType: z.enum(['PREVENTIVE', 'DETECTIVE', 'DETERRENT', 'CORRECTIVE', 'COMPENSATING']).optional().nullable(),
    // createControl has always DECLARED and WRITTEN these three
    // (mutations.ts:33-35 -> :68-70), but they were missing here — and this
    // schema ends in .strip(), so POST /controls removed them before the
    // usecase ever saw them. The caller got a 201 with objective: null and
    // no warning. agent-proposals.ts parses through this schema too, so
    // AI-proposed controls lost them as well. Shapes match
    // UpdateControlSchema.
    objective: z.string().optional().nullable(),
    successCriteria: z.string().optional().nullable(),
    testingMethodology: z.string().optional().nullable(),
    isCustom: z.boolean().optional().default(true),
}).strip().openapi('ControlCreateRequest', {
    description: 'Payload for creating a control. Status defaults to NOT_STARTED. annexId references the framework annex catalogue (e.g. ISO 27001:2022 A.5.1). Custom controls (isCustom=true) are tenant-specific; framework-shipped controls install via the templates endpoint instead.',
});

export const UpdateControlSchema = z.object({
    name: z.string().min(1).optional(),
    code: z.string().optional().nullable(),
    // Internal-controls fields — Overview (objective, successCriteria) + Tests
    // (testingMethodology).
    objective: z.string().optional().nullable(),
    successCriteria: z.string().optional().nullable(),
    testingMethodology: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    frequency: z.enum(['AD_HOC', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY']).optional().nullable(),
    evidenceSource: z.enum(['MANUAL', 'INTEGRATION']).optional().nullable(),
    automationKey: z.string().optional().nullable(),
    automationType: z.enum(['AUTOMATED', 'MANUAL', 'IT_DEPENDENT_MANUAL']).optional().nullable(),
    mitigationType: z.enum(['PREVENTIVE', 'DETECTIVE', 'DETERRENT', 'CORRECTIVE', 'COMPENSATING']).optional().nullable(),
    // RQ3-8 — annual cost in the tenant's currency. Float (matches
    // the existing Risk money-field pattern); null clears the price.
    annualCost: z.number().nonnegative().optional().nullable(),
    // Declared operating effectiveness 0–100 — the ROI/residual fallback when a
    // control has no measured test history (measured pass rate wins otherwise).
    effectiveness: z.number().int().min(0).max(100).optional().nullable(),
}).strip().openapi('ControlUpdateRequest', {
    description: 'Partial update for a control. Status, applicability, and owner have dedicated focused endpoints; this body covers descriptive metadata only.',
});

export const SetControlStatusSchema = z.object({
    // The six the detail dropdown offers (page.tsx builds them from
    // buildControlStatusLabels). This accepted only four until 2026-08-06,
    // so selecting PLANNED or IMPLEMENTING returned 400 invalid_enum_value
    // from a control the UI presented as selectable.
    //
    // NOT_APPLICABLE is excluded here for the same reason as the bulk
    // schema: it is owned by the applicability action, which carries the
    // justification and the audit trail. With that one exclusion these two
    // enums are now identical, so all three status write paths agree.
    status: z.enum([
        'NOT_STARTED',
        'PLANNED',
        'IN_PROGRESS',
        'IMPLEMENTING',
        'IMPLEMENTED',
        'NEEDS_REVIEW',
    ]),
}).strip().openapi('ControlSetStatusRequest', {
    description: 'Lifecycle transition for a control. NEEDS_REVIEW signals a control whose evidence has lapsed or whose owner was removed.',
});

export const SetControlApplicabilitySchema = z.object({
    applicability: z.enum(['APPLICABLE', 'NOT_APPLICABLE']),
    justification: z.string().optional().nullable().default(null),
}).strip().openapi('ControlSetApplicabilityRequest', {
    description: 'Statement-of-applicability flag for a control. NOT_APPLICABLE controls are excluded from coverage metrics and audit packs but remain queryable.',
});

export const SetControlOwnerSchema = z.object({
    ownerUserId: z.string().nullable(),
}).strip().openapi('ControlSetOwnerRequest', {
    description: 'Reassign or unassign a control owner. Pass null to clear the owner; pass a userId to assign.',
});

export const AddContributorSchema = z.object({
    userId: z.string().min(1, 'userId is required'),
}).strip().openapi('ContributorAddRequest', {
    description: 'Add a user as a contributor to a control. Contributors get write access to the control without being the canonical owner.',
});

export const LinkEvidenceSchema = z.object({
    kind: z.enum(['FILE', 'LINK', 'INTEGRATION_RESULT']),
    fileId: z.string().optional().nullable(),
    url: z.string().url().optional().nullable(),
    note: z.string().optional().nullable(),
}).strip().openapi('EvidenceLinkRequest', {
    description: 'Attach evidence to a control. FILE kinds reference an uploaded FileRecord by id; LINK kinds carry a URL; INTEGRATION_RESULT kinds are emitted by automation runs.',
});

export const InstallTemplatesSchema = z.object({
    templateIds: z.array(z.string().min(1)).min(1, 'At least one template ID is required'),
}).strip().openapi('ControlTemplatesInstallRequest', {
    description: 'Install one or more framework-shipped control templates into the tenant. Idempotent — re-installing an already-installed template is a no-op.',
});

export const MapRequirementSchema = z.object({
    requirementId: z.string().min(1, 'requirementId is required'),
}).strip().openapi('ControlRequirementMapRequest', {
    description: 'Map a framework requirement to a control (e.g. asserting this control satisfies ISO 27001:2022 A.5.1).',
});

export const SetApplicabilitySchema = z.object({
    applicability: z.enum(['APPLICABLE', 'NOT_APPLICABLE']),
    justification: z.string().optional().nullable(),
}).strip().refine(
    (data) => data.applicability === 'APPLICABLE' || (data.justification && data.justification.trim().length > 0),
    { message: 'Justification is required when marking a control as Not Applicable', path: ['justification'] }
);

// ─── Policies ───

export const CreatePolicySchema = z.object({
    title: z.string().min(1, 'Title is required'),
    description: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    ownerUserId: z.string().optional().nullable(),
    reviewFrequencyDays: z.coerce.number().int().min(1).optional().nullable(),
    language: z.string().optional().nullable(),
    content: z.string().optional().nullable(), // initial content
    contentType: z.enum(['MARKDOWN', 'HTML']).optional(), // initial-version editor mode (Prompt-3.3)
    templateId: z.string().optional().nullable(), // create from template
}).strip().openapi('PolicyCreateRequest', {
    description: 'Create a policy. content (initial Markdown) AND templateId are optional but mutually exclusive — pass content for a from-scratch policy, templateId to spawn from a framework template. The first PolicyVersion is created server-side.',
});

export const UpdatePolicyMetadataSchema = z.object({
    title: z.string().min(1).optional(),
    description: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    ownerUserId: z.string().optional().nullable(),
    reviewFrequencyDays: z.coerce.number().int().min(1).optional().nullable(),
    nextReviewAt: z.string().optional().nullable(),
    language: z.string().optional().nullable(),
}).strip().openapi('PolicyMetadataUpdateRequest', {
    description: 'Update policy metadata only — title, owner, review cadence. Content edits go through the policy-version endpoint.',
});

export const CreatePolicyVersionSchema = z.object({
    contentType: z.enum(['MARKDOWN', 'HTML', 'EXTERNAL_LINK']),
    contentText: z.string().optional().nullable(),
    externalUrl: z.string().url('Must be a valid URL').optional().nullable(),
    changeSummary: z.string().optional().nullable(),
    /**
     * Save as a PROPOSAL rather than demoting the live policy.
     *
     * Creating a version on a PUBLISHED/APPROVED policy normally moves it back
     * to DRAFT — which withdraws it: `attestPolicy` requires PUBLISHED, so
     * every outstanding acknowledgement stops being possible. The usecase has
     * always supported `proposeOnly` to avoid exactly that (the SharePoint
     * pull uses it so an external edit never un-publishes a live policy), but
     * it was reachable only by calling the usecase directly — the HTTP schema
     * stripped it, so the UI could not ask for it.
     */
    proposeOnly: z.boolean().optional(),
}).strip().openapi('PolicyVersionCreateRequest', {
    description: 'Create a new draft version of a policy. contentText is required for MARKDOWN/HTML; externalUrl is required for EXTERNAL_LINK. contentText is sanitized + encrypted at rest. Set proposeOnly to save as a proposal without demoting a live PUBLISHED/APPROVED policy.',
});

export const RequestApprovalSchema = z.object({
    versionId: z.string().min(1, 'versionId is required'),
}).strip().openapi('PolicyApprovalRequestRequest', {
    description: 'Request approval for a draft policy version. Routes through the configured approver chain.',
});

export const DecideApprovalSchema = z.object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    comment: z.string().optional().nullable(),
}).strip().openapi('PolicyApprovalDecideRequest', {
    description: 'Approver decision on a pending policy version. Rejection requires no comment per spec but operators are encouraged to provide one.',
});

export const PublishPolicySchema = z.object({
    versionId: z.string().min(1, 'versionId is required'),
    // Emergency publish-bypass: a non-empty reason publishes a version that is
    // NOT APPROVED, recording a POLICY_PUBLISH_BYPASS audit row. Admin-only
    // (the usecase gates on canAdmin).
    bypassApprovalReason: z.string().trim().min(1).max(1000).optional(),
}).strip().openapi('PolicyPublishRequest', {
    description: 'Promote an approved policy version to PUBLISHED. Only one published version per policy at a time; the previous published version is archived. An admin may supply bypassApprovalReason to publish an un-approved version (audited).',
});

// ─── Evidence ───

// Shared internal base — no .openapi() metadata, so derived schemas
// (e.g. CreateEvidenceFormSchema) don't inherit a colliding component
// id. zod 4's metadata system propagates `.openapi(id)` through
// `.extend()` whereas zod 3 dropped it; building both schemas from
// this base prevents a duplicate-component-id collision in the
// OpenAPI document.
const _CreateEvidenceBase = z.object({
    // EP-3 — evidence↔control is many-to-many. `controlIds` creates ONE
    // Evidence + N EvidenceControlLink rows. `controlId` is retained for
    // backward-compat (wrapped into `[controlId]` at the usecase boundary).
    controlId: z.string().optional().nullable(),
    controlIds: z.array(z.string().min(1)).max(100).optional(),
    type: z.enum(['TEXT', 'FILE', 'LINK', 'SCREENSHOT']).optional().default('TEXT'),
    title: z.string().min(1, 'Title is required'),
    content: z.string().optional(),
    fileName: z.string().optional().nullable(),
    fileSize: z.coerce.number().optional().nullable(),
    category: z.string().optional().nullable(),
    // B8 follow-up — free-text folder label, capped at 120 chars to
    // match VendorDocument.folder. Sanitised + null-coerced at the
    // usecase boundary.
    folder: z.string().max(120).optional().nullable(),
    owner: z.string().optional().nullable(),          // Legacy free-text
    ownerUserId: z.string().optional().nullable(),    // Real user reference (preferred)
    reviewCycle: z.string().optional().nullable(),
    nextReviewDate: z.string().optional().nullable(),
});

export const CreateEvidenceSchema = _CreateEvidenceBase.strip().openapi('EvidenceCreateRequest', {
    description: 'Create an evidence record. type=FILE expects a paired multipart upload via /evidence/uploads; type=TEXT/LINK can use this JSON body directly. content is encrypted at rest for TEXT type.',
});

export const CreateEvidenceFormSchema = _CreateEvidenceBase.extend({
    file: z.any().optional(), // File object caught from FormData
}).strip();

export const UpdateEvidenceSchema = z.object({
    title: z.string().min(1).optional(),
    content: z.string().optional(),
    // EP-3 — multi-select control association. When present, the edit
    // reconciles EvidenceControlLink rows to exactly this set (adds/removes
    // links rather than moving the record). Omitted ⇒ links untouched.
    controlIds: z.array(z.string().min(1)).max(100).optional(),
    category: z.string().optional().nullable(),
    // B8 follow-up — folder is editable post-create so a tenant
    // can re-organise their evidence library after the fact.
    folder: z.string().max(120).optional().nullable(),
    owner: z.string().optional().nullable(),          // Legacy free-text
    ownerUserId: z.string().optional().nullable(),    // Real user reference (preferred)
    reviewCycle: z.string().optional().nullable(),
    nextReviewDate: z.string().optional().nullable(),
    // Tags — the second organisation dimension beside `folder`. When
    // present the edit reconciles EvidenceTag rows to exactly this set;
    // omitted ⇒ tags untouched (same three-state contract as controlIds).
    tags: z.array(z.string().min(1).max(40)).max(50).optional(),
}).strip().openapi('EvidenceUpdateRequest', {
    description: 'Partial update for an evidence record (metadata only — file content is immutable post-upload).',
});

export const EvidenceReviewSchema = z.object({
    action: z.enum(['SUBMITTED', 'APPROVED', 'REJECTED']),
    comment: z.string().optional().nullable(),
}).strip().openapi('EvidenceReviewRequest', {
    description: 'Lifecycle transition for an evidence record. SUBMITTED is the request-for-review state; APPROVED/REJECTED are reviewer decisions.',
});

// EP-3 — link/unlink an existing Evidence record to/from a control from the
// evidence library (creates/removes one EvidenceControlLink row).
export const LinkEvidenceControlSchema = z.object({
    controlId: z.string().min(1, 'controlId is required'),
}).strip().openapi('EvidenceControlLinkRequest', {
    description: 'Associate an existing evidence record with a control. Creates one EvidenceControlLink; idempotent on the (evidence, control) pair.',
});

// ─── Findings ───

export const CreateFindingSchema = z.object({
    auditId: z.string().optional().nullable(),
    severity: z.string().min(1, 'Severity is required'),
    type: z.string().min(1, 'Type is required'),
    title: z.string().min(1, 'Title is required'),
    description: z.string().optional(),
    rootCause: z.string().optional().nullable(),
    correctiveAction: z.string().optional().nullable(),
    // Analyst notes / commentary (encrypted at rest).
    analysis: z.string().max(20000).optional().nullable(),
    owner: z.string().optional().nullable(),
    // Assignee — a tenant member id (validated server-side).
    assigneeUserId: z.string().optional().nullable(),
    // The control the finding is raised against.
    controlId: z.string().optional().nullable(),
    // A compensating control that mitigates the finding.
    compensatingControlId: z.string().optional().nullable(),
    // Risks this finding implicates (many-to-many).
    riskIds: z.array(z.string()).max(100).optional(),
    dueDate: z.string().optional().nullable(),
    // Generic provenance tag for auto-materialized findings (e.g.
    // sourceKind='NIS2_SELF_ASSESSMENT', sourceRef=<questionId>) — lets a
    // materializer dedupe + reconcile. Omitted for hand-raised findings.
    sourceKind: z.string().max(64).optional().nullable(),
    sourceRef: z.string().max(256).optional().nullable(),
}).strip().openapi('FindingCreateRequest', {
    description: 'Create an audit finding. auditId is optional — findings can be raised independently of an audit cycle. description, rootCause + analysis are encrypted at rest. assigneeUserId / controlId / compensatingControlId / riskIds are validated against the tenant. sourceKind/sourceRef tag auto-materialized findings.',
});

export const UpdateFindingSchema = z.object({
    severity: z.string().optional(),
    type: z.string().optional(),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    rootCause: z.string().optional().nullable(),
    correctiveAction: z.string().optional().nullable(),
    analysis: z.string().max(20000).optional().nullable(),
    owner: z.string().optional().nullable(),
    assigneeUserId: z.string().optional().nullable(),
    controlId: z.string().optional().nullable(),
    compensatingControlId: z.string().optional().nullable(),
    riskIds: z.array(z.string()).max(100).optional(),
    dueDate: z.string().optional().nullable(),
    status: z.enum(['OPEN', 'IN_PROGRESS', 'READY_FOR_VERIFICATION', 'CLOSED']).optional(),
    verificationNotes: z.string().optional().nullable(),
}).strip().openapi('FindingUpdateRequest', {
    description: 'Partial update for a finding — including lifecycle transitions and verification notes. Relation fields (assignee/control/compensating/risks) are validated against the tenant; riskIds is a full replace.',
});

// ─── Audits ───

const ChecklistUpdateSchema = z.object({
    id: z.string().min(1),
    result: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
}).strip();

export const CreateAuditSchema = z.object({
    title: z.string().min(1, 'Title is required'),
    scope: z.string().optional(),
    criteria: z.string().optional().nullable(),
    schedule: z.string().optional().nullable(),
    auditors: z.string().optional().nullable(),
    auditees: z.string().optional().nullable(),
    departments: z.string().optional().nullable(),
    // B8 — optional Framework.key the audit assesses. Capped at 60
    // chars to match the canonical Framework.key length budget.
    frameworkKey: z.string().max(60).optional().nullable(),
    // feat/audit-cycle-unify — optional AuditCycle this fieldwork audit
    // belongs to (validated against the tenant server-side). NULL =
    // standalone audit with no cycle.
    auditCycleId: z.string().optional().nullable(),
    generateChecklist: z.boolean().optional(),
}).strip().openapi('AuditCreateRequest', {
    description: 'Create an audit cycle. frameworkKey links the audit to a compliance framework. auditCycleId attaches the audit as fieldwork within an existing AuditCycle (optional). generateChecklist=true seeds the audit with checklist items derived from the in-scope frameworks.',
});

export const UpdateAuditSchema = z.object({
    title: z.string().min(1).optional(),
    scope: z.string().optional(),
    criteria: z.string().optional().nullable(),
    status: z.enum(['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
    auditors: z.string().optional().nullable(),
    auditees: z.string().optional().nullable(),
    checklistUpdates: z.array(ChecklistUpdateSchema).optional(),
}).strip().openapi('AuditUpdateRequest', {
    description: 'Update an audit cycle including status transitions and checklist-row updates (per-row result + notes via checklistUpdates).',
});

// ─── Tasks (Unified Work Items) ───

/**
 * A due-date on the wire is EITHER a calendar date (`YYYY-MM-DD`) or a full
 * ISO-8601 timestamp.
 *
 * `z.string().datetime()` alone is wrong here: the shared DatePicker
 * serialises with `toYMD()`, whose documented wire format is `YYYY-MM-DD`,
 * so a bare `.datetime()` would 400 every due-date the UI sets. A bare
 * `z.string()` is the other extreme — it lets garbage reach `new Date(...)`
 * and surface as a 500. This accepts exactly the two shapes actually sent
 * and rejects everything else at the boundary.
 */
const isoDateOrDateTime = z
    .string()
    .refine(
        (v) =>
            (/^\d{4}-\d{2}-\d{2}$/.test(v) || /^\d{4}-\d{2}-\d{2}T/.test(v)) &&
            !Number.isNaN(Date.parse(v)),
        { message: 'Must be a YYYY-MM-DD date or an ISO-8601 date-time' },
    );

export const CreateTaskSchema = z.object({
    title: z.string().min(1).max(500),
    type: z.enum(['AUDIT_FINDING', 'CONTROL_GAP', 'INCIDENT', 'IMPROVEMENT', 'TASK']).optional().default('TASK'),
    description: z.string().max(10000).nullable().optional(),
    severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
    // All SEVEN WorkItemSource members. EVIDENCE_EXPIRY and RISK_MONITOR
    // were missing, so the schema rejected two sources the usecase and the
    // repository both accept — the evidence-expiry sweep and the
    // risk-monitor sensors could not name their own provenance through the
    // API and their tasks landed as MANUAL.
    source: z
        .enum([
            'MANUAL',
            'TEMPLATE',
            'POLICY_REVIEW',
            'AUDIT',
            'INTEGRATION',
            'EVIDENCE_EXPIRY',
            'RISK_MONITOR',
        ])
        .optional(),
    dueAt: isoDateOrDateTime.nullable().optional(),
    assigneeUserId: z.string().nullable().optional(),
    reviewerUserId: z.string().nullable().optional(),
    controlId: z.string().nullable().optional(),
    // Was absent, so `.strip()` silently dropped it and `findingId` was a
    // dead parameter on the API path even though `createTask` accepts it
    // and the repository writes it. Tenant-validated in the usecase
    // (`assertRefInTenant`) now that a request body can set it.
    findingId: z.string().nullable().optional(),
    metadataJson: z.any().optional(),
}).strip().openapi('TaskCreateRequest', {
    description: 'Create a task (unified work-item type covering audit findings, control gaps, incidents, improvements, and ad-hoc tasks). The type discriminator gates which UI surfaces this work item appears in.',
});

export const UpdateTaskSchema = z.object({
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(10000).nullable().optional(),
    type: z.enum(['TASK', 'AUDIT_FINDING', 'CONTROL_GAP', 'INCIDENT', 'IMPROVEMENT']).optional(),
    severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
    dueAt: isoDateOrDateTime.nullable().optional(),
    controlId: z.string().nullable().optional(),
    reviewerUserId: z.string().nullable().optional(),
    metadataJson: z.any().optional(),
}).strip().openapi('TaskUpdateRequest', {
    description: 'Partial update for a task. Status changes and assignment go through their own focused endpoints.',
});

export const SetTaskStatusSchema = z.object({
    status: z.enum(['OPEN', 'TRIAGED', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'RESOLVED', 'CLOSED', 'CANCELED']),
    resolution: z.string().max(5000).nullable().optional(),
}).strip().openapi('TaskSetStatusRequest', {
    description: 'Lifecycle transition for a task. resolution is required (by convention) when moving to RESOLVED/CLOSED to provide context for the audit trail.',
});

export const AssignTaskSchema = z.object({
    assigneeUserId: z.string().nullable(),
}).strip().openapi('TaskAssignRequest', {
    description: 'Reassign or unassign a task. Pass null to clear the assignee.',
});

export const LinkTaskEvidenceSchema = z.object({
    url: z.string().url().max(2000),
    note: z.string().max(2000).nullable().optional(),
}).strip().openapi('TaskEvidenceLinkRequest', {
    description: 'Attach a URL as evidence on a task. File uploads use the multipart /evidence/uploads endpoint with a taskId.',
});

export const LinkRiskEvidenceSchema = z.object({
    url: z.string().url().max(2000),
    note: z.string().max(2000).nullable().optional(),
}).strip().openapi('RiskEvidenceLinkRequest', {
    description: 'Attach a URL as evidence on a risk. File uploads use the multipart /evidence/uploads endpoint with a riskId.',
});

export const LinkAssetEvidenceSchema = z.object({
    url: z.string().url().max(2000),
    note: z.string().max(2000).nullable().optional(),
}).strip().openapi('AssetEvidenceLinkRequest', {
    description: 'Attach a URL as evidence on an asset. File uploads use the multipart /evidence/uploads endpoint with an assetId.',
});

export const AddTaskLinkSchema = z.object({
    entityType: z.enum(['CONTROL', 'FRAMEWORK_REQUIREMENT', 'RISK', 'ASSET', 'POLICY', 'EVIDENCE', 'FILE', 'AUDIT_PACK', 'VENDOR', 'INCIDENT']),
    entityId: z.string().min(1),
    relation: z.enum(['RELATES_TO', 'EVIDENCE_FOR', 'BLOCKED_BY', 'CAUSED_BY', 'MITIGATED_BY']).optional(),
}).strip().openapi('TaskLinkAddRequest', {
    description: 'Link a task to another domain entity. The relation field captures semantic intent for downstream traceability views.',
});

export const AddTaskCommentSchema = z.object({
    body: z.string().min(1).max(10000),
}).strip().openapi('TaskCommentAddRequest', {
    description: 'Append a comment to a task. body is sanitized server-side (rich-text allowlist) and encrypted at rest (Epic B field-encryption manifest).',
});

// ─── Task Bulk Actions ───

export const BulkTaskAssignSchema = z.object({
    taskIds: z.array(z.string().min(1)).min(1).max(100),
    assigneeUserId: z.string().nullable(),
}).strip();

export const BulkTaskStatusSchema = z.object({
    taskIds: z.array(z.string().min(1)).min(1).max(100),
    status: z.enum(['OPEN', 'TRIAGED', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'RESOLVED', 'CLOSED', 'CANCELED']),
    resolution: z.string().max(5000).optional(),
}).strip();

export const BulkTaskDueDateSchema = z.object({
    taskIds: z.array(z.string().min(1)).min(1).max(100),
    dueAt: isoDateOrDateTime.nullable(),
}).strip();

// ─── Asset bulk actions (canonical BulkActionBar rollout) ───

export const BulkAssetStatusSchema = z.object({
    assetIds: z.array(z.string().min(1)).min(1).max(100),
    status: z.enum(['ACTIVE', 'RETIRED']),
}).strip();

export const BulkAssetAssignSchema = z.object({
    assetIds: z.array(z.string().min(1)).min(1).max(100),
    ownerUserId: z.string().nullable(),
}).strip();

// ─── Risk bulk actions (canonical BulkActionBar rollout) ───

export const BulkRiskStatusSchema = z.object({
    riskIds: z.array(z.string().min(1)).min(1).max(100),
    status: z.enum(['OPEN', 'MITIGATING', 'MITIGATED', 'ACCEPTED', 'CLOSED']),
}).strip();

export const BulkRiskAssignSchema = z.object({
    riskIds: z.array(z.string().min(1)).min(1).max(100),
    ownerUserId: z.string().nullable(),
}).strip();

// PR-K — bulk risk import: replaces the CSV importer's N per-row POSTs with
// one request. The usecase dedupes by title and resolves free-text owners to
// members. likelihood/impact are optional (createRisk defaults to 3 and clamps
// to the tenant scale).
export const BulkImportRisksSchema = z.object({
    risks: z.array(z.object({
        title: z.string().min(1),
        description: z.string().optional().nullable(),
        category: z.string().optional().nullable(),
        likelihood: z.coerce.number().int().min(1).max(10).optional(),
        impact: z.coerce.number().int().min(1).max(10).optional(),
        owner: z.string().optional().nullable(),
        ownerUserId: z.string().optional().nullable(),
    }).strip()).min(1).max(500),
}).strip().openapi('RiskBulkImportRequest', {
    description: 'Bulk-create risks from a parsed CSV in a single request. Server dedupes by title and resolves owner names/emails to members.',
});

// ─── Control bulk actions (canonical BulkActionBar rollout) ───

export const BulkControlStatusSchema = z.object({
    controlIds: z.array(z.string().min(1)).min(1).max(100),
    // NOT_APPLICABLE is deliberately ABSENT. Marking a control N/A is an
    // applicability DECISION, not a status change: the single-control path
    // (mutations.ts:200-220) requires a justification, stamps
    // applicabilityDecidedByUserId/At, and writes a
    // CONTROL_APPLICABILITY_CHANGED audit row. The bulk path goes through
    // updateMany and can do NONE of that — so accepting it here produced an
    // unjustified, unattributed N/A with an audit row mistyped as
    // status_change. The only guard was client-side, and its own comment
    // named the defect. Set N/A through the applicability action.
    status: z.enum([
        'NOT_STARTED',
        'PLANNED',
        'IN_PROGRESS',
        'IMPLEMENTING',
        'IMPLEMENTED',
        'NEEDS_REVIEW',
    ]),
}).strip();

export const BulkControlAssignSchema = z.object({
    controlIds: z.array(z.string().min(1)).min(1).max(100),
    ownerUserId: z.string().nullable(),
}).strip();

// ─── Vendor bulk actions (canonical BulkActionBar rollout) ───

export const BulkVendorStatusSchema = z.object({
    vendorIds: z.array(z.string().min(1)).min(1).max(100),
    status: z.enum(['ACTIVE', 'ONBOARDING', 'OFFBOARDING', 'OFFBOARDED']),
}).strip();

export const BulkVendorAssignSchema = z.object({
    vendorIds: z.array(z.string().min(1)).min(1).max(100),
    ownerUserId: z.string().nullable(),
}).strip();

// ─── Test plan bulk actions (canonical BulkActionBar rollout) ───

export const BulkTestPlanStatusSchema = z.object({
    planIds: z.array(z.string().min(1)).min(1).max(100),
    status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']),
}).strip();

export const BulkTestPlanAssignSchema = z.object({
    planIds: z.array(z.string().min(1)).min(1).max(100),
    ownerUserId: z.string().nullable(),
}).strip();

// ─── Evidence bulk actions (canonical BulkActionBar rollout — wave B) ───
// Evidence status is workflow-gated (the reviewer-identity review chain),
// so the bulk bar is assign-owner only — no bulk status.

export const BulkEvidenceAssignSchema = z.object({
    evidenceIds: z.array(z.string().min(1)).min(1).max(100),
    ownerUserId: z.string().nullable(),
}).strip();

// ─── Policy bulk actions (canonical BulkActionBar rollout — wave B) ───
// Policy status is approval-gated (can't reach PUBLISHED without APPROVED),
// so the bulk bar is Assign owner + Archive (the one safe terminal verb) —
// no bulk status that could bypass the approval workflow.

export const BulkPolicyAssignSchema = z.object({
    policyIds: z.array(z.string().min(1)).min(1).max(100),
    ownerUserId: z.string().nullable(),
}).strip();

export const BulkPolicyArchiveSchema = z.object({
    policyIds: z.array(z.string().min(1)).min(1).max(100),
}).strip();

// ─── Bulk delete (row-select action bar) ───
// Soft-delete the selected rows (per the shared soft-delete middleware).
export const BulkAssetDeleteSchema = z.object({ assetIds: z.array(z.string().min(1)).min(1).max(100) }).strip();
export const BulkRiskDeleteSchema = z.object({ riskIds: z.array(z.string().min(1)).min(1).max(100) }).strip();
export const BulkControlDeleteSchema = z.object({ controlIds: z.array(z.string().min(1)).min(1).max(100) }).strip();
export const BulkTaskDeleteSchema = z.object({ taskIds: z.array(z.string().min(1)).min(1).max(100) }).strip();
export const BulkTestPlanDeleteSchema = z.object({ planIds: z.array(z.string().min(1)).min(1).max(100) }).strip();
export const BulkTestPlanRestoreSchema = z.object({ planIds: z.array(z.string().min(1)).min(1).max(100) }).strip();
export const BulkEvidenceDeleteSchema = z.object({ evidenceIds: z.array(z.string().min(1)).min(1).max(100) }).strip();
export const BulkEvidenceApproveSchema = z.object({ evidenceIds: z.array(z.string().min(1)).min(1).max(100) }).strip();
export const BulkPolicyDeleteSchema = z.object({ policyIds: z.array(z.string().min(1)).min(1).max(100) }).strip();
export const BulkVendorDeleteSchema = z.object({ vendorIds: z.array(z.string().min(1)).min(1).max(100) }).strip();

// ─── Issue Compatibility Aliases (deprecated — use Task schemas) ───

/** @deprecated Use CreateTaskSchema */ export const CreateIssueSchema = CreateTaskSchema;
/** @deprecated Use UpdateTaskSchema */ export const UpdateIssueSchema = UpdateTaskSchema;
/** @deprecated Use SetTaskStatusSchema */ export const SetIssueStatusSchema = SetTaskStatusSchema;
/** @deprecated Use AssignTaskSchema */ export const AssignIssueSchema = AssignTaskSchema;
/** @deprecated Use AddTaskLinkSchema */ export const AddIssueLinkSchema = AddTaskLinkSchema;
/** @deprecated Use AddTaskCommentSchema */ export const AddIssueCommentSchema = AddTaskCommentSchema;
/** @deprecated Use BulkTaskAssignSchema */ export const BulkAssignSchema = BulkTaskAssignSchema;
/** @deprecated Use BulkTaskStatusSchema */ export const BulkStatusSchema = BulkTaskStatusSchema;
/** @deprecated Use BulkTaskDueDateSchema */ export const BulkDueDateSchema = BulkTaskDueDateSchema;

// ─── Clauses ───

export const UpdateClauseProgressSchema = z.object({
    status: z.string().min(1, 'Status is required'),
    notes: z.string().optional().nullable(),
}).strip();

// ─── Auth ───

export const AuthRegisterSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    name: z.string().min(1),
    orgName: z.string().min(1),
}).strip().openapi('AuthRegisterRequest', {
    description: 'Self-service signup payload (gated by AUTH_TEST_MODE in non-prod). The password is checked against HIBP via k-anonymity before persistence; emailVerification is initiated server-side.',
});

// `action: 'login'` was removed 2026-04-22 — the old bespoke /api/auth/
// register login endpoint was a parallel path to NextAuth's Credentials
// provider. All production login now flows through NextAuth. The legacy
// union is kept as a single-variant union for Zod-discriminated-union
// compatibility; the variant check still catches other malformed bodies.
export const AuthActionSchema = z.discriminatedUnion('action', [
    AuthRegisterSchema.extend({ action: z.literal('register') }),
]);

// ─── Evidence Bundles ───

export const CreateBundleSchema = z.object({
    name: z.string().min(1).max(200),
}).strip();

export const AddBundleItemSchema = z.object({
    entityType: z.enum(['FILE', 'EVIDENCE', 'INTEGRATION']),
    entityId: z.string().min(1),
    label: z.string().max(500).optional(),
}).strip();

// ─── Vendor Management ───

export const CreateVendorSchema = z.object({
    name: z.string().min(1).max(200),
    legalName: z.string().max(300).optional().nullable(),
    websiteUrl: z.string().url().max(500).optional().nullable(),
    domain: z.string().max(200).optional().nullable(),
    country: z.string().max(100).optional().nullable(),
    description: z.string().max(5000).optional().nullable(),
    ownerUserId: z.string().optional().nullable(),
    status: z.enum(['ACTIVE', 'ONBOARDING', 'OFFBOARDING', 'OFFBOARDED']).optional(),
    criticality: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    inherentRisk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional().nullable(),
    dataAccess: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']).optional().nullable(),
    isSubprocessor: z.boolean().optional(),
    tags: z.array(z.string().max(50)).max(20).optional().nullable(),
    nextReviewAt: z.string().optional().nullable(),
    contractRenewalAt: z.string().optional().nullable(),
}).strip().openapi('VendorCreateRequest', {
    description: 'Create a vendor (third-party supplier) record. Risk + criticality fields drive vendor-tiering and audit-cycle scope. description is encrypted at rest.',
});

export const UpdateVendorSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    legalName: z.string().max(300).optional().nullable(),
    websiteUrl: z.string().url().max(500).optional().nullable(),
    domain: z.string().max(200).optional().nullable(),
    country: z.string().max(100).optional().nullable(),
    description: z.string().max(5000).optional().nullable(),
    ownerUserId: z.string().optional().nullable(),
    status: z.enum(['ACTIVE', 'ONBOARDING', 'OFFBOARDING', 'OFFBOARDED']).optional(),
    criticality: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    inherentRisk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional().nullable(),
    residualRisk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional().nullable(),
    dataAccess: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']).optional().nullable(),
    isSubprocessor: z.boolean().optional(),
    tags: z.array(z.string().max(50)).max(20).optional().nullable(),
    nextReviewAt: z.string().optional().nullable(),
    contractRenewalAt: z.string().optional().nullable(),
}).strip().openapi('VendorUpdateRequest', {
    description: 'Partial update for a vendor. residualRisk is computed from inherentRisk + control coverage; allow direct override here for SoC analyst workflow.',
});

export const CreateVendorDocumentSchema = z.object({
    type: z.enum(['CONTRACT', 'SOC2', 'ISO_CERT', 'DPA', 'SECURITY_POLICY', 'PEN_TEST', 'OTHER']),
    fileId: z.string().optional().nullable(),
    externalUrl: z.string().url().max(1000).optional().nullable(),
    title: z.string().max(300).optional().nullable(),
    validFrom: z.string().optional().nullable(),
    validTo: z.string().optional().nullable(),
    notes: z.string().max(5000).optional().nullable(),
    // B8 — free-text folder label (e.g. "Contracts/2026"). Sanitised
    // + trimmed at the usecase boundary; null/empty maps to "no folder".
    folder: z.string().max(120).optional().nullable(),
}).strip();

export const StartAssessmentSchema = z.object({
    templateKey: z.string().min(1).max(100),
}).strip();

// Epic G-3 — outbound send of a published VendorAssessmentTemplate to
// an external respondent. `templateVersionId` pins the concrete
// published template version; the usecase enforces PUBLISHED state and
// in-flight idempotency (see vendor-assessment-send.ts).
export const SendVendorAssessmentSchema = z.object({
    templateVersionId: z.string().min(1).max(100),
    respondentEmail: z.string().email(),
    respondentName: z.string().max(200).optional(),
    expiresInDays: z.number().int().min(1).max(90).optional(),
    force: z.boolean().optional(),
}).strip();

export const SaveAssessmentAnswersSchema = z.object({
    answers: z.array(z.object({
        questionId: z.string().min(1),
        answerJson: z.any(),
    })).min(1).max(200),
}).strip();

export const DecideAssessmentSchema = z.object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    notes: z.string().max(5000).optional().nullable(),
}).strip();

export const SetVendorReviewSchema = z.object({
    nextReviewAt: z.string().optional().nullable(),
    contractRenewalAt: z.string().optional().nullable(),
}).strip();

export const AddVendorLinkSchema = z.object({
    entityType: z.enum(['ASSET', 'RISK', 'ISSUE', 'CONTROL']),
    entityId: z.string().min(1),
    relation: z.enum(['USES', 'STORES_DATA_FOR', 'PROVIDES_SERVICE_TO', 'MITIGATES', 'RELATED']).optional(),
}).strip();

// ─── Control Test Schemas ───

// R3-P2 / PR-CC — `method` is NOT accepted on either write path. It is a
// derived projection of `automationType` (`deriveMethodFromAutomationType`),
// so a plan becomes AUTOMATED by acquiring an automationType + schedule via
// the schedule endpoint — never by a caller asserting `method: 'AUTOMATED'`.
// Accepting it here let the two columns drift (badge said AUTOMATED while
// automationType stayed MANUAL and nothing was scheduled).
export const CreateTestPlanSchema = z.object({
    name: z.string().min(1).max(500),
    description: z.string().max(10000).nullable().optional(),
    frequency: z.enum(['AD_HOC', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY']).optional().default('AD_HOC'),
    ownerUserId: z.string().nullable().optional(),
    expectedEvidence: z.any().nullable().optional(),
    steps: z.array(z.object({
        instruction: z.string().min(1).max(10000),
        expectedOutput: z.string().max(10000).nullable().optional(),
    })).optional(),
}).strip();

export const UpdateTestPlanSchema = z.object({
    name: z.string().min(1).max(500).optional(),
    description: z.string().max(10000).nullable().optional(),
    frequency: z.enum(['AD_HOC', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY']).optional(),
    ownerUserId: z.string().nullable().optional(),
    expectedEvidence: z.any().nullable().optional(),
    // ARCHIVED accepted so single-plan archive works from the detail page —
    // the bulk path (`bulkSetTestPlanStatus`) already allowed it, so omitting
    // it here made the detail form's own ARCHIVED option 400.
    status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).optional(),
    // R3-P2 — steps are now editable after creation. When present, the
    // array REPLACES the plan's existing procedure (empty array clears it).
    steps: z.array(z.object({
        instruction: z.string().min(1).max(10000),
        expectedOutput: z.string().max(10000).nullable().optional(),
    })).optional(),
}).strip();

export const CompleteTestRunSchema = z.object({
    result: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']),
    notes: z.string().max(10000).nullable().optional(),
    findingSummary: z.string().max(2000).nullable().optional(),
}).strip();

export const LinkTestEvidenceSchema = z.object({
    kind: z.enum(['FILE', 'EVIDENCE', 'LINK', 'INTEGRATION_RESULT']),
    fileId: z.string().nullable().optional(),
    evidenceId: z.string().nullable().optional(),
    url: z.string().url().nullable().optional(),
    integrationResultId: z.string().nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
}).strip();

// Epic G-2 — schedule a ControlTestPlan. The cross-field invariants
// (SCRIPT/INTEGRATION must have a schedule; MANUAL must not) are
// enforced at the usecase boundary so the validation error message
// can reference the plan rather than the raw zod path. Zod just
// shape-checks here.
export const ScheduleTestPlanSchema = z.object({
    schedule: z.string().min(1).max(120).nullable(),
    scheduleTimezone: z.string().min(1).max(64).nullable().optional(),
    automationType: z.enum(['MANUAL', 'SCRIPT', 'INTEGRATION']),
    // automationConfig is shaped per handler. We accept any
    // JSON-serialisable blob here — the SCRIPT and INTEGRATION
    // handlers (next G-2 prompt) carry their own per-handler shape
    // checks.
    automationConfig: z.unknown().nullable().optional(),
}).strip();

// ─── Epic G-3 — Vendor Assessment Template Authoring ──────────────
//
// Per-answerType cross-field validation (e.g. SCALE requires
// scaleConfigJson, SINGLE_SELECT requires optionsJson) is enforced
// at the usecase boundary so the error message can name the
// answer type rather than report a generic "missing field".

export const CreateVendorAssessmentTemplateSchema = z.object({
    /// Stable template identifier shared across versions. The usecase
    /// canonicalizes input to lowercase-kebab-case before persisting.
    key: z.string().min(1).max(120),
    name: z.string().min(1).max(500),
    description: z.string().max(10000).nullable().optional(),
    /// Tenant copies default to false. Global templates surface in
    /// the catalog browse UI for cloning into a tenant.
    isGlobal: z.boolean().optional().default(false),
}).strip();

export const AddVendorAssessmentTemplateSectionSchema = z.object({
    title: z.string().min(1).max(500),
    description: z.string().max(10000).nullable().optional(),
    /// Per-section weight applied during scoring. Null = equal weight.
    weight: z.number().nonnegative().optional().nullable(),
    /// Optional explicit position. When omitted the usecase auto-
    /// assigns max(siblings)+1.
    sortOrder: z.number().int().nonnegative().optional(),
}).strip();

export const AddVendorAssessmentTemplateQuestionSchema = z.object({
    prompt: z.string().min(1).max(5000),
    answerType: z.enum([
        'YES_NO',
        'SINGLE_SELECT',
        'MULTI_SELECT',
        'TEXT',
        'NUMBER',
        'SCALE',
        'FILE_UPLOAD',
    ]),
    required: z.boolean().optional().default(true),
    weight: z.number().nonnegative().optional().default(1),
    /// SINGLE_SELECT / MULTI_SELECT — required for those types
    /// (enforced at the usecase boundary).
    optionsJson: z
        .array(
            z.object({
                label: z.string().min(1).max(500),
                value: z.string().min(1).max(500),
                points: z.number().optional(),
            }),
        )
        .nullable()
        .optional(),
    /// SCALE — required for that type. min must be < max.
    scaleConfigJson: z
        .object({
            min: z.number().int(),
            max: z.number().int(),
            labels: z.array(z.string().max(120)).max(10).optional(),
        })
        .nullable()
        .optional(),
    /// Legacy compatibility with the existing scoring service.
    riskPointsJson: z.unknown().nullable().optional(),
    sortOrder: z.number().int().nonnegative().optional(),
}).strip();

export const ReorderVendorAssessmentTemplateSchema = z.object({
    sections: z.array(
        z.object({
            id: z.string().min(1).max(120),
            sortOrder: z.number().int().nonnegative(),
            questions: z.array(
                z.object({
                    id: z.string().min(1).max(120),
                    sectionId: z.string().min(1).max(120),
                    sortOrder: z.number().int().nonnegative(),
                }),
            ).optional(),
        }),
    ).max(200),
}).strip();

export const ReviewVendorAssessmentSchema = z.object({
    /// Per-answer overrides. The reviewer can adjust a subset; any
    /// answer not in this list keeps its auto-computed points.
    overrides: z
        .array(
            z.object({
                questionId: z.string().min(1).max(120),
                /// Override numeric points. Null clears a previous
                /// override; undefined leaves it untouched. Float
                /// because some weighted modes produce fractional
                /// effective points.
                overridePoints: z.number().nullable().optional(),
                /// Free-text reviewer commentary; max 5000 chars.
                reviewerNotes: z.string().max(5000).nullable().optional(),
            }),
        )
        .max(500)
        .optional()
        .default([]),
    /// Manual final-rating override. Null = let the engine derive
    /// from score + ratingThresholds. Undefined = no opinion (engine
    /// derivation also wins).
    finalRiskRating: z
        .enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
        .nullable()
        .optional(),
    /// Assessment-level reviewer note, distinct from per-answer notes.
    reviewerNotes: z.string().max(10000).nullable().optional(),
}).strip();

export const CloneVendorAssessmentTemplateSchema = z.object({
    /// SAME_KEY_NEW_VERSION — produce a new draft revision of the
    /// existing template family. The previous latest version
    /// retains its data (live assessments stay pinned via
    /// templateVersionId) but loses the isLatestVersion flag.
    ///
    /// NEW_KEY — fork into a separate template family. Caller
    /// must supply a new `key`.
    mode: z.enum(['SAME_KEY_NEW_VERSION', 'NEW_KEY']),
    key: z.string().min(1).max(120).optional(),
    name: z.string().min(1).max(500).optional(),
    description: z.string().max(10000).nullable().optional(),
}).strip();
