'use client';

/**
 * The public page's documents on request (#4649): each gated document by
 * name, with a form a visitor fills in to ask for it.
 *
 * The request is always recorded for an administrator to approve; nothing here
 * opens a document. The server answers every valid request the same way, so
 * the page says only that the request was received — never whether it will be
 * granted.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { apiErrorMessage } from '@/lib/api-error';

interface Props {
    slug: string;
    ndaRequired: boolean;
    documents: Array<{ id: string; label: string }>;
}

export function GatedDocumentRequests({ slug, ndaRequired, documents }: Props) {
    const t = useTranslations('external.trustCenter.gated');
    const [openId, setOpenId] = useState<string | null>(null);
    const [received, setReceived] = useState<string[]>([]);

    return (
        <section className="space-y-default" id="trust-gated-documents">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-content-muted">{t('title')}</h2>
            <p className="text-sm text-content-muted">{t('intro')}</p>
            <ul className="space-y-default">
                {documents.map((d) => (
                    <li key={d.id} className="rounded-md border border-border-subtle p-4 space-y-default">
                        <div className="flex flex-wrap items-center justify-between gap-default">
                            <span className="font-medium text-content-default">{d.label}</span>
                            {!received.includes(d.id) && openId !== d.id && (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => setOpenId(d.id)}
                                    id={`trust-request-${d.id}`}
                                >
                                    {t('request')}
                                </Button>
                            )}
                        </div>
                        {received.includes(d.id) && (
                            <p className="text-sm text-content-success" role="status">{t('received')}</p>
                        )}
                        {openId === d.id && (
                            <RequestForm
                                slug={slug}
                                documentId={d.id}
                                ndaRequired={ndaRequired}
                                onCancel={() => setOpenId(null)}
                                onReceived={() => {
                                    setOpenId(null);
                                    setReceived((r) => [...r, d.id]);
                                }}
                            />
                        )}
                    </li>
                ))}
            </ul>
        </section>
    );
}

function RequestForm({
    slug,
    documentId,
    ndaRequired,
    onCancel,
    onReceived,
}: {
    slug: string;
    documentId: string;
    ndaRequired: boolean;
    onCancel: () => void;
    onReceived: () => void;
}) {
    const t = useTranslations('external.trustCenter.gated');
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [company, setCompany] = useState('');
    const [ndaAccepted, setNdaAccepted] = useState(false);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const canSend = name.trim() !== '' && email.trim() !== '' && (!ndaRequired || ndaAccepted) && !sending;

    const submit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!canSend) return;
        setSending(true);
        setError(null);
        try {
            const res = await fetch(`/api/trust/${encodeURIComponent(slug)}/access-request`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    documentId,
                    requesterName: name.trim(),
                    requesterEmail: email.trim(),
                    company: company.trim() || undefined,
                    ndaAccepted: ndaRequired ? ndaAccepted : undefined,
                }),
            });
            if (res.ok) {
                onReceived();
                return;
            }
            // 404 is the route's one answer for a document no longer offered;
            // its body is a code, so it is said in words instead.
            if (res.status === 404) {
                setError(t('unavailable'));
                return;
            }
            const body: unknown = await res.json().catch(() => null);
            setError(apiErrorMessage(body, t('failed')));
        } catch {
            setError(t('failed'));
        } finally {
            setSending(false);
        }
    };

    return (
        <form onSubmit={(e) => void submit(e)} className="space-y-default" id={`trust-request-form-${documentId}`}>
            <FormField label={t('name')} required>
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoComplete="name" />
            </FormField>
            <FormField label={t('email')} required>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} autoComplete="email" />
            </FormField>
            <FormField label={t('company')}>
                <Input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={200} autoComplete="organization" />
            </FormField>
            {ndaRequired && (
                <label className="flex items-start gap-tight text-sm text-content-default">
                    <input type="checkbox" checked={ndaAccepted} onChange={(e) => setNdaAccepted(e.target.checked)} />
                    {t('nda')}
                </label>
            )}
            {error && (
                <p className="text-sm text-content-error" role="alert">
                    {error}
                </p>
            )}
            <div className="flex items-center gap-tight">
                {/* Secondary: the form opens inside one document's row, under the
                    page's own content (`primary-secondary-ratio`). */}
                <Button type="submit" variant="secondary" size="sm" disabled={!canSend} loading={sending}>
                    {sending ? t('sending') : t('submit')}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                    {t('cancel')}
                </Button>
            </div>
        </form>
    );
}
