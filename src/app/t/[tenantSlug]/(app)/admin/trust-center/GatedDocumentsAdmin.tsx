'use client';

/**
 * Documents on request, and the requests for them (#4649).
 *
 * The server side was complete and no screen called it, so gated documents
 * could not be added, requested, approved or downloaded through the product.
 * This is the administrator's half; the visitor's is on `/trust/<slug>`.
 *
 *   - ADD. The file is uploaded as an evidence record (the one upload path,
 *     which scans and stores it), and its file record becomes the gated
 *     document. The download route serves it only once the scan passes.
 *   - APPROVE. The server mints a single-use link that expires in 7 days and
 *     returns it ONCE — only its hash is kept. Delivering it is left to the
 *     administrator on purpose: approving a visitor-supplied address must not
 *     send a document to it without a person looking. So the link is shown
 *     here, with copy and email, and never again.
 *   - DENY, NEW LINK, REMOVE (#4824). A waiting request can be denied. An
 *     approved one can be given a new link, which replaces the old one (it
 *     lapsed, was used, or was lost). A document can be removed, with its
 *     requests and their links; the commit waits out the undo window.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDate } from '@inflect/ui/lib/format-date';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { useToast, useToastWithUndo } from '@/components/ui/hooks';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useHydratedNow } from '@/lib/hooks/use-hydrated-now';

interface GatedDocument {
    id: string;
    label: string;
    gated: boolean;
    createdAt: string;
}

interface AccessRequest {
    id: string;
    requesterName: string;
    requesterEmail: string;
    company: string | null;
    status: 'REQUESTED' | 'APPROVED' | 'DENIED';
    ndaSignedAt: string | null;
    expiresAt: string | null;
    downloadedAt: string | null;
    createdAt: string;
    document: { label: string };
}

const STATUS_TONE: Record<AccessRequest['status'], StatusBadgeVariant> = {
    REQUESTED: 'warning',
    APPROVED: 'success',
    DENIED: 'neutral',
};

interface IssuedLink {
    requestId: string;
    name: string;
    email: string;
    document: string;
    url: string;
    /** A new link for an already approved request: the previous one no longer works. */
    replaced: boolean;
}

/** A refusal says why; a server fault, or a body with no message, gets the fallback. */
async function refusalOf(res: Response, fallback: string): Promise<string> {
    if (res.status >= 500) return fallback;
    const body: unknown = await res.json().catch(() => null);
    return apiErrorMessage(body, fallback);
}

