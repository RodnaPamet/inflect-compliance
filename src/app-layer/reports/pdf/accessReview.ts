/**
 * Epic G-4 — Access Review evidence PDF generator.
 *
 * Produces the canonical SOC 2 CC6.2 evidence artifact for one
 * closed access review campaign. Sections, in order:
 *
 *   1. Cover page (title + tenant + period + reviewer)
 *   2. Metadata (creator, closer, scope, decision counts, content
 *      SHA-256 hash for integrity)
 *   3. Summary metrics — decision distribution + execution counts
 *   4. Per-user decision table — the auditor's main asset
 *
 * The data hash on the metadata page makes the artifact tamper-
 * evident: re-generating the PDF over the same closed campaign
 * yields the same hash. A mismatch on later inspection means
 * either (a) the data drifted post-close, or (b) a different
 * campaign's PDF was substituted.
 *
 * No external system calls — every input is a snapshot of rows
 * already committed to the DB. Safe to invoke synchronously
 * inside the closeout transaction.
 */
import crypto from 'crypto';
import type {
    AccessReviewDecisionType,
    MembershipStatus,
    Role,
} from '@prisma/client';
import { createPdfDocument } from '@/lib/pdf/pdfKitFactory';
import {
    addCoverPage,
    addMetadataPage,
    applyHeadersAndFooters,
} from '@/lib/pdf/layout';
import {
    addSectionTitle,
    addSummaryMetrics,
    addParagraph,
    addSpacer,
} from '@/lib/pdf/sections';
import { renderTable, autoColumnWidths } from '@/lib/pdf/table';
import type {
    ReportMeta,
    TableColumn,
    DataSourceNote,
    WatermarkMode,
} from '@/lib/pdf/types';

/**
 * Step 5a — what a CONNECTED_APP subject puts in the two snapshot columns.
 *
 * A connected subject is a DIRECTORY ACCOUNT. It has no tenant `Role` and no
 * `MembershipStatus`, because it was never a member of the tenant — it is a
 * row the identity sync observed in Okta, Entra, Google Workspace or AD. The
 * facts a reviewer actually needs about one are whether it is a directory
 * admin and whether MFA is enrolled, so those map onto the existing two
 * columns rather than growing the artefact a second table.
 *
 * Spelled as literal unions rather than widening both fields to `string`: the
 * member flow keeps its enum typing, and the set of things a connected row may
 * claim stays closed and readable.
 */
export type DirectorySnapshotRole = 'DIRECTORY_ADMIN' | 'DIRECTORY_USER';
export type DirectorySnapshotStatus = 'MFA_ENROLLED' | 'MFA_MISSING';

export interface AccessReviewPdfDecisionRow {
    subjectUserEmail: string;
    subjectUserName: string | null;
    snapshotRole: Role | DirectorySnapshotRole;
    snapshotMembershipStatus: MembershipStatus | DirectorySnapshotStatus;
    decision: AccessReviewDecisionType | null;
    decidedAtIso: string | null;
    notes: string | null;
    modifiedToRole: Role | null;
    /// Outcome string the closeout executor wrote per row:
    ///   EXECUTED | NO_CHANGE | SKIPPED_STALE | SKIPPED_LAST_OWNER | …
    executionOutcome: string;
    /**
     * HOW the account was attributed to a person, for a LEGACY_APP campaign:
     * CONFIRMED_ALIAS | EMAIL_EXACT | MANUAL | NO_CANDIDATES | …
     *
     * Step 5b requires it in the evidence, and the reason is that a legacy
     * certification rests on an INFERENCE the member flow never makes. An
     * auditor reading "jsmith was certified as Jane Smith" is entitled to know
     * whether a person said so or a string-similarity scorer did — those are
     * different strengths of evidence for the same sentence.
     *
     * Absent for the member and connected flows, which have no such step.
     */
    resolutionMethod?: string | null;
}

