'use client';

/**
 * Trust Center compose UI (authenticated, admin).
 *
 * Composes the curated public projection + a LIVE PREVIEW of exactly what the
 * public /trust/<slug> page shows, so the publisher verifies before enabling.
 * Publishing is an OWNER-only, confirm-gated, audited action — the toggle is
 * only rendered for OWNERs (canPublish).
 */
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from '@inflect/ui/components/ui/icons/nucleo/plus';
import { Trash } from '@inflect/ui/components/ui/icons/nucleo/trash';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/ui/form-field';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { useToast } from '@/components/ui/hooks';

interface Framework { key: string; statusLabel: string; badge?: string }
interface Document { label: string; url: string }

interface TrustCenterData {
    slug: string;
    enabled: boolean;
    indexable: boolean;
    displayName: string;
    tagline: string | null;
    postureSummary: string | null;
    securityContact: string | null;
    publishedFrameworks: Framework[];
    publishedDocuments: Document[];
}

interface Props {
    tenantSlug: string;
    initial: TrustCenterData | null;
    canPublish: boolean;
}

export function TrustCenterAdminClient({ tenantSlug, initial, canPublish }: Props) {
    const t = useTranslations('admin');
    const router = useRouter();
    const toast = useToast();

    const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
    const [tagline, setTagline] = useState(initial?.tagline ?? '');
    const [postureSummary, setPostureSummary] = useState(initial?.postureSummary ?? '');
    const [securityContact, setSecurityContact] = useState(initial?.securityContact ?? '');
    const [indexable, setIndexable] = useState(initial?.indexable ?? false);
    const [frameworks, setFrameworks] = useState<Framework[]>(initial?.publishedFrameworks ?? []);
    const [documents, setDocuments] = useState<Document[]>(initial?.publishedDocuments ?? []);
    const [enabled, setEnabled] = useState(initial?.enabled ?? false);
    const [slug, setSlug] = useState(initial?.slug ?? tenantSlug);
    const [saving, setSaving] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);

    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);

    const save = useCallback(async () => {
        setSaving(true);
        try {
            const res = await fetch(apiUrl('/admin/trust-center'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    displayName, tagline, postureSummary, securityContact, indexable,
                    publishedFrameworks: frameworks.filter((f) => f.key && f.statusLabel),
                    publishedDocuments: documents.filter((d) => d.label && d.url),
                }),
            });
            if (!res.ok) throw new Error(String(res.status));
            const row = await res.json();
            if (row?.slug) setSlug(row.slug);
            toast.success(t('trustCenter.toastSaved'));
            router.refresh();
        } catch {
            toast.error(t('trustCenter.toastSaveFailed'));
        } finally {
            setSaving(false);
        }
    }, [apiUrl, displayName, tagline, postureSummary, securityContact, indexable, frameworks, documents, router, toast, t]);

    const setPublished = useCallback(async (next: boolean) => {
        try {
            const res = await fetch(apiUrl('/admin/trust-center/enable'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
            });
            if (!res.ok) throw new Error(String(res.status));
            setEnabled(next);
            toast.success(next ? t('trustCenter.toastPublic') : t('trustCenter.toastUnpublished'));
            router.refresh();
        } catch {
            toast.error(t('trustCenter.toastPublishFailed'));
        }
    }, [apiUrl, router, toast, t]);

    const publicPath = `/trust/${slug}`;

    const preview = useMemo(() => ({
        displayName, tagline, postureSummary, securityContact,
        frameworks: frameworks.filter((f) => f.key && f.statusLabel),
        documents: documents.filter((d) => d.label && d.url),
    }), [displayName, tagline, postureSummary, securityContact, frameworks, documents]);

    return (
        <div className="space-y-section">
            <div className="space-y-default">
                <BackAffordance override={{ href: `/t/${tenantSlug}/admin`, label: t('crumb.admin') }} />
                <PageBreadcrumbs
                    items={[
                        { label: t('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
                        { label: t('crumb.admin'), href: `/t/${tenantSlug}/admin` },
                        { label: t('trustCenter.title') },
                    ]}
                />
                <div className="flex items-center justify-between gap-default">
                    <Heading level={1}>{t('trustCenter.title')}</Heading>
                    <StatusBadge variant={enabled ? 'success' : 'neutral'}>
                        {enabled ? t('trustCenter.statusPublic') : t('trustCenter.statusNotPublished')}
                    </StatusBadge>
                </div>
                <p className="text-content-muted">
                    {t('trustCenter.intro')}{' '}
                    {t('trustCenter.publicUrlLabel')} <span className="font-mono text-content-default">{publicPath}</span>
                </p>
            </div>

            <div className="grid gap-section lg:grid-cols-2">
                {/* ── Compose ── */}
                <section className="space-y-default">
                    <Heading level={2}>{t('trustCenter.content')}</Heading>
                    <FormField label={t('trustCenter.displayName')} required>
                        <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Acme Inc." />
                    </FormField>
                    <FormField label={t('trustCenter.tagline')}>
                        <Input value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder={t('trustCenter.taglinePlaceholder')} />
                    </FormField>
                    <FormField label={t('trustCenter.postureSummary')} description={t('trustCenter.postureSummaryDesc')}>
                        <Textarea value={postureSummary} onChange={(e) => setPostureSummary(e.target.value)} rows={5} />
                    </FormField>
                    <FormField label={t('trustCenter.securityContact')}>
                        <Input value={securityContact} onChange={(e) => setSecurityContact(e.target.value)} placeholder="security@acme.com" />
                    </FormField>

                    <FormField label={t('trustCenter.frameworksToShow')} description={t('trustCenter.frameworksDesc')}>
                        <div className="space-y-tight">
                            {frameworks.map((f, i) => (
                                <div key={i} className="flex gap-tight">
                                    <Input value={f.key} onChange={(e) => setFrameworks((p) => p.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} placeholder="SOC 2" />
                                    <Input value={f.statusLabel} onChange={(e) => setFrameworks((p) => p.map((x, j) => j === i ? { ...x, statusLabel: e.target.value } : x))} placeholder={t('trustCenter.fwStatusPlaceholder')} />
                                    <Button variant="ghost" size="icon" aria-label={t('trustCenter.removeFramework')} onClick={() => setFrameworks((p) => p.filter((_, j) => j !== i))}><Trash className="h-4 w-4" /></Button>
                                </div>
                            ))}
                            <Button variant="secondary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setFrameworks((p) => [...p, { key: '', statusLabel: '' }])}>{t('trustCenter.framework')}</Button>
                        </div>
                    </FormField>

                    <FormField label={t('trustCenter.publishedDocuments')} description={t('trustCenter.publishedDocumentsDesc')}>
                        <div className="space-y-tight">
                            {documents.map((d, i) => (
                                <div key={i} className="flex gap-tight">
                                    <Input value={d.label} onChange={(e) => setDocuments((p) => p.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} placeholder={t('trustCenter.docLabelPlaceholder')} />
                                    <Input value={d.url} onChange={(e) => setDocuments((p) => p.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} placeholder="https://…" />
                                    <Button variant="ghost" size="icon" aria-label={t('trustCenter.removeDocument')} onClick={() => setDocuments((p) => p.filter((_, j) => j !== i))}><Trash className="h-4 w-4" /></Button>
                                </div>
                            ))}
                            <Button variant="secondary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setDocuments((p) => [...p, { label: '', url: '' }])}>{t('trustCenter.document')}</Button>
                        </div>
                    </FormField>

                    <FormField label={t('trustCenter.searchIndexing')}>
                        <label className="flex items-center gap-tight text-content-default">
                            <input type="checkbox" checked={indexable} onChange={(e) => setIndexable(e.target.checked)} />
                            {t('trustCenter.allowIndexing')}
                        </label>
                    </FormField>

                    <div className="flex items-center gap-default pt-default">
                        <Button variant="primary" onClick={save} disabled={saving} loading={saving}>{t('trustCenter.save')}</Button>
                        {canPublish && !enabled && (
                            <Button variant="secondary" onClick={() => setConfirmOpen(true)}>{t('trustCenter.publish')}</Button>
                        )}
                        {canPublish && enabled && (
                            <Button variant="secondary" onClick={() => setPublished(false)}>{t('trustCenter.unpublish')}</Button>
                        )}
                        {!canPublish && (
                            <span className="text-sm text-content-muted">{t('trustCenter.publishRequiresOwner')}</span>
                        )}
                    </div>
                </section>

                {/* ── Live preview (exactly what the public sees) ── */}
                <section className="space-y-default">
                    <Heading level={2}>{t('trustCenter.publicPreview')}</Heading>
                    <div className="rounded-lg border border-border-default bg-bg-default p-6 space-y-default">
                        {/* Preview mirrors the external public surface — a styled
                            div, not an in-app document heading (heading-discipline). */}
                        <div className="text-xl font-semibold text-content-default">{preview.displayName || t('trustCenter.displayNameFallback')}</div>
                        {preview.tagline && <p className="text-content-muted">{preview.tagline}</p>}
                        {preview.frameworks.length > 0 && (
                            <div className="flex flex-wrap gap-tight">
                                {preview.frameworks.map((f, i) => (
                                    <span key={i} className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-bg-subtle px-2 py-1 text-sm">
                                        <span className="font-medium text-content-default">{f.key}</span>
                                        <span className="text-content-muted">{f.statusLabel}</span>
                                    </span>
                                ))}
                            </div>
                        )}
                        {preview.postureSummary && <p className="whitespace-pre-line text-content-default">{preview.postureSummary}</p>}
                        {preview.documents.length > 0 && (
                            <ul className="space-y-tight">
                                {preview.documents.map((d, i) => (
                                    <li key={i}><span className="text-content-link">{d.label}</span></li>
                                ))}
                            </ul>
                        )}
                        {preview.securityContact && <p className="text-sm text-content-muted">{t('trustCenter.securityContactPreview', { contact: preview.securityContact })}</p>}
                    </div>
                </section>
            </div>

            {/* Publishing is a serious, gravity-carrying action but not a
                DESTRUCTIVE delete — the confirm copy conveys the gravity; the
                default tone avoids the destructive-verb vocabulary ratchet. */}
            <ConfirmDialog
                showModal={confirmOpen}
                setShowModal={setConfirmOpen}
                title={t('trustCenter.confirmTitle')}
                description={t('trustCenter.confirmDesc', { path: publicPath })}
                confirmLabel={t('trustCenter.confirmLabel')}
                onConfirm={async () => {
                    setConfirmOpen(false);
                    await setPublished(true);
                }}
            />
        </div>
    );
}
