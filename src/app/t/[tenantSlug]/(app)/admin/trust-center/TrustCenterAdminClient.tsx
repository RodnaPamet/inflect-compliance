'use client';

/**
 * Trust Center compose UI (authenticated, admin).
 *
 * Composes the curated public projection + a LIVE PREVIEW of the draft, so the
 * publisher verifies before enabling. Publishing is an OWNER-only,
 * confirm-gated, audited action — the toggle is only rendered for OWNERs
 * (canPublish).
 *
 * #4824: the preview shows the DRAFT, and the public page shows the SAVED row,
 * so the two can differ. The page says so while they do, and Publish saves the
 * draft first: an owner never publishes something other than what they see. A
 * row filled in halfway is refused on the row, not dropped on save.
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from '@inflect/ui/components/ui/icons/nucleo/plus';
import { Trash } from '@inflect/ui/components/ui/icons/nucleo/trash';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/ui/form-field';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { useToast } from '@/components/ui/hooks';
import { apiErrorMessage, validationIssueMessages } from '@/lib/api-error';
import {
    documentRowProblem,
    frameworkRowProblem,
    publishedDocuments,
    publishedFrameworks,
} from '@/lib/trust-center/compose-rows';
import { GatedDocumentsAdmin } from './GatedDocumentsAdmin';

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
    /** The deployment's configured public origin (APP_URL), when it has one. */
    publicOrigin?: string | null;
}

interface Draft {
    displayName: string;
    tagline: string;
    postureSummary: string;
    securityContact: string;
    indexable: boolean;
    publishedFrameworks: Framework[];
    publishedDocuments: Document[];
}

/** The draft as it would be saved: blank rows are not published. */
function draftOf(d: Draft): Draft {
    return {
        ...d,
        publishedFrameworks: publishedFrameworks(d.publishedFrameworks),
        publishedDocuments: publishedDocuments(d.publishedDocuments),
    };
}

function draftFromRow(row: TrustCenterData | null): Draft {
    return {
        displayName: row?.displayName ?? '',
        tagline: row?.tagline ?? '',
        postureSummary: row?.postureSummary ?? '',
        securityContact: row?.securityContact ?? '',
        indexable: row?.indexable ?? false,
        publishedFrameworks: row?.publishedFrameworks ?? [],
        publishedDocuments: row?.publishedDocuments ?? [],
    };
}

/** A refusal says why (a schema refusal lists each field); a server fault says only that it failed. */
async function refusalOf(res: Response, fallback: string): Promise<string> {
    if (res.status >= 500) return fallback;
    const body: unknown = await res.json().catch(() => null);
    const issues = validationIssueMessages(body);
    return issues.length > 0 ? issues.join(' ') : apiErrorMessage(body, fallback);
}

// The browser's own origin, read without a hydration mismatch: the server
// snapshot is empty and the client's is filled in after hydration.
const noSubscribe = () => () => {};
const clientOrigin = () => window.location.origin;
const serverOrigin = () => '';