export interface AccessReviewPdfInput {
    tenantName: string;
    /** Campaign metadata. */
    campaignName: string;
    campaignDescription: string | null;
    scope: string;
    periodStartIso: string | null;
    periodEndIso: string | null;
    /** Reviewer + creator + closer email — surfaced in metadata. */
    reviewerEmail: string;
    createdByEmail: string;
    closedByEmail: string;
    closedAtIso: string;
    decisions: readonly AccessReviewPdfDecisionRow[];
    /**
     * For a LEGACY_APP campaign: what the application reported, and when.
     *
     * The payload hash is the point. It is computed over the snapshot's rows at
     * pull time, so an auditor can re-derive it from the stored rows and prove
     * the certification was made against THOSE rows and not a later state. The
     * mapping version says which column-to-field interpretation produced them —
     * the same bytes under a different mapping are a different claim about who
     * had access.
     *
     * It also enters `computeContentHash(input)`, so the artefact's own hash
     * covers the provenance rather than merely displaying it.
     */
    legacyProvenance?: {
        snapshotId: string;
        payloadHash: string;
        mappingVersion: number;
        connectionId: string;
    } | null;
    watermark?: WatermarkMode;
}

/**
 * Compute a deterministic SHA-256 hash over the rendered evidence
 * data. Surfaces on the metadata page; auditors can use it to
 * verify the PDF hasn't been swapped post-close.
 */
