'use client';

/**
 * Review one workspace skill (#3680, step 4c): its versions, newest first, and
 * the act each one is open to.
 *
 *   DRAFT      attach the evaluation record, then submit it for review
 *   IN_REVIEW  approve (never by its author: the server refuses, and the button
 *              is not offered), or reject
 *   APPROVED   revoke the approval, which retires it
 *
 * The sheet shows the text a reviewer approves — each version's instructions,
 * as plain text — except a version the skill text scan refuses, which the
 * server returns with rule ids and no text. Approve sends back the content hash
 * on screen, so the approval is of the text the reviewer read: a version whose
 * hash is not the one sent is refused.
 *
 * Nothing here decides. Every act is a POST whose refusal arrives as the
 * server's sentence, shown inline.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ErrorState } from '@/components/ui/error-state';
import { FormField } from '@/components/ui/form-field';
import { useToast } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Sheet } from '@/components/ui/sheet';
import { SkeletonCard } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { Heading } from '@/components/ui/typography';
import { apiErrorMessage } from '@/lib/api-error';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

import type { TenantSkillDraftFields } from './TenantSkillEditorModal';

type Status = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'RETIRED';

interface Person {
    userId: string;
    label: string | null;
}

interface Rates {
    task: number;
    refusal: number;
    injection: number;
    'missing-input': number;
}

export interface TenantSkillVersionRow {
    id: string;
    version: number;
    status: Status;
    retiredReason: 'REJECTED' | 'SUPERSEDED' | 'WITHDRAWN' | null;
    contentHash: string;
    workflowKeys: string[];
    license: string;
    sourceRef: string;
    requiredInput: string | null;
    output: string | null;
    controls: string | null;
    tools: string | null;
    description: string | null;
    instructions: string | null;
    textRefused: { rules: string[]; guardRules: string[] } | null;
    author: Person & { isViewer: boolean };
    evaluation:
        | null
        | {
            attachedAt: string;
            attachedBy: Person;
            check:
                | { rates: Rates; model: { provider: string; revision: string }; ranAt: string; caseCount: number }
                | { ok: false; reason: string; detail: string };
        };
    approvedBy: Person | null;
    canApprove: boolean;
    mount: { ok: true } | { ok: false; reason: string } | null;
}

export interface TenantSkillDetailPayload {
    id: string;
    name: string;
    versions: TenantSkillVersionRow[];
}

type Act = 'evaluation' | 'submit' | 'approve' | 'reject' | 'retire';

const STATUS_VARIANT: Record<Status, 'neutral' | 'info' | 'success' | 'warning'> = {
    DRAFT: 'neutral',
    IN_REVIEW: 'info',
    APPROVED: 'success',
    RETIRED: 'warning',
};

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** The fields an edit of this skill starts from: its newest version that still carries text. */
export function editableFields(versions: readonly TenantSkillVersionRow[]): TenantSkillDraftFields | undefined {
    const v = versions.find((x) => x.instructions !== null && x.description !== null);
    if (!v || v.instructions === null || v.description === null) return undefined;
    return {
        description: v.description,
        instructions: v.instructions,
        license: v.license,
        sourceRef: v.sourceRef,
        workflowKeys: [...v.workflowKeys],
        requiredInput: v.requiredInput,
        controls: v.controls,
        tools: v.tools,
    };
}

