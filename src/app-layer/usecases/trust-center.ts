/**
 * Trust Center compose usecases (authenticated, tenant-scoped).
 *
 * This is the CURATE side: an admin composes the projection, and an OWNER
 * publishes it. The PUBLIC read lives in `@/lib/trust-center/public` and never
 * touches this file.
 *
 * Security:
 *   - Every free-text field is sanitised before persistence (the row is
 *     rendered to the open internet — XSS surface). Document URLs are
 *     scheme-restricted to http/https (drops javascript:/data: vectors).
 *   - Publish/unpublish is an OWNER-gated, AUDITED action.
 *   - `enabled` starts false; a tenant has no public page until they publish.
 */
import { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest, forbidden } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';

export interface TrustCenterInput {
    displayName: string;
    tagline?: string | null;
    postureSummary?: string | null;
    securityContact?: string | null;
    indexable?: boolean;
    publishedFrameworks?: Array<{ key: string; statusLabel: string; badge?: string }>;
    publishedDocuments?: Array<{ label: string; url: string }>;
}

/** Keep only http(s) URLs after sanitising — drops javascript:/data: vectors. */
function safeUrl(raw: string): string | null {
    const cleaned = sanitizePlainText(raw).trim();
    try {
        const u = new URL(cleaned);
        if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
        return null;
    } catch {
        return null;
    }
}

/**
 * A row left wholly blank is not published. A row filled in halfway, or a
 * document whose address is not http(s), is REFUSED by name (#4824): it used to
 * be dropped, so the save answered "saved" and the row was missing from the
 * public page with nothing to say why.
 */
function sanitizeFrameworks(
    items: TrustCenterInput['publishedFrameworks'],
): Array<{ key: string; statusLabel: string; badge?: string }> {
    if (!Array.isArray(items)) return [];
    const rows = items
        .slice(0, 50)
        .map((f) => ({
            key: sanitizePlainText(String(f.key ?? '')).slice(0, 64).trim(),
            statusLabel: sanitizePlainText(String(f.statusLabel ?? '')).slice(0, 64).trim(),
            badge: f.badge ? sanitizePlainText(String(f.badge)).slice(0, 64) : undefined,
        }))
        .filter((f) => f.key || f.statusLabel);
    const half = rows.find((f) => !f.key || !f.statusLabel);
    if (half) {
        throw badRequest(
            `A framework needs both a name and a status: "${half.key || half.statusLabel}".`,
            { code: 'INCOMPLETE_FRAMEWORK_ROW' },
        );
    }
    return rows;
}

function sanitizeDocuments(
    items: TrustCenterInput['publishedDocuments'],
): Array<{ label: string; url: string }> {
    if (!Array.isArray(items)) return [];
    const rows = items
        .slice(0, 50)
        .map((d) => ({ label: sanitizePlainText(String(d.label ?? '')).slice(0, 200).trim(), raw: String(d.url ?? '').trim() }))
        .filter((d) => d.label || d.raw);
    return rows.map((d) => {
        if (!d.label || !d.raw) {
            throw badRequest(
                `A published document needs both a name and an address: "${d.label || d.raw}".`,
                { code: 'INCOMPLETE_DOCUMENT_ROW' },
            );
        }
        const url = safeUrl(d.raw);
        if (!url) {
            throw badRequest(
                `The address of "${d.label}" must be a full web address starting with https:// or http://.`,
                { code: 'INVALID_DOCUMENT_URL' },
            );
        }
        return { label: d.label, url };
    });
}

/**
 * Read the tenant's trust center (compose view). Null if not created yet.
 *
 * Asserts `admin.manage`, the key its only route (`GET /admin/trust-center`)
 * holds, and not merely `assertCanRead`: the compose row includes unpublished
 * drafts, and its only other caller is the admin trust-center page.
 */