function computeContentHash(input: AccessReviewPdfInput): string {
    const canonical = JSON.stringify({
        tenantName: input.tenantName,
        campaignName: input.campaignName,
        scope: input.scope,
        periodStartIso: input.periodStartIso,
        periodEndIso: input.periodEndIso,
        reviewerEmail: input.reviewerEmail,
        closedAtIso: input.closedAtIso,
        decisions: [...input.decisions]
            .sort((a, b) => a.subjectUserEmail.localeCompare(b.subjectUserEmail))
            .map((d) => ({
                email: d.subjectUserEmail,
                snapshotRole: d.snapshotRole,
                snapshotMembershipStatus: d.snapshotMembershipStatus,
                decision: d.decision,
                modifiedToRole: d.modifiedToRole,
                executionOutcome: d.executionOutcome,
            })),
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function generateAccessReviewPdf(
    input: AccessReviewPdfInput,
): PDFKit.PDFDocument {
    const contentHash = computeContentHash(input);
    const periodLabel =
        input.periodStartIso && input.periodEndIso
            ? `${input.periodStartIso.slice(0, 10)} → ${input.periodEndIso.slice(0, 10)}`
            : input.periodEndIso
                ? `as of ${input.periodEndIso.slice(0, 10)}`
                : 'no period specified';

    const meta: ReportMeta = {
        tenantName: input.tenantName,
        reportTitle: 'Access Review Evidence',
        reportSubtitle: `${input.campaignName} — ${periodLabel}`,
        generatedAt: new Date().toISOString(),
        watermark: input.watermark ?? 'FINAL',
        contentHash,
    };

    const dataSources: DataSourceNote[] = [
        {
            source: 'Access Review Campaign',
            description:
                'Snapshot of tenant memberships at campaign creation, with reviewer verdict per user.',
        },
        {
            source: 'Decision Execution',
            description:
                'Per-user outcome of REVOKE/MODIFY application against live TenantMembership at closeout.',
        },
        {
            source: 'Audit Log',
            description:
                'Hash-chained per-decision audit entries are persisted alongside this artifact.',
        },
    ];

    const doc = createPdfDocument(meta);
    addCoverPage(doc, meta);
    addMetadataPage(doc, meta, dataSources);

    // ─── Content page ─────────────────────────────────────────────
    doc.addPage();
    addSectionTitle(doc, 'Campaign metadata');
    addParagraph(
        doc,
        `Campaign: ${input.campaignName}` +
            (input.campaignDescription
                ? `\n${input.campaignDescription}`
                : ''),
    );
    addParagraph(
        doc,
        `Scope: ${input.scope} • Reviewer: ${input.reviewerEmail} • ` +
            `Created by: ${input.createdByEmail} • ` +
            `Closed by: ${input.closedByEmail} on ${input.closedAtIso.slice(0, 19).replace('T', ' ')} UTC`,
    );

    // ─── Summary metrics ─────────────────────────────────────────
    const counts = {
        total: input.decisions.length,
        confirm: input.decisions.filter((d) => d.decision === 'CONFIRM').length,
        revoke: input.decisions.filter((d) => d.decision === 'REVOKE').length,
        modify: input.decisions.filter((d) => d.decision === 'MODIFY').length,
        pending: input.decisions.filter((d) => d.decision === null).length,
        executed: input.decisions.filter((d) =>
            ['EXECUTED', 'NO_CHANGE'].includes(d.executionOutcome),
        ).length,
    };
    addSpacer(doc);
    addSectionTitle(doc, 'Summary');
    addSummaryMetrics(doc, [
        { label: 'Subjects', value: counts.total },
        { label: 'Confirmed', value: counts.confirm },
        { label: 'Revoked', value: counts.revoke },
        { label: 'Modified', value: counts.modify },
        { label: 'Pending', value: counts.pending },
        { label: 'Executed', value: counts.executed },
    ]);
    addSpacer(doc);

    // ─── Source provenance, for a legacy application ─────────────
    //
    // Before the decisions, not after: an auditor reading this artefact needs to
    // know WHAT was certified before reading WHO certified it.
    if (input.legacyProvenance) {
        addSectionTitle(doc, 'Source snapshot');
        // A paragraph rather than `addSummaryMetrics`: that helper renders
        // NUMBERS, and a 64-character hash is the one field here nobody should
        // see abbreviated into a metric tile.
        addParagraph(
            doc,
            `Certified against snapshot ${input.legacyProvenance.snapshotId} of connection `
            + `${input.legacyProvenance.connectionId}, interpreted under mapping version `
            + `${input.legacyProvenance.mappingVersion}. The application's reported rows hash to `
            + `${input.legacyProvenance.payloadHash}. Re-deriving that hash from the stored rows `
            + 'proves this certification was made against those rows and not a later state.'
        );
        addSpacer(doc);
    }

    // ─── Per-user decision table ─────────────────────────────────
    addSectionTitle(doc, 'Per-user decisions');

    // The method column appears only where it means something. Adding an empty
    // column to every member-flow artefact would cost width on every page to
    // say nothing, and a reader would reasonably wonder what was missing.
    const showMethod = input.decisions.some((d) => Boolean(d.resolutionMethod));
    const widths = showMethod
        ? autoColumnWidths([2.4, 1.0, 1.1, 1.0, 1.0, 1.2, 1.6])
        : autoColumnWidths([2.6, 1.0, 1.1, 1.1, 1.0, 2.0]);
    const columns: TableColumn[] = [
        { key: 'subject', header: 'Subject', width: widths[0] },
        { key: 'snapshotRole', header: 'Snapshot Role', width: widths[1], align: 'center' },
        { key: 'decision', header: 'Decision', width: widths[2], align: 'center' },
        { key: 'targetRole', header: 'Target Role', width: widths[3], align: 'center' },
        { key: 'outcome', header: 'Outcome', width: widths[4], align: 'center' },
        ...(showMethod
            ? [{ key: 'method', header: 'Attributed by', width: widths[5], align: 'center' as const }]
            : []),
        { key: 'notes', header: 'Notes', width: widths[showMethod ? 6 : 5] },
    ];

    const rows = [...input.decisions]
        .sort((a, b) => a.subjectUserEmail.localeCompare(b.subjectUserEmail))
        .map((d) => ({
            subject: d.subjectUserName
                ? `${d.subjectUserName} <${d.subjectUserEmail}>`
                : d.subjectUserEmail,
            snapshotRole: d.snapshotRole,
            decision: d.decision ?? 'PENDING',
            targetRole: d.modifiedToRole ?? '—',
            outcome: d.executionOutcome,
            method: d.resolutionMethod ?? '—',
            notes: d.notes ?? '—',
        }));

    renderTable(doc, columns, rows);

    applyHeadersAndFooters(doc, meta);
    return doc;
}