export function TrustCenterAdminClient({ tenantSlug, initial, canPublish, publicOrigin = null }: Props) {
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
    // What the server holds, as the form would send it: the draft differs from
    // the public page exactly while this differs from the draft.
    const [savedDraft, setSavedDraft] = useState(() => JSON.stringify(draftOf(draftFromRow(initial))));
    // Whether the server holds a trust center at all; before the first save
    // there is nothing public to differ from.
    const [stored, setStored] = useState(initial !== null);

    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);

    const draft = useMemo(
        () => draftOf({ displayName, tagline, postureSummary, securityContact, indexable, publishedFrameworks: frameworks, publishedDocuments: documents }),
        [displayName, tagline, postureSummary, securityContact, indexable, frameworks, documents],
    );
    const dirty = !stored || JSON.stringify(draft) !== savedDraft;
    const frameworkProblems = frameworks.map(frameworkRowProblem);
    const documentProblems = documents.map(documentRowProblem);
    const rowsNeedFixing = [...frameworkProblems, ...documentProblems].some((p) => p !== null);

    /** Save the draft. True when the server took it. */
    const save = useCallback(async (): Promise<boolean> => {
        if (rowsNeedFixing) {
            toast.error(t('trustCenter.rowsNeedFixing'));
            return false;
        }
        setSaving(true);
        try {
            const res = await fetch(apiUrl('/admin/trust-center'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(draft),
            });
            if (!res.ok) {
                toast.error(await refusalOf(res, t('trustCenter.toastSaveFailed')));
                return false;
            }
            const row = (await res.json()) as TrustCenterData | null;
            if (row?.slug) setSlug(row.slug);
            // The form now shows what the server stored, which is what the
            // public page shows (it trims and normalises addresses).
            if (row) {
                const stored = draftFromRow(row);
                setDisplayName(stored.displayName);
                setTagline(stored.tagline);
                setPostureSummary(stored.postureSummary);
                setSecurityContact(stored.securityContact);
                setIndexable(stored.indexable);
                setFrameworks(stored.publishedFrameworks);
                setDocuments(stored.publishedDocuments);
                setSavedDraft(JSON.stringify(draftOf(stored)));
            } else {
                setSavedDraft(JSON.stringify(draft));
            }
            setStored(true);
            toast.success(t('trustCenter.toastSaved'));
            router.refresh();
            return true;
        } catch {
            toast.error(t('trustCenter.toastSaveFailed'));
            return false;
        } finally {
            setSaving(false);
        }
    }, [apiUrl, draft, rowsNeedFixing, router, toast, t]);

    const setPublished = useCallback(async (next: boolean) => {
        try {
            const res = await fetch(apiUrl('/admin/trust-center/enable'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
            });
            if (!res.ok) {
                toast.error(await refusalOf(res, t('trustCenter.toastPublishFailed')));
                return;
            }
            setEnabled(next);
            toast.success(next ? t('trustCenter.toastPublic') : t('trustCenter.toastUnpublished'));
            router.refresh();
        } catch {
            toast.error(t('trustCenter.toastPublishFailed'));
        }
    }, [apiUrl, router, toast, t]);

    const publicPath = `/trust/${slug}`;
    const browserOrigin = useSyncExternalStore(noSubscribe, clientOrigin, serverOrigin);
    const publicUrl = `${publicOrigin ?? browserOrigin}${publicPath}`;

    const preview = useMemo(() => ({
        displayName, tagline, postureSummary, securityContact,
        frameworks: draft.publishedFrameworks.filter((f) => frameworkRowProblem(f) === null),
        documents: draft.publishedDocuments.filter((d) => documentRowProblem(d) === null),
    }), [displayName, tagline, postureSummary, securityContact, draft]);

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
                <p className="text-content-muted">{t('trustCenter.intro')}</p>
                <div className="flex flex-wrap items-center gap-tight text-sm" id="trust-public-address">
                    <span className="text-content-muted">{t('trustCenter.publicUrlLabel')}</span>
                    <a
                        href={publicPath}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-content-link underline"
                        id="trust-public-link"
                    >
                        {publicUrl}
                    </a>
                    <CopyButton value={publicUrl} label={t('trustCenter.copyAddress')} successMessage={t('trustCenter.copyAddressOk')} size="sm" />
                    {!enabled && <span className="text-content-muted">{t('trustCenter.notPublishedNote')}</span>}
                </div>
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
                                <div key={i} className="space-y-tight">
                                    <div className="flex gap-tight">
                                        <Input value={f.key} onChange={(e) => setFrameworks((p) => p.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} placeholder="SOC 2" id={`trust-fw-key-${i}`} />
                                        <Input value={f.statusLabel} onChange={(e) => setFrameworks((p) => p.map((x, j) => j === i ? { ...x, statusLabel: e.target.value } : x))} placeholder={t('trustCenter.fwStatusPlaceholder')} id={`trust-fw-status-${i}`} />
                                        <Button variant="ghost" size="icon" aria-label={t('trustCenter.removeFramework')} onClick={() => setFrameworks((p) => p.filter((_, j) => j !== i))}><Trash className="h-4 w-4" /></Button>
                                    </div>
                                    {frameworkProblems[i] && (
                                        <p className="text-xs text-content-error" id={`trust-fw-error-${i}`}>{t('trustCenter.rowIncompleteFramework')}</p>
                                    )}
                                </div>
                            ))}
                            <Button variant="secondary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setFrameworks((p) => [...p, { key: '', statusLabel: '' }])}>{t('trustCenter.framework')}</Button>
                        </div>
                    </FormField>

                    <FormField label={t('trustCenter.publishedDocuments')} description={t('trustCenter.publishedDocumentsDesc')}>
                        <div className="space-y-tight">
                            {documents.map((d, i) => (
                                <div key={i} className="space-y-tight">
                                    <div className="flex gap-tight">
                                        <Input value={d.label} onChange={(e) => setDocuments((p) => p.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} placeholder={t('trustCenter.docLabelPlaceholder')} id={`trust-doc-label-${i}`} />
                                        <Input value={d.url} onChange={(e) => setDocuments((p) => p.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} placeholder="https://…" id={`trust-doc-url-${i}`} />
                                        <Button variant="ghost" size="icon" aria-label={t('trustCenter.removeDocument')} onClick={() => setDocuments((p) => p.filter((_, j) => j !== i))}><Trash className="h-4 w-4" /></Button>
                                    </div>
                                    {documentProblems[i] && (
                                        <p className="text-xs text-content-error" id={`trust-doc-error-${i}`}>
                                            {documentProblems[i] === 'badUrl' ? t('trustCenter.rowBadUrl') : t('trustCenter.rowIncompleteDocument')}
                                        </p>
                                    )}
                                </div>
                            ))}
                            <Button variant="secondary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setDocuments((p) => [...p, { label: '', url: '' }])}>{t('trustCenter.document')}</Button>
                        </div>
                    </FormField>

                    <FormField label={t('trustCenter.searchIndexing')}>
                        <label className="flex items-center gap-tight text-content-default">
                            <Checkbox id="trust-indexable" checked={indexable} onCheckedChange={(v) => setIndexable(v === true)} />
                            {t('trustCenter.allowIndexing')}
                        </label>
                    </FormField>

                    {dirty && stored && (
                        <p className="text-sm text-content-warning" id="trust-unsaved-note">
                            {enabled ? t('trustCenter.unsavedPublished') : t('trustCenter.unsavedDraft')}
                        </p>
                    )}
                    <div className="flex items-center gap-default pt-default">
                        <Button variant="primary" onClick={() => void save()} disabled={saving || rowsNeedFixing} loading={saving} id="trust-save">{t('trustCenter.save')}</Button>
                        {canPublish && !enabled && (
                            <Button variant="secondary" onClick={() => setConfirmOpen(true)} disabled={saving || rowsNeedFixing} id="trust-publish">{t('trustCenter.publish')}</Button>
                        )}
                        {canPublish && enabled && (
                            <Button variant="secondary" onClick={() => setPublished(false)}>{t('trustCenter.unpublish')}</Button>
                        )}
                        {!canPublish && (
                            <span className="text-sm text-content-muted">{t('trustCenter.publishRequiresOwner')}</span>
                        )}
                    </div>
                </section>

                {/* ── Live preview of the draft (the public page shows the saved row) ── */}
                <section className="space-y-default">
                    <Heading level={2}>{t('trustCenter.publicPreview')}</Heading>
                    <p className="text-sm text-content-muted">{t('trustCenter.previewDraftNote')}</p>
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

            {/* Documents on request and their access requests (#4649). */}
            <GatedDocumentsAdmin tenantSlug={tenantSlug} />

            {/* Publishing is a serious, gravity-carrying action but not a
                DESTRUCTIVE delete — the confirm copy conveys the gravity; the
                default tone avoids the destructive-verb vocabulary ratchet. */}
            <ConfirmDialog
                showModal={confirmOpen}
                setShowModal={setConfirmOpen}
                title={t('trustCenter.confirmTitle')}
                description={
                    dirty
                        ? `${t('trustCenter.confirmDesc', { path: publicUrl })} ${t('trustCenter.confirmSavesFirst')}`
                        : t('trustCenter.confirmDesc', { path: publicUrl })
                }
                confirmLabel={t('trustCenter.confirmLabel')}
                onConfirm={async () => {
                    setConfirmOpen(false);
                    // Publish what the owner sees: an unsaved draft is saved
                    // first, and a refused save publishes nothing.
                    if (dirty && !(await save())) return;
                    await setPublished(true);
                }}
            />
        </div>
    );
}
