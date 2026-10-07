'use client';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { SkeletonCard } from '@/components/ui/skeleton';
import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AppIcon, type AppIconName } from '@/components/icons/AppIcon';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { Card, cardVariants } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@inflect/ui/lib/cn';

type ReturnChannelKind = 'COMMENT' | 'EVIDENCE_REQUEST' | 'FINDING' | 'QUESTION';
const KINDS: ReturnChannelKind[] = ['COMMENT', 'EVIDENCE_REQUEST', 'FINDING', 'QUESTION'];
interface SubmittedRow { id: string; kind: ReturnChannelKind; body: string; itemName?: string; }

const ENTITY_ICON: Record<string, AppIconName> = {
    CONTROL: 'controls', POLICY: 'policies', EVIDENCE: 'evidence', FILE: 'overview', ISSUE: 'warning',
    READINESS_REPORT: 'dashboard', FRAMEWORK_COVERAGE: 'frameworks',
};

// getPackByShareToken (audit-readiness/sharing.ts) — public share payload.
interface SharedPackData {
    pack: {
        id: string;
        name: string;
        status: 'DRAFT' | 'FROZEN' | 'EXPORTED';
        frozenAt: string | null;
    };
    cycle: { name: string; frameworkKey: string; frameworkVersion: string };
    items: Array<{
        id: string;
        entityType: 'CONTROL' | 'POLICY' | 'EVIDENCE' | 'FILE' | 'ISSUE' | 'READINESS_REPORT' | 'FRAMEWORK_COVERAGE';
        entityId: string;
        snapshotJson: string;
    }>;
}

type PackItem = SharedPackData['items'][number];

function itemDisplayName(item: PackItem): string {
    try {
        const snap = JSON.parse(item.snapshotJson || '{}');
        return snap.code || snap.title || snap.name || item.entityId;
    } catch {
        return item.entityId;
    }
}
// Parsed `snapshotJson` blob — heterogeneous per entity type, all optional.
interface PackSnapshot {
    code?: string;
    title?: string;
    name?: string;
    status?: string;
    description?: string;
    taskCompletion?: { done: number; total: number };
    evidenceCount?: number;
    mappedRequirements?: { code: string }[];
    severity?: string;
}

