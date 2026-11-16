/**
 * The sources the knowledge index reads (vector store Phase 2.5,
 * `docs/ai-architecture/weaviate.md`), and how each yields its indexable text.
 *
 * A source reader is handed the index job's transaction (inside
 * `runInTenantContext`, so RLS applies and encrypted columns decrypt) and
 * answers one question about one row: what text, if any, belongs in the index
 * now. It never answers with a guess: a row that is gone, not yet approved or
 * holds no text is NOT indexable, and the job then removes whatever chunks the
 * row had, so the index follows the source down as well as up.
 *
 * The roadmap's order is `PolicyVersion.contentText` (approved versions only),
 * evidence file text (post-ClamAV, via the parser seam), control descriptions,
 * the questionnaire answer library. A source is added here, with its reader,
 * in the pull request that also enqueues the job for it.
 *
 * @module app-layer/services/knowledge-sources
 */
import type { PrismaTx } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import type { RequestContext } from '../types';

/** Every model the index reads, by its Prisma model name. */
export const KNOWLEDGE_SOURCE_MODELS = ['PolicyVersion'] as const;
export type KnowledgeSourceModel = (typeof KNOWLEDGE_SOURCE_MODELS)[number];

export function isKnowledgeSourceModel(value: string): value is KnowledgeSourceModel {
    return (KNOWLEDGE_SOURCE_MODELS as readonly string[]).includes(value);
}

/** Why a row yields no text. Each is a label, never a failure. */
export type NotIndexableReason =
    /** No such row in the tenant (deleted, or never there). */
    | 'GONE'
    /** The row's parent is soft-deleted. */
    | 'PARENT_DELETED'
    /** A policy version nobody has approved. */
    | 'NOT_APPROVED'
    /** The content lives elsewhere (an external link), so there is no text here. */
    | 'NO_INLINE_TEXT';

export type SourceText =
    | { readonly indexable: true; readonly text: string }
    | { readonly indexable: false; readonly reason: NotIndexableReason };

export type SourceReader = (db: PrismaTx, ctx: RequestContext, sourceId: string) => Promise<SourceText>;

/**
 * HTML to the text a reader would see: block ends become paragraph breaks
 * (which is what the paragraph chunker splits on), every tag is dropped and
 * entities are decoded. The content was sanitised at its own write path
 * (`sanitizePolicyContent`); this only flattens it.
 */
export function htmlToIndexText(html: string): string {
    const blocked = html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|section|article|blockquote|pre|h[1-6]|li|ul|ol|table|tr|thead|tbody)\s*>/gi, '\n\n');
    return sanitizePlainText(blocked);
}

/**
 * `PolicyVersion.contentText`, approved versions only. "Approved" is what
 * `decidePolicyApproval` records: a `PolicyApproval` for this exact version
 * with status `APPROVED`. A version published through the approval bypass has
 * no such row and is not indexed; nor is any version of a soft-deleted policy.
 */
async function readPolicyVersion(db: PrismaTx, ctx: RequestContext, sourceId: string): Promise<SourceText> {
    const version = await db.policyVersion.findFirst({
        where: { id: sourceId, tenantId: ctx.tenantId },
        select: {
            contentType: true,
            contentText: true,
            policy: { select: { deletedAt: true } },
            approvals: { where: { tenantId: ctx.tenantId, status: 'APPROVED' }, select: { id: true }, take: 1 },
        },
    });
    if (!version) return { indexable: false, reason: 'GONE' };
    if (version.policy.deletedAt) return { indexable: false, reason: 'PARENT_DELETED' };
    if (version.approvals.length === 0) return { indexable: false, reason: 'NOT_APPROVED' };
    if (version.contentType === 'EXTERNAL_LINK' || !version.contentText) {
        return { indexable: false, reason: 'NO_INLINE_TEXT' };
    }
    const text = version.contentType === 'HTML' ? htmlToIndexText(version.contentText) : version.contentText;
    return { indexable: true, text };
}

export const KNOWLEDGE_SOURCES: Readonly<Record<KnowledgeSourceModel, SourceReader>> = {
    PolicyVersion: readPolicyVersion,
};