export function TenantSkillSheet({
    skillId,
    canAuthor = true,
    canReview = true,
    onClose,
    onChanged,
    onEdit,
}: {
    skillId: string;
    /**
     * The two halves (#3778): editing, attaching a record and submitting take
     * `admin.agent_skill_author`; rejecting and retiring take
     * `admin.agent_skill_review`, and approving is offered by the server's
     * `canApprove`, which already requires it. True by default so a caller
     * that predates the split renders what it did.
     */
    canAuthor?: boolean;
    canReview?: boolean;
    onClose: () => void;
    onChanged: () => void;
    onEdit: (skill: { skillId: string; name: string; from?: TenantSkillDraftFields }) => void;
}) {
    const t = useTranslations('agents');
    const tCommon = useTranslations('common');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();
    const { data, error, isLoading, mutate } = useTenantSWR<TenantSkillDetailPayload>(`/admin/agents/skills/tenant/${skillId}`);

    const [busy, setBusy] = useState(false);
    const [actError, setActError] = useState<string | null>(null);
    const [recordText, setRecordText] = useState('');
    const [confirming, setConfirming] = useState<{ act: 'reject' | 'retire'; version: TenantSkillVersionRow } | null>(null);

    const act = async (a: Act, v: TenantSkillVersionRow, body?: unknown): Promise<boolean> => {
        setBusy(true);
        setActError(null);
        try {
            const res = await fetch(apiUrl(`/admin/agents/skills/tenant/${skillId}/versions/${v.id}/${a}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body ?? {}),
            });
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                const message = apiErrorMessage(payload, t('skills.sheet.actionFailed'));
                setActError(message);
                toast.error(message);
                return false;
            }
            toast.success(t('skills.sheet.actionDone'));
            await mutate();
            onChanged();
            return true;
        } catch {
            setActError(t('skills.sheet.actionFailed'));
            toast.error(t('skills.sheet.actionFailed'));
            return false;
        } finally {
            setBusy(false);
        }
    };

    const attach = async (v: TenantSkillVersionRow) => {
        let record: unknown;
        try {
            record = JSON.parse(recordText);
        } catch {
            setActError(t('skills.sheet.recordInvalidJson'));
            return;
        }
        if (await act('evaluation', v, { record })) setRecordText('');
    };

    const who = (p: Person & { isViewer?: boolean }) => (p.isViewer ? t('skills.sheet.you') : p.label ?? t('skills.sheet.unknownMember'));

    return (
        <Sheet open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title={data?.name ?? ''}>
            <Sheet.Header>
                <Sheet.Title>{data?.name ?? ''}</Sheet.Title>
                <Sheet.Description>{t('skills.sheet.description')}</Sheet.Description>
            </Sheet.Header>
            <Sheet.Body>
                <div className="space-y-section" data-testid="tenant-skill-sheet">
                    {isLoading || (!data && !error) ? <SkeletonCard /> : null}
                    {error ? <ErrorState title={t('skills.sheet.loadFailed')} onRetry={() => { void mutate(); }} /> : null}
                    {actError ? (
                        <InlineNotice variant="error" data-testid="tenant-skill-act-error">{actError}</InlineNotice>
                    ) : null}
                    {data ? (
                        <>
                            {canAuthor ? (
                                <div className="flex justify-end">
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        disabled={busy}
                                        data-testid="tenant-skill-edit"
                                        onClick={() => onEdit({ skillId: data.id, name: data.name, from: editableFields(data.versions) })}
                                    >
                                        {t('skills.sheet.edit')}
                                    </Button>
                                </div>
                            ) : null}
                            {data.versions.map((v) => (
                                <section
                                    key={v.id}
                                    className="space-y-default border-b border-border-subtle pb-4"
                                    data-testid={`tenant-skill-version-${v.version}`}
                                >
                                    <div className="flex flex-wrap items-center justify-between gap-compact">
                                        <Heading level={3} className="text-sm">{t('skills.sheet.version', { version: v.version })}</Heading>
                                        <StatusBadge variant={STATUS_VARIANT[v.status]}>
                                            {v.status === 'RETIRED' && v.retiredReason
                                                ? t(`skills.sheet.retiredReason.${v.retiredReason}`)
                                                : t(`skills.sheet.status.${v.status}`)}
                                        </StatusBadge>
                                    </div>
                                    <dl className="text-content-muted grid grid-cols-2 gap-x-default gap-y-tight text-xs">
                                        <dt>{t('skills.sheet.hash')}</dt>
                                        <dd><code className="break-all">{v.contentHash}</code></dd>
                                        <dt>{t('skills.sheet.author')}</dt>
                                        <dd>{who(v.author)}</dd>
                                        {v.approvedBy ? (<><dt>{t('skills.sheet.approvedBy')}</dt><dd>{who(v.approvedBy)}</dd></>) : null}
                                        <dt>{t('skills.sheet.licence')}</dt>
                                        <dd>{v.license}</dd>
                                        <dt>{t('skills.sheet.source')}</dt>
                                        <dd>{v.sourceRef}</dd>
                                        <dt>{t('skills.sheet.mountsOn')}</dt>
                                        <dd>{v.workflowKeys.join(', ')}</dd>
                                    </dl>

                                    {v.textRefused ? (
                                        <InlineNotice variant="error" data-testid={`tenant-skill-version-${v.version}-refused`}>
                                            {t('skills.sheet.textRefused', { rules: [...v.textRefused.rules, ...v.textRefused.guardRules].join(', ') })}
                                        </InlineNotice>
                                    ) : (
                                        <div className="space-y-tight">
                                            <p className="text-content-default text-sm">{v.description}</p>
                                            <p className="text-content-muted text-xs">{t('skills.sheet.instructions')}</p>
                                            <pre
                                                className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border-subtle p-2 text-xs text-content-default"
                                                data-testid={`tenant-skill-version-${v.version}-instructions`}
                                            >
                                                {v.instructions}
                                            </pre>
                                        </div>
                                    )}

                                    <div className="space-y-tight text-xs">
                                        <p className="text-content-muted">{t('skills.sheet.evaluation')}</p>
                                        {v.evaluation === null ? (
                                            <p className="text-content-muted">{t('skills.sheet.evaluationNone')}</p>
                                        ) : 'rates' in v.evaluation.check ? (
                                            <p className="text-content-default" data-testid={`tenant-skill-version-${v.version}-evaluation`}>
                                                {t('skills.sheet.evaluationPasses', {
                                                    cases: v.evaluation.check.caseCount,
                                                    provider: v.evaluation.check.model.provider,
                                                    revision: v.evaluation.check.model.revision,
                                                    ranAt: formatDateTime(v.evaluation.check.ranAt),
                                                    who: who(v.evaluation.attachedBy),
                                                    task: pct(v.evaluation.check.rates.task),
                                                    refusal: pct(v.evaluation.check.rates.refusal),
                                                    injection: pct(v.evaluation.check.rates.injection),
                                                    missingInput: pct(v.evaluation.check.rates['missing-input']),
                                                })}
                                            </p>
                                        ) : (
                                            <p className="text-content-error">{t('skills.sheet.evaluationFails', { reason: v.evaluation.check.reason })}</p>
                                        )}
                                    </div>

                                    {v.mount ? (
                                        <p className="text-content-muted text-xs">
                                            {v.mount.ok ? t('skills.sheet.mountOk') : t('skills.sheet.mountRefused', { reason: v.mount.reason })}
                                        </p>
                                    ) : null}

                                    {canAuthor && v.status === 'DRAFT' && v.evaluation === null && !v.textRefused ? (
                                        <FormField label={t('skills.sheet.recordLabel')} description={t('skills.sheet.recordHint', { hash: v.contentHash })}>
                                            <Textarea
                                                id={`tenant-skill-record-${v.version}`}
                                                rows={6}
                                                value={recordText}
                                                onChange={(e) => setRecordText(e.target.value)}
                                                disabled={busy}
                                            />
                                        </FormField>
                                    ) : null}

                                    <div className="flex flex-wrap justify-end gap-tight">
                                        {canAuthor && v.status === 'DRAFT' && v.evaluation === null && !v.textRefused ? (
                                            <Button
                                                size="sm"
                                                variant="secondary"
                                                disabled={busy || recordText.trim() === ''}
                                                data-testid={`tenant-skill-attach-${v.version}`}
                                                onClick={() => { void attach(v); }}
                                            >
                                                {t('skills.sheet.attach')}
                                            </Button>
                                        ) : null}
                                        {canAuthor && v.status === 'DRAFT' && v.evaluation !== null ? (
                                            <Button
                                                size="sm"
                                                variant="secondary"
                                                disabled={busy}
                                                data-testid={`tenant-skill-submit-${v.version}`}
                                                onClick={() => { void act('submit', v); }}
                                            >
                                                {t('skills.sheet.submit')}
                                            </Button>
                                        ) : null}
                                        {v.status === 'IN_REVIEW' && v.canApprove ? (
                                            // Secondary, as the parameter-sets page's four-eyes
                                            // approve is: the product-wide primary ceiling has
                                            // no slot, and what makes this act weighty is the
                                            // hash it sends and the person it refuses, not
                                            // its colour.
                                            <Button
                                                size="sm"
                                                variant="secondary"
                                                disabled={busy}
                                                data-testid={`tenant-skill-approve-${v.version}`}
                                                onClick={() => { void act('approve', v, { contentHash: v.contentHash }); }}
                                            >
                                                {t('skills.sheet.approve')}
                                            </Button>
                                        ) : null}
                                        {v.status === 'IN_REVIEW' && !v.canApprove && v.author.isViewer ? (
                                            <p className="text-content-muted text-xs" data-testid={`tenant-skill-author-note-${v.version}`}>
                                                {t('skills.sheet.authorCannotApprove')}
                                            </p>
                                        ) : null}
                                        {canReview && v.status === 'IN_REVIEW' ? (
                                            <Button
                                                size="sm"
                                                variant="secondary"
                                                disabled={busy}
                                                data-testid={`tenant-skill-reject-${v.version}`}
                                                onClick={() => setConfirming({ act: 'reject', version: v })}
                                            >
                                                {t('skills.sheet.reject')}
                                            </Button>
                                        ) : null}
                                        {canReview && v.status !== 'RETIRED' ? (
                                            <Button
                                                size="sm"
                                                variant="secondary"
                                                disabled={busy}
                                                data-testid={`tenant-skill-retire-${v.version}`}
                                                onClick={() => setConfirming({ act: 'retire', version: v })}
                                            >
                                                {t('skills.sheet.retire')}
                                            </Button>
                                        ) : null}
                                    </div>
                                </section>
                            ))}
                        </>
                    ) : null}
                </div>
            </Sheet.Body>
            <ConfirmDialog
                showModal={confirming !== null && confirming.act === 'reject'}
                setShowModal={(open) => {
                    const next = typeof open === 'function' ? open(confirming !== null) : open;
                    if (!next) setConfirming(null);
                }}
                tone="danger"
                confirmLabel={t('skills.sheet.rejectConfirm')}
                cancelLabel={tCommon('cancel')}
                title={t('skills.sheet.rejectTitle', { version: confirming?.version.version ?? '' })}
                description={t('skills.sheet.rejectBody')}
                onConfirm={async () => {
                    if (confirming) await act('reject', confirming.version);
                    setConfirming(null);
                }}
            />
            {/* Two dialogs rather than one with a computed label: retiring the
                version IN SERVICE revokes the approval that lets it mount, and
                retiring a draft or one in review discards it. The verb is the
                reader's last clue to which of the two they are doing. */}
            <ConfirmDialog
                showModal={confirming !== null && confirming.act === 'retire' && confirming.version.status === 'APPROVED'}
                setShowModal={(open) => {
                    const next = typeof open === 'function' ? open(confirming !== null) : open;
                    if (!next) setConfirming(null);
                }}
                tone="danger"
                confirmLabel={t('skills.sheet.retireConfirmApproved')}
                cancelLabel={tCommon('cancel')}
                title={t('skills.sheet.retireTitle', { version: confirming?.version.version ?? '' })}
                description={t('skills.sheet.retireBodyApproved')}
                onConfirm={async () => {
                    if (confirming) await act('retire', confirming.version);
                    setConfirming(null);
                }}
            />
            <ConfirmDialog
                showModal={confirming !== null && confirming.act === 'retire' && confirming.version.status !== 'APPROVED'}
                setShowModal={(open) => {
                    const next = typeof open === 'function' ? open(confirming !== null) : open;
                    if (!next) setConfirming(null);
                }}
                tone="danger"
                confirmLabel={t('skills.sheet.retireConfirmOpen')}
                cancelLabel={tCommon('cancel')}
                title={t('skills.sheet.retireTitle', { version: confirming?.version.version ?? '' })}
                description={t('skills.sheet.retireBodyOpen')}
                onConfirm={async () => {
                    if (confirming) await act('retire', confirming.version);
                    setConfirming(null);
                }}
            />
        </Sheet>
    );
}