export default function SharedPackPage() {
    const t = useTranslations('external.auditShare');
    const params = useParams();
    const token = params.token as string;

    const [data, setData] = useState<SharedPackData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // ── Return channel (feat/auditor-return-channel) ──
    const [kind, setKind] = useState<ReturnChannelKind>('COMMENT');
    const [authorLabel, setAuthorLabel] = useState('');
    const [message, setMessage] = useState('');
    const [attachItemId, setAttachItemId] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [submissions, setSubmissions] = useState<SubmittedRow[]>([]);

    const submitFeedback = async () => {
        if (!message.trim() || submitting) return;
        setSubmitting(true);
        setSubmitError(null);
        try {
            const res = await fetch(`/api/audit/shared/${token}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind,
                    body: message.trim(),
                    authorLabel: authorLabel.trim() || undefined,
                    auditPackItemId: attachItemId || undefined,
                }),
            });
            if (!res.ok) throw new Error();
            const created = await res.json();
            const itemName = attachItemId
                ? (data?.items.find((i) => i.id === attachItemId)
                    ? itemDisplayName(data.items.find((i) => i.id === attachItemId)!)
                    : undefined)
                : undefined;
            setSubmissions((prev) => [{ id: created.id, kind, body: message.trim(), itemName }, ...prev]);
            setMessage('');
            setAttachItemId('');
        } catch {
            setSubmitError(t('returnChannel.submitError'));
        } finally {
            setSubmitting(false);
        }
    };

    useEffect(() => {
        fetch(`/api/audit/shared/${token}`)
            .then(async r => {
                if (!r.ok) {
                    const err = await r.json().catch(() => ({}));
                    throw new Error(err.message || t('invalidOrExpired'));
                }
                return r.json();
            })
            .then(setData)
            .catch(e => setError(e.message))
            .finally(() => setLoading(false));
        // `t` is a stable next-intl accessor; excluding it avoids a refetch loop.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    if (loading) return (
        <div className="min-h-screen bg-slate-900 flex items-center justify-center">
            <div className="w-96"><SkeletonCard lines={2} /></div>
        </div>
    );

    if (error) return (
        <div className="min-h-screen bg-slate-900 flex items-center justify-center">
            <Card className="max-w-md text-center">
                <div className="mb-4"><AppIcon name="lock" size={48} className="text-slate-400" /></div>
                <Heading level={1} className="mb-2">{t('accessDenied')}</Heading>
                <p className="text-slate-400 text-sm">{error}</p>
            </Card>
        </div>
    );

    const pack = data?.pack;
    const cycle = data?.cycle;
    const items = data?.items || [];

    const grouped: Record<string, PackItem[]> = {};
    items.forEach((item) => {
        if (!grouped[item.entityType]) grouped[item.entityType] = [];
        grouped[item.entityType].push(item);
    });

    return (
        <div className="min-h-screen bg-slate-900 text-white">
            <div className="max-w-4xl mx-auto p-6 space-y-section">
                {/* Header */}
                <div className="text-center py-4">
                    <div className="text-sm text-slate-500 uppercase tracking-wide mb-2">{t('sharedAuditPack')}</div>
                    <Heading level={1} id="shared-pack-name">{pack?.name}</Heading>
                    <p className="text-slate-400 text-sm mt-1">
                        {cycle?.name} · {cycle?.frameworkKey} · {pack?.status}
                    </p>
                    {pack?.frozenAt && (
                        <p className="text-xs text-slate-500 mt-1">
                            {t('frozen', { date: formatDateTime(pack.frozenAt) })}
                        </p>
                    )}
                </div>

                {/* Summary */}
                <div className={cardVariants({ density: 'compact' })} id="shared-pack-summary">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-default text-center">
                        {Object.entries(grouped).map(([type, typeItems]) => (
                            <div key={type} className="p-3">
                                <div><AppIcon name={ENTITY_ICON[type] || 'overview'} size={20} /></div>
                                <div className="text-lg font-bold">{typeItems.length}</div>
                                <div className="text-xs text-slate-400">{t(`entityType.${type}`)}</div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Items */}
                {Object.entries(grouped).map(([type, typeItems]) => (
                    <div key={type} className="space-y-tight">
                        <Heading level={3} className="text-slate-300 flex items-center gap-tight">
                            <AppIcon name={ENTITY_ICON[type] || 'overview'} size={16} />
                            <span>{t(`entityType.${type}`)}</span>
                            <span className="text-slate-500">({typeItems.length})</span>
                        </Heading>
                        <div className={cn(cardVariants({ density: 'none' }), 'divide-y divide-slate-700/50')}>
                            {typeItems.map((item) => {
                                let snap: PackSnapshot = {};
                                try { snap = JSON.parse(item.snapshotJson || '{}'); } catch { /* */ }
                                const name = snap.code || snap.title || snap.name || item.entityId;
                                return (
                                    <div key={item.id} className="p-3 text-sm">
                                        <div className="flex items-center justify-between">
                                            <span className="font-medium">{name}</span>
                                            {snap.status && <StatusBadge variant="neutral">{snap.status}</StatusBadge>}
                                        </div>
                                        {snap.description && <p className="text-xs text-slate-500 mt-1">{snap.description}</p>}
                                        <div className="flex gap-default mt-1 text-xs text-slate-500">
                                            {snap.taskCompletion && <span>{t('tasksLabel', { done: snap.taskCompletion.done, total: snap.taskCompletion.total })}</span>}
                                            {snap.evidenceCount !== undefined && <span>{t('evidenceLabel', { count: snap.evidenceCount })}</span>}
                                            {snap.mappedRequirements && snap.mappedRequirements.length > 0 && (
                                                <span>{t('requirementsLabel', { codes: snap.mappedRequirements.map((r) => r.code).join(', ') })}</span>
                                            )}
                                            {snap.severity && <span>{t('severityLabel', { severity: snap.severity })}</span>}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}

                {/* Return channel — auditor → tenant */}
                <div className={cardVariants({ density: 'compact' })} id="return-channel">
                    <Heading level={3} className="mb-1">{t('returnChannel.title')}</Heading>
                    <p className="text-xs text-slate-400 mb-4">{t('returnChannel.subtitle')}</p>

                    {/* Kind selector — segmented buttons (no native select) */}
                    <div className="mb-3">
                        <span className="block text-xs text-slate-400 mb-1">{t('returnChannel.kindLabel')}</span>
                        <div className="flex flex-wrap gap-tight" role="group" aria-label={t('returnChannel.kindLabel')}>
                            {KINDS.map((k) => (
                                <button
                                    key={k}
                                    type="button"
                                    onClick={() => setKind(k)}
                                    aria-pressed={kind === k}
                                    className={cn(
                                        'px-3 py-1.5 rounded-md text-sm border transition',
                                        kind === k
                                            ? 'bg-slate-700 border-slate-500 text-white'
                                            : 'bg-slate-800/50 border-slate-700 text-slate-300 hover:bg-slate-700/50',
                                    )}
                                >
                                    {t(`returnChannel.kind.${k}`)}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="mb-3">
                        <span className="block text-xs text-slate-400 mb-1">{t('returnChannel.nameLabel')}</span>
                        <input
                            type="text"
                            value={authorLabel}
                            onChange={(e) => setAuthorLabel(e.target.value)}
                            placeholder={t('returnChannel.namePlaceholder')}
                            aria-label={t('returnChannel.nameLabel')}
                            maxLength={200}
                            className="w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-slate-500"
                        />
                    </div>

                    {items.length > 0 && (
                        <div className="mb-3">
                            <span className="block text-xs text-slate-400 mb-1">{t('returnChannel.attachLabel')}</span>
                            <div className="flex flex-wrap gap-tight">
                                <button
                                    type="button"
                                    onClick={() => setAttachItemId('')}
                                    aria-pressed={attachItemId === ''}
                                    className={cn(
                                        'px-2.5 py-1 rounded-md text-xs border transition',
                                        attachItemId === '' ? 'bg-slate-700 border-slate-500 text-white' : 'bg-slate-800/50 border-slate-700 text-slate-300 hover:bg-slate-700/50',
                                    )}
                                >
                                    {t('returnChannel.attachWholePack')}
                                </button>
                                {items.map((item) => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        onClick={() => setAttachItemId(item.id)}
                                        aria-pressed={attachItemId === item.id}
                                        className={cn(
                                            'px-2.5 py-1 rounded-md text-xs border transition max-w-[16rem] truncate',
                                            attachItemId === item.id ? 'bg-slate-700 border-slate-500 text-white' : 'bg-slate-800/50 border-slate-700 text-slate-300 hover:bg-slate-700/50',
                                        )}
                                    >
                                        {itemDisplayName(item)}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="mb-3">
                        <span className="block text-xs text-slate-400 mb-1">{t('returnChannel.messageLabel')}</span>
                        <textarea
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            placeholder={t('returnChannel.messagePlaceholder')}
                            aria-label={t('returnChannel.messageLabel')}
                            rows={4}
                            maxLength={10000}
                            className="w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-slate-500"
                        />
                    </div>

                    {submitError && <p className="text-xs text-content-error mb-2" id="return-channel-error">{submitError}</p>}

                    <Button
                        variant="primary"
                        onClick={submitFeedback}
                        disabled={!message.trim() || submitting}
                        loading={submitting}
                        id="return-channel-submit"
                    >
                        {submitting ? t('returnChannel.submitting') : t('returnChannel.submit')}
                    </Button>

                    {/* Session-local echo of what the auditor submitted */}
                    <div className="mt-5 border-t border-slate-700/50 pt-4">
                        <span className="block text-xs uppercase tracking-wide text-slate-500 mb-2">{t('returnChannel.submittedTitle')}</span>
                        {submissions.length === 0 ? (
                            <p className="text-xs text-slate-500">{t('returnChannel.submittedEmpty')}</p>
                        ) : (
                            <ul className="space-y-tight">
                                {submissions.map((s) => (
                                    <li key={s.id} className="text-sm bg-slate-800/40 rounded-md px-3 py-2">
                                        <div className="flex items-center gap-tight mb-0.5">
                                            <StatusBadge variant="info">{t(`returnChannel.kind.${s.kind}`)}</StatusBadge>
                                            {s.itemName && <span className="text-xs text-slate-500 truncate">{s.itemName}</span>}
                                        </div>
                                        <p className="text-slate-300 whitespace-pre-wrap break-words">{s.body}</p>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>

                <div className="text-center py-8 text-xs text-slate-600">
                    {t('footer')}
                </div>
            </div>
        </div>
    );
}