export async function getTrustCenter(ctx: RequestContext) {
    assertCanRead(ctx);
    if (!ctx.appPermissions?.admin?.manage) {
        throw forbidden('You do not have permission to compose the trust center.');
    }
    return runInTenantContext(ctx, (db) =>
        db.trustCenter.findUnique({ where: { tenantId: ctx.tenantId } }),
    );
}

/**
 * Create or update the curated trust-center content. Does NOT change `enabled`
 * (publishing is a separate, OWNER-gated action). Editing while published is
 * audited so a content change to a live public page is on the record.
 */
export async function upsertTrustCenter(ctx: RequestContext, input: TrustCenterInput) {
    assertCanWrite(ctx);
    if (!input.displayName || !input.displayName.trim()) {
        throw badRequest('Give the trust center a display name.', { code: 'INVALID_DISPLAY_NAME' });
    }

    const data = {
        displayName: sanitizePlainText(input.displayName).slice(0, 200),
        tagline: input.tagline != null ? sanitizePlainText(input.tagline).slice(0, 300) : null,
        postureSummary: input.postureSummary != null ? sanitizePlainText(input.postureSummary).slice(0, 20_000) : null,
        securityContact: input.securityContact != null ? sanitizePlainText(input.securityContact).slice(0, 200) : null,
        indexable: Boolean(input.indexable),
        publishedFrameworks: sanitizeFrameworks(input.publishedFrameworks),
        publishedDocuments: sanitizeDocuments(input.publishedDocuments),
    };

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.trustCenter.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { id: true, enabled: true },
        });

        // First create mints the public slug from the tenant slug (unique).
        // Tenant has no RLS, so the context-bound db reads it fine (same shape
        // as createRisk) — no global prisma import in this tenant-scoped usecase.
        const tenant = await db.tenant.findUnique({ where: { id: ctx.tenantId }, select: { slug: true } });
        const slug = tenant?.slug ?? ctx.tenantId;

        const row = await db.trustCenter.upsert({
            where: { tenantId: ctx.tenantId },
            create: { tenantId: ctx.tenantId, slug, ...data },
            update: data,
        });

        // Editing the content of a LIVE public page is itself audit-worthy.
        if (existing?.enabled) {
            await logEvent(db, ctx, {
                action: 'TRUST_CENTER_UPDATED',
                entityType: 'TrustCenter',
                entityId: row.id,
                details: 'Edited trust-center content while published',
                detailsJson: { category: 'entity_lifecycle', entityName: 'TrustCenter', operation: 'updated', summary: 'Published content edited' },
                metadata: { slug: row.slug },
            });
        }
        return row;
    });
}

/**
 * Publish (enable) or unpublish (disable) the trust center. OWNER-gated +
 * audited — this exposes / withdraws company data on the public internet.
 */
export async function setTrustCenterEnabled(ctx: RequestContext, enabled: boolean) {
    assertCanWrite(ctx);
    // Defence in depth — the route also gates on admin.tenant_lifecycle, but
    // publishing to the internet is OWNER-only, so re-assert here.
    if (!ctx.appPermissions?.admin?.tenant_lifecycle) {
        throw forbidden('Publishing the Trust Center requires the OWNER role');
    }

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.trustCenter.findUnique({ where: { tenantId: ctx.tenantId } });
        if (!existing) throw notFound('Trust Center not composed yet');

        const row = await db.trustCenter.update({
            where: { tenantId: ctx.tenantId },
            data: { enabled, publishedByUserId: ctx.userId },
        });

        await logEvent(db, ctx, {
            action: enabled ? 'TRUST_CENTER_PUBLISHED' : 'TRUST_CENTER_UNPUBLISHED',
            entityType: 'TrustCenter',
            entityId: row.id,
            details: enabled
                ? `Published trust center to /trust/${row.slug}`
                : `Unpublished trust center /trust/${row.slug}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TrustCenter',
                operation: 'updated',
                summary: enabled ? 'Trust Center PUBLISHED (public)' : 'Trust Center unpublished',
            },
            metadata: { slug: row.slug, enabled },
        });
        return row;
    });
}