export function GatedDocumentsAdmin({ tenantSlug }: { tenantSlug: string }) {
    const t = useTranslations('admin.trustCenter.gated');
    const toast = useToast();
    const triggerUndoToast = useToastWithUndo();
    const apiUrl = (path: string) => `/api/t/${tenantSlug}${path}`;

    const docs = useTenantSWR<{ documents: GatedDocument[] }>('/admin/trust-center/documents');
    const reqs = useTenantSWR<{ requests: AccessRequest[] }>('/admin/trust-center/requests');

    const [label, setLabel] = useState('');
    const [file, setFile] = useState<File | null>(null);
    const [fileInputKey, setFileInputKey] = useState(0);
    const [uploading, setUploading] = useState(false);
    const [approving, setApproving] = useState<string | null>(null);
    const [denying, setDenying] = useState<string | null>(null);
    // The clock, once the client has painted: before that a link reads as
    // live, so the server HTML and the first client render agree (#418).
    const now = useHydratedNow();
    const [issued, setIssued] = useState<IssuedLink | null>(null);

    const addDocument = async () => {
        if (!label.trim() || !file) {
            toast.error(t('needLabelAndFile'));
            return;
        }
        setUploading(true);
        try {
            const form = new FormData();
            form.append('file', file);
            form.append('title', label.trim());
            const upload = await fetch(apiUrl('/evidence/uploads'), { method: 'POST', body: form, credentials: 'same-origin' });
            const uploaded: unknown = await upload.json().catch(() => null);
            if (!upload.ok) {
                toast.error(apiErrorMessage(uploaded, t('addFailed')));
                return;
            }
            const fileRecordId = (uploaded as { fileRecord?: { id?: string } } | null)?.fileRecord?.id;
            if (!fileRecordId) {
                toast.error(t('addFailed'));
                return;
            }
            const res = await fetch(apiUrl('/admin/trust-center/documents'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: label.trim(), fileRecordId, gated: true }),
            });
            if (!res.ok) {
                const body: unknown = await res.json().catch(() => null);
                toast.error(apiErrorMessage(body, t('addFailed')));
                return;
            }
            toast.success(t('added'));
            setLabel('');
            setFile(null);
            setFileInputKey((k) => k + 1);
            await docs.mutate();
        } catch {
            toast.error(t('addFailed'));
        } finally {
            setUploading(false);
        }
    };

    const approve = async (r: AccessRequest) => {
        setApproving(r.id);
        try {
            const res = await fetch(apiUrl(`/admin/trust-center/requests/${r.id}/approve`), { method: 'POST' });
            if (!res.ok) {
                toast.error(await refusalOf(res, t('approveFailed')));
                return;
            }
            const body: unknown = await res.json().catch(() => null);
            const token = (body as { downloadToken?: string } | null)?.downloadToken;
            if (token) {
                setIssued({
                    requestId: r.id,
                    name: r.requesterName,
                    email: r.requesterEmail,
                    document: r.document.label,
                    url: `${window.location.origin}/api/trust/download/${token}`,
                    replaced: r.status === 'APPROVED',
                });
            }
            await reqs.mutate();
        } catch {
            toast.error(t('approveFailed'));
        } finally {
            setApproving(null);
        }
    };

    const deny = async (r: AccessRequest) => {
        setDenying(r.id);
        try {
            const res = await fetch(apiUrl(`/admin/trust-center/requests/${r.id}/deny`), { method: 'POST' });
            if (!res.ok) {
                toast.error(await refusalOf(res, t('denyFailed')));
                return;
            }
            toast.success(t('denied'));
            await reqs.mutate();
        } catch {
            toast.error(t('denyFailed'));
        } finally {
            setDenying(null);
        }
    };

    // Removing a document deletes its requests and their links with it, so the
    // DELETE waits out the undo window (Epic 67); the row leaves the list now.
    const removeDocument = (d: GatedDocument) => {
        const snapshot = docs.data;
        if (!snapshot) return;
        void docs.mutate({ documents: snapshot.documents.filter((x) => x.id !== d.id) }, { revalidate: false });
        triggerUndoToast({
            message: t('removed', { label: d.label }),
            undoMessage: t('undo'),
            action: async () => {
                const res = await fetch(apiUrl(`/admin/trust-center/documents/${d.id}`), { method: 'DELETE' });
                if (!res.ok) throw new Error(await refusalOf(res, t('removeFailed')));
                await Promise.all([docs.mutate(), reqs.mutate()]);
            },
            undoAction: () => { void docs.mutate(snapshot, { revalidate: false }); },
            onError: (e) => {
                void docs.mutate(snapshot, { revalidate: false });
                toast.error(e instanceof Error && e.message ? e.message : t('removeFailed'));
            },
        });
    };

    const documents = docs.data?.documents.filter((d) => d.gated) ?? [];
    const requests = reqs.data?.requests ?? [];

    return (
        <div className="grid gap-section lg:grid-cols-2" id="trust-gated-admin">
            <section className="space-y-default">
                <Heading level={2}>{t('title')}</Heading>
                <p className="text-sm text-content-muted">{t('intro')}</p>

                {docs.error ? (
                    <InlineNotice variant="error" icon={null}>{t('loadFailed')}</InlineNotice>
                ) : docs.data && documents.length === 0 ? (
                    <p className="text-sm text-content-muted" id="trust-gated-empty">{t('emptyDocuments')}</p>
                ) : (
                    <ul className="space-y-tight" id="trust-gated-list">
                        {documents.map((d) => (
                            <li key={d.id} className="flex items-center justify-between gap-default rounded-md border border-border-subtle px-3 py-2" id={`trust-gated-row-${d.id}`}>
                                <span className="font-medium text-content-default">{d.label}</span>
                                <span className="flex items-center gap-default">
                                    <span className="text-xs text-content-subtle">{t('addedOn', { date: formatDate(d.createdAt) })}</span>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => removeDocument(d)}
                                        aria-label={t('removeAria', { label: d.label })}
                                        id={`trust-gated-remove-${d.id}`}
                                    >
                                        {t('remove')}
                                    </Button>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}

                <div className="space-y-default rounded-md border border-border-subtle p-4">
                    <FormField label={t('labelField')} required>
                        <Input id="trust-gated-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} />
                    </FormField>
                    <FormField label={t('fileField')} required>
                        <input
                            key={fileInputKey}
                            id="trust-gated-file"
                            type="file"
                            className="block text-sm text-content-default"
                            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                        />
                    </FormField>
                    <Button variant="secondary" onClick={() => void addDocument()} disabled={uploading} loading={uploading} id="trust-gated-upload">
                        {uploading ? t('uploading') : t('upload')}
                    </Button>
                </div>
            </section>

            <section className="space-y-default">
                <Heading level={2}>{t('requestsTitle')}</Heading>
                <p className="text-sm text-content-muted">{t('requestsIntro')}</p>

                {issued && (
                    <InlineNotice variant="success" icon={null}>
                        <div className="space-y-tight" id="trust-issued-link">
                            <p className="font-medium">{t('linkTitle', { name: issued.name })}</p>
                            <p className="text-sm">{t('linkHint', { email: issued.email })}</p>
                            {issued.replaced && <p className="text-sm" id="trust-issued-replaced">{t('linkReplaced')}</p>}
                            <code className="block break-all rounded bg-bg-muted px-2 py-1 text-xs">{issued.url}</code>
                            <div className="flex flex-wrap items-center gap-tight">
                                <CopyButton value={issued.url} label={t('copyLink')} successMessage={t('copyLinkOk')} size="sm" />
                                <a
                                    className="text-sm text-content-link underline"
                                    href={`mailto:${encodeURIComponent(issued.email)}?subject=${encodeURIComponent(t('mailSubject', { document: issued.document }))}&body=${encodeURIComponent(t('mailBody', { document: issued.document, link: issued.url }))}`}
                                >
                                    {t('emailLink')}
                                </a>
                                <Button variant="ghost" size="sm" onClick={() => setIssued(null)}>
                                    {t('dismissLink')}
                                </Button>
                            </div>
                        </div>
                    </InlineNotice>
                )}

                {reqs.error ? (
                    <InlineNotice variant="error" icon={null}>{t('requestsLoadFailed')}</InlineNotice>
                ) : reqs.data && requests.length === 0 ? (
                    <p className="text-sm text-content-muted" id="trust-requests-empty">{t('emptyRequests')}</p>
                ) : (
                    <ul className="space-y-tight" id="trust-requests-list">
                        {requests.map((r) => (
                            <li key={r.id} className="space-y-tight rounded-md border border-border-subtle px-3 py-2" id={`trust-request-row-${r.id}`}>
                                <div className="flex flex-wrap items-center justify-between gap-default">
                                    <span className="font-medium text-content-default">{r.document.label}</span>
                                    <StatusBadge variant={STATUS_TONE[r.status] ?? 'neutral'}>{t(`status.${r.status}`)}</StatusBadge>
                                </div>
                                <p className="text-sm text-content-default">
                                    {r.requesterName} · {r.requesterEmail}
                                    {r.company ? ` · ${r.company}` : ''}
                                </p>
                                <p className="flex flex-wrap gap-default text-xs text-content-subtle">
                                    <span>{t('requestedOn', { date: formatDate(r.createdAt) })}</span>
                                    {r.ndaSignedAt && <span>{t('ndaAccepted')}</span>}
                                    {r.downloadedAt && <span>{t('downloadedOn', { date: formatDate(r.downloadedAt) })}</span>}
                                    {r.status === 'APPROVED' && !r.downloadedAt && r.expiresAt && (
                                        <span>
                                            {now && new Date(r.expiresAt) <= now
                                                ? t('expiredOn', { date: formatDate(r.expiresAt) })
                                                : t('expiresOn', { date: formatDate(r.expiresAt) })}
                                        </span>
                                    )}
                                </p>
                                {/* A waiting request is approved or denied; an approved one
                                    can be given a new link; a denied one is final (#4824). */}
                                {r.status === 'REQUESTED' && (
                                    <div className="flex flex-wrap gap-tight">
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            onClick={() => void approve(r)}
                                            disabled={approving !== null || denying !== null}
                                            loading={approving === r.id}
                                            id={`trust-approve-${r.id}`}
                                        >
                                            {approving === r.id ? t('approving') : t('approve')}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => void deny(r)}
                                            disabled={approving !== null || denying !== null}
                                            loading={denying === r.id}
                                            id={`trust-deny-${r.id}`}
                                        >
                                            {t('deny')}
                                        </Button>
                                    </div>
                                )}
                                {r.status === 'APPROVED' && (
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => void approve(r)}
                                        disabled={approving !== null || denying !== null}
                                        loading={approving === r.id}
                                        id={`trust-reissue-${r.id}`}
                                    >
                                        {approving === r.id ? t('approving') : t('reissue')}
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
