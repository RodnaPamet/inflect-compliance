/**
 * Public Trust Center page — /trust/<slug>.
 *
 * UNAUTHENTICATED + indexable (per tenant choice). SECURITY-CRITICAL: this
 * page reads ONLY the curated `TrustCenter` row via `getPublicTrustCenter`
 * and renders ONLY tenant-composed strings + selected framework badges. It
 * imports NOTHING from the tenant-data layer (Risk/Control/Evidence/Finding/…)
 * — enforced by tests/guardrails/trust-center-coverage.test.ts. A missing or
 * disabled slug returns 404 (never 403 — no tenant-existence disclosure).
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getPublicTrustCenter } from '@/lib/trust-center/public';
import { getPublicGatedDocuments } from '@/lib/trust-center/gated';
import { GatedDocumentRequests } from './GatedDocumentRequests';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
    params,
}: {
    params: Promise<{ slug: string }>;
}): Promise<Metadata> {
    const { slug } = await params;
    const t = await getTranslations('external.trustCenter');
    const tc = await getPublicTrustCenter(slug);
    if (!tc) {
        // Don't disclose existence — generic, noindex.
        return { title: t('metaTitleFallback'), robots: { index: false, follow: false } };
    }
    return {
        title: t('metaTitle', { name: tc.displayName }),
        description: tc.tagline ?? t('metaDescriptionFallback', { name: tc.displayName }),
        // X-Robots equivalent — the tenant chooses whether the page is indexed.
        robots: tc.indexable ? { index: true, follow: true } : { index: false, follow: false },
    };
}

export default async function TrustCenterPage({
    params,
}: {
    params: Promise<{ slug: string }>;
}) {
    const { slug } = await params;
    const t = await getTranslations('external.trustCenter');
    const tc = await getPublicTrustCenter(slug);
    if (!tc) notFound();
    // The curated gated read (same isolation contract): document ids and
    // labels only, for the request form. Never a file reference.
    const gated = await getPublicGatedDocuments(slug);

    return (
        <main className="mx-auto max-w-3xl px-6 py-12 space-y-section">
            <header className="space-y-default">
                <h1 className="text-3xl font-semibold text-content-default">{tc.displayName}</h1>
                {tc.tagline && <p className="text-lg text-content-muted">{tc.tagline}</p>}
            </header>

            {tc.publishedFrameworks.length > 0 && (
                <section className="space-y-default">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-content-muted">{t('compliance')}</h2>
                    <ul className="flex flex-wrap gap-default">
                        {tc.publishedFrameworks.map((f) => (
                            <li
                                key={f.key}
                                className="inline-flex items-center gap-tight rounded-md border border-border-subtle bg-bg-subtle px-3 py-2"
                            >
                                <span className="font-medium text-content-default">{f.key}</span>
                                <span className="text-content-muted">{f.statusLabel}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {tc.postureSummary && (
                <section className="space-y-default">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-content-muted">{t('securityPosture')}</h2>
                    <p className="whitespace-pre-line text-content-default">{tc.postureSummary}</p>
                </section>
            )}

            {tc.publishedDocuments.length > 0 && (
                <section className="space-y-default">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-content-muted">{t('documents')}</h2>
                    <ul className="space-y-tight">
                        {tc.publishedDocuments.map((d, i) => (
                            <li key={i}>
                                <a
                                    href={d.url}
                                    target="_blank"
                                    rel="noopener noreferrer nofollow"
                                    className="text-content-link hover:underline"
                                >
                                    {d.label}
                                </a>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {gated && gated.documents.length > 0 && (
                <GatedDocumentRequests slug={slug} ndaRequired={gated.ndaRequired} documents={gated.documents} />
            )}

            {tc.securityContact && (
                <section className="space-y-tight">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-content-muted">{t('securityContact')}</h2>
                    <p className="text-content-default">{tc.securityContact}</p>
                </section>
            )}

            <footer className="border-t border-border-subtle pt-default text-sm text-content-muted">
                {t('footer', { date: tc.updatedAt.toISOString().slice(0, 10) })}
            </footer>
        </main>
    );
}
