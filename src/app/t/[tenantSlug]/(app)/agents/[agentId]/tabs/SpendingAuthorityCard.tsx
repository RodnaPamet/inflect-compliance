'use client';

/**
 * WHAT THIS AGENT MAY SPEND (Agent Pay Phase 1, #5333) — the register page's
 * section for `/admin/agents/:agentId/spending-authority`.
 *
 * An agent that can pay holds the most consequential privilege an agent can
 * hold, so its envelope — rail, limits, merchant scope, expiry, the member who
 * consented and the platform that holds the token — is DECLARED on the
 * register, REVIEWED by a second person, NARROWED or WITHDRAWN by one. It is a
 * declaration to review, never a grant Inflect enforces at payment time, and
 * never a payment credential (D-L1-8): the writer refuses a card number in
 * every free-text field.
 *
 * THE PAGE OFFERS A WRITE ONLY WHERE THE SERVER TAKES IT. Every act is the
 * server's own answer for THIS viewer (`getAgentSpendingAuthorityState`:
 * `viewerMayDeclare`, and per envelope `viewerMayReview`, `viewerMayNarrow`,
 * `viewerMayWithdraw`), ANDed with `canManageRegistry`, the page's edge-aware
 * answer for the register key. The card computes neither: the four-eyes rule
 * in particular is the server's, and when it withholds a review the card says
 * why (`reviewWithheld`) rather than hiding the button silently.
 *
 * Amounts are entered and shown in the currency's major unit and sent in its
 * minor unit, the row's own. An unchanged expiry is sent back exactly as
 * stored, so a narrowing that does not touch it is not read as a later expiry.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import { parseYMD, toYMD } from '@/components/ui/date-picker/date-utils';
import { FormField } from '@/components/ui/form-field';
import { useToast } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { SkeletonCard } from '@/components/ui/skeleton';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { formatDate, formatDateTime } from '@inflect/ui/lib/format-date';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import {
    SPENDING_BUDGET_PERIODS,
    SPENDING_RAILS,
    type SpendingRail,
} from '@/lib/agentic/spending-authority';

import type { AgentTabProps } from './types';

type Status = 'DECLARED' | 'REVIEWED' | 'SUSPENDED_REQUESTED' | 'WITHDRAWN';
type ReviewWithheld =
    | 'NOT_PERMITTED'
    | 'AGENT_RETIRED'
    | 'NOT_DECLARED'
    | 'REVIEWER_NOT_A_PERSON'
    | 'REVIEWER_IS_DECLARER'
    | 'REVIEWER_IS_OWNER';

/** `SpendingAuthorityStateRow`, as it arrives over JSON. */
interface Envelope {
    rail: SpendingRail;
    status: Status;
    perTransactionLimitMinor: string;
    periodBudgetMinor: string;
    budgetPeriod: string;
    currency: string;
    merchantDomains: string[];
    merchantCategoryCodes: string[];
    merchantScopeUnrestricted: boolean;
    expiresAt: string;
    consentedByUserId: string;
    tokenRequestor: string;
    tokenReference: string;
    declaredByUserId: string;
    declaredAt: string;
    reviewedByUserId: string | null;
    reviewedAt: string | null;
    suspensionRequestedAt: string | null;
    withdrawnAt: string | null;
    unreviewed: boolean;
    viewerMayReview: boolean;
    reviewWithheld: ReviewWithheld | null;
    viewerMayNarrow: boolean;
    viewerMayWithdraw: boolean;
}

interface SpendingState {
    agentId: string;
    agentStatus: string;
    envelopes: Envelope[];
    viewerMayDeclare: boolean;
}

/** A member the consenter can be: the ACTIVE members the page already holds. */
export interface PersonChoice {
    id: string;
    label: string;
}

const STATUS_VARIANT: Record<Status, StatusBadgeVariant> = {
    DECLARED: 'warning',
    REVIEWED: 'success',
    SUSPENDED_REQUESTED: 'error',
    WITHDRAWN: 'neutral',
};

/** The currency's minor-unit digits (2 for EUR, 0 for JPY); 2 when the runtime does not know it. */
function minorDigits(currency: string): number {
    try {
        return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
        return 2;
    }
}

/** A major-unit amount typed by a person, in minor units; null when it is not an amount. */
function toMinor(major: string, currency: string): number | null {
    const digits = minorDigits(currency);
    const m = /^(\d+)(?:\.(\d+))?$/.exec(major.trim());
    if (!m || (m[2] ?? '').length > digits) return null;
    const minor = Number(m[1]) * 10 ** digits + Number((m[2] ?? '').padEnd(digits, '0') || '0');
    return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

/** A stored minor-unit amount, as the major-unit text the form shows. */
function toMajorText(minor: string, currency: string): string {
    const digits = minorDigits(currency);
    if (digits === 0) return minor;
    const padded = minor.padStart(digits + 1, '0');
    const whole = padded.slice(0, -digits);
    const frac = padded.slice(-digits).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
}

function formatAmount(minor: string, currency: string, locale: string): string {
    try {
        return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(
            Number(minor) / 10 ** minorDigits(currency),
        );
    } catch {
        return `${currency} ${toMajorText(minor, currency)}`;
    }
}

const splitList = (s: string): string[] =>
    s.split(/[\s,]+/).map((x) => x.trim()).filter((x) => x.length > 0);

interface Draft {
    rail: SpendingRail;
    perTransaction: string;
    periodBudget: string;
    budgetPeriod: string;
    currency: string;
    merchantDomains: string;
    merchantCategoryCodes: string;
    /** The ISO instant sent: the stored one until the date is changed. */
    expiresAt: string;
    consentedByUserId: string;
    tokenRequestor: string;
    tokenReference: string;
}

function draftOf(e: Envelope): Draft {
    return {
        rail: e.rail,
        perTransaction: toMajorText(e.perTransactionLimitMinor, e.currency),
        periodBudget: toMajorText(e.periodBudgetMinor, e.currency),
        budgetPeriod: e.budgetPeriod,
        currency: e.currency,
        merchantDomains: e.merchantDomains.join(', '),
        merchantCategoryCodes: e.merchantCategoryCodes.join(', '),
        expiresAt: e.expiresAt,
        consentedByUserId: e.consentedByUserId,
        tokenRequestor: e.tokenRequestor,
        tokenReference: e.tokenReference,
    };
}

function blankDraft(rail: SpendingRail): Draft {
    return {
        rail,
        perTransaction: '',
        periodBudget: '',
        budgetPeriod: 'MONTH',
        currency: 'EUR',
        merchantDomains: '',
        merchantCategoryCodes: '',
        expiresAt: '',
        consentedByUserId: '',
        tokenRequestor: '',
        tokenReference: '',
    };
}

type FormMode = { kind: 'declare'; draft: Draft; replaces: boolean } | { kind: 'narrow'; draft: Draft };

export function SpendingAuthorityCard({
    agentId,
    refreshToken,
    onChanged,
    canManageRegistry,
    people,
}: AgentTabProps & {
    /** The page's edge-aware answer for the register key (`agentRegisterAffordances`). */
    canManageRegistry: boolean;
    /** ACTIVE members: the consenters the writer accepts, and how ids are named. */
    people: PersonChoice[];
}) {
    const t = useTranslations('admin');
    const locale = useLocale();
    const apiUrl = useTenantApiUrl();
    const toast = useToast();
    const base = `/admin/agents/${agentId}/spending-authority`;
    const { data, error, isLoading, mutate } = useTenantSWR<SpendingState>(base);
    useEffect(() => {
        void mutate();
    }, [refreshToken, mutate]);

    const [form, setForm] = useState<FormMode | null>(null);
    const [reviewing, setReviewing] = useState<Envelope | null>(null);
    const [withdrawing, setWithdrawing] = useState<Envelope | null>(null);
    const [actError, setActError] = useState<string | null>(null);

    const nameOf = (userId: string | null) =>
        userId === null ? '—' : (people.find((p) => p.id === userId)?.label ?? userId);

    if (isLoading && !data) return <SkeletonCard lines={4} />;

    /** One request; null on success, else the sentence to show. */
    const send = async (path: string, method: string, body?: unknown): Promise<string | null> => {
        try {
            const res = await fetch(apiUrl(path), {
                method,
                headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            if (res.ok) return null;
            const payload = await res.json().catch(() => null);
            return apiErrorMessage(payload, t('agentDetail.spending.failed'));
        } catch {
            return t('agentDetail.spending.failed');
        }
    };

    const done = async (message: string) => {
        toast.success(message);
        await mutate();
        onChanged?.();
    };

    const review = async () => {
        if (!reviewing) return;
        setActError(null);
        const failure = await send(`${base}/${reviewing.rail}/review`, 'POST', { declaredAt: reviewing.declaredAt });
        if (failure !== null) {
            setActError(failure);
            // Keeps the dialog open over the server's sentence.
            throw new Error(failure);
        }
        setReviewing(null);
        await done(t('agentDetail.spending.reviewed'));
    };

    const withdraw = async () => {
        if (!withdrawing) return;
        setActError(null);
        const failure = await send(`${base}/${withdrawing.rail}`, 'DELETE');
        if (failure !== null) {
            setActError(failure);
            throw new Error(failure);
        }
        setWithdrawing(null);
        await done(t('agentDetail.spending.withdrawn'));
    };

    const envelopes = data?.envelopes ?? [];
    const liveRails = new Set(envelopes.filter((e) => e.status !== 'WITHDRAWN').map((e) => e.rail));
    const freeRail = SPENDING_RAILS.find((r) => !liveRails.has(r)) ?? null;
    const mayDeclare = canManageRegistry && data?.viewerMayDeclare === true;

    return (
        <Card as="section" className="space-y-default" data-testid="agent-spending-authority">
            <div className="flex flex-wrap items-center justify-between gap-tight">
                <Heading level={2}>{t('agentDetail.spending.heading')}</Heading>
                {mayDeclare && freeRail !== null && (
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        id="agent-spending-declare-btn"
                        onClick={() => setForm({ kind: 'declare', draft: blankDraft(freeRail), replaces: false })}
                    >
                        {t('agentDetail.spending.declare')}
                    </Button>
                )}
            </div>
            <p className="text-sm text-content-muted">{t('agentDetail.spending.intro')}</p>

            {error && !data ? (
                <InlineNotice variant="error">{t('agentDetail.spending.loadError')}</InlineNotice>
            ) : envelopes.length === 0 ? (
                <InlineNotice variant="info" icon={null} data-testid="agent-spending-none">
                    {t('agentDetail.spending.none')}
                </InlineNotice>
            ) : (
                <ul className="space-y-default">
                    {envelopes.map((e) => (
                        <li
                            key={e.rail}
                            className="space-y-compact rounded-lg border border-border-subtle p-4"
                            data-testid={`agent-spending-${e.rail}`}
                        >
                            <div className="flex flex-wrap items-center gap-compact">
                                <span className="font-medium text-content-emphasis">
                                    {t(`agentDetail.spending.rail.${e.rail}`)}
                                </span>
                                <StatusBadge variant={STATUS_VARIANT[e.status]} size="sm">
                                    {t(`agentDetail.spending.status.${e.status}`)}
                                </StatusBadge>
                            </div>

                            <dl className="grid gap-compact text-sm sm:grid-cols-2">
                                <Fact label={t('agentDetail.spending.perTransaction')}>
                                    {formatAmount(e.perTransactionLimitMinor, e.currency, locale)}
                                </Fact>
                                <Fact label={t('agentDetail.spending.periodBudget')}>
                                    {t('agentDetail.spending.perPeriod', {
                                        amount: formatAmount(e.periodBudgetMinor, e.currency, locale),
                                        period: t(`agentDetail.spending.period.${e.budgetPeriod}`),
                                    })}
                                </Fact>
                                <Fact label={t('agentDetail.spending.merchants')}>
                                    {e.merchantScopeUnrestricted
                                        ? t('agentDetail.spending.anyMerchant')
                                        : [...e.merchantDomains, ...e.merchantCategoryCodes.map((c) =>
                                            t('agentDetail.spending.mcc', { code: c }))].join(', ')}
                                </Fact>
                                <Fact label={t('agentDetail.spending.expires')}>
                                    {formatDate(e.expiresAt)}
                                    {new Date(e.expiresAt).getTime() < Date.now()
                                        ? ` · ${t('agentDetail.spending.expired')}`
                                        : ''}
                                </Fact>
                                <Fact label={t('agentDetail.spending.consentedBy')}>{nameOf(e.consentedByUserId)}</Fact>
                                <Fact label={t('agentDetail.spending.tokenRequestor')}>{e.tokenRequestor}</Fact>
                                <Fact label={t('agentDetail.spending.tokenReference')}>
                                    <span className="font-mono">{e.tokenReference}</span>
                                </Fact>
                                <Fact label={t('agentDetail.spending.declared')}>
                                    {t('agentDetail.spending.byOn', {
                                        who: nameOf(e.declaredByUserId),
                                        at: formatDateTime(e.declaredAt),
                                    })}
                                </Fact>
                                <Fact label={t('agentDetail.spending.reviewedLabel')}>
                                    {e.reviewedAt
                                        ? t('agentDetail.spending.byOn', {
                                              who: nameOf(e.reviewedByUserId),
                                              at: formatDateTime(e.reviewedAt),
                                          })
                                        : t('agentDetail.spending.notReviewed')}
                                </Fact>
                            </dl>

                            {e.unreviewed && (
                                <InlineNotice variant="warning" data-testid={`agent-spending-unreviewed-${e.rail}`}>
                                    {t('agentDetail.spending.unreviewedNotice')}
                                </InlineNotice>
                            )}
                            {e.status === 'SUSPENDED_REQUESTED' && (
                                <InlineNotice variant="error">
                                    {t('agentDetail.spending.suspendedNotice', {
                                        requestor: e.tokenRequestor,
                                        at: formatDateTime(e.suspensionRequestedAt ?? e.declaredAt),
                                    })}
                                </InlineNotice>
                            )}
                            {e.status === 'DECLARED' && canManageRegistry && e.reviewWithheld !== null &&
                                e.reviewWithheld !== 'NOT_PERMITTED' && e.reviewWithheld !== 'NOT_DECLARED' && (
                                <p className="text-xs text-content-muted" data-testid={`agent-spending-review-withheld-${e.rail}`}>
                                    {t(`agentDetail.spending.reviewWithheld.${e.reviewWithheld}`)}
                                </p>
                            )}

                            {canManageRegistry && (
                                <div className="flex flex-wrap items-center gap-tight">
                                    {e.viewerMayReview && (
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            size="sm"
                                            data-testid={`agent-spending-review-${e.rail}`}
                                            onClick={() => {
                                                setActError(null);
                                                setReviewing(e);
                                            }}
                                        >
                                            {t('agentDetail.spending.review')}
                                        </Button>
                                    )}
                                    {e.viewerMayNarrow && (
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            size="sm"
                                            data-testid={`agent-spending-narrow-${e.rail}`}
                                            onClick={() => setForm({ kind: 'narrow', draft: draftOf(e) })}
                                        >
                                            {t('agentDetail.spending.narrow')}
                                        </Button>
                                    )}
                                    {data?.viewerMayDeclare && (
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            size="sm"
                                            data-testid={`agent-spending-redeclare-${e.rail}`}
                                            onClick={() =>
                                                setForm({ kind: 'declare', draft: draftOf(e), replaces: e.status !== 'WITHDRAWN' })}
                                        >
                                            {t('agentDetail.spending.redeclare')}
                                        </Button>
                                    )}
                                    {e.viewerMayWithdraw && (
                                        <Button
                                            type="button"
                                            variant="destructive"
                                            size="sm"
                                            data-testid={`agent-spending-withdraw-${e.rail}`}
                                            onClick={() => {
                                                setActError(null);
                                                setWithdrawing(e);
                                            }}
                                        >
                                            {t('agentDetail.spending.withdraw')}
                                        </Button>
                                    )}
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {form && (
                <SpendingEnvelopeModal
                    mode={form}
                    people={people}
                    takenRails={liveRails}
                    onClose={() => setForm(null)}
                    onSubmit={async (body) => {
                        const failure = form.kind === 'declare'
                            ? await send(base, 'POST', body)
                            : await send(`${base}/${form.draft.rail}`, 'PATCH', body);
                        if (failure !== null) return failure;
                        setForm(null);
                        await done(form.kind === 'declare'
                            ? t('agentDetail.spending.declaredToast')
                            : t('agentDetail.spending.narrowed'));
                        return null;
                    }}
                />
            )}

            <ConfirmDialog
                showModal={reviewing !== null}
                setShowModal={(open) => {
                    const next = typeof open === 'function' ? open(reviewing !== null) : open;
                    if (!next) setReviewing(null);
                }}
                tone="warning"
                title={t('agentDetail.spending.reviewTitle')}
                description={
                    <>
                        {t('agentDetail.spending.reviewBody')}
                        {actError && (
                            <span role="alert" className="mt-2 block text-content-error">
                                {actError}
                            </span>
                        )}
                    </>
                }
                confirmLabel={t('agentDetail.spending.reviewConfirm')}
                cancelLabel={t('agentDetail.spending.cancel')}
                onConfirm={review}
            />

            <ConfirmDialog
                showModal={withdrawing !== null}
                setShowModal={(open) => {
                    const next = typeof open === 'function' ? open(withdrawing !== null) : open;
                    if (!next) setWithdrawing(null);
                }}
                tone="danger"
                confirmLabel={t('agentDetail.spending.withdrawConfirm')}
                cancelLabel={t('agentDetail.spending.cancel')}
                title={t('agentDetail.spending.withdrawTitle')}
                description={
                    <>
                        {t('agentDetail.spending.withdrawBody', {
                            requestor: withdrawing?.tokenRequestor ?? '',
                        })}
                        {actError && (
                            <span role="alert" className="mt-2 block text-content-error">
                                {actError}
                            </span>
                        )}
                    </>
                }
                onConfirm={withdraw}
            />
        </Card>
    );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div>
            <dt className="text-xs text-content-muted">{label}</dt>
            <dd className="text-content-emphasis">{children}</dd>
        </div>
    );
}

/**
 * Declare (a new, wider or replacing envelope) or narrow one. The server
 * decides which a change is: a narrowing that widens anything is refused
 * `NOT_A_NARROWING` with the fields named, and that sentence is shown.
 */
function SpendingEnvelopeModal({
    mode,
    people,
    takenRails,
    onClose,
    onSubmit,
}: {
    mode: FormMode;
    people: PersonChoice[];
    takenRails: ReadonlySet<SpendingRail>;
    onClose: () => void;
    onSubmit: (body: unknown) => Promise<string | null>;
}) {
    const t = useTranslations('admin');
    const [draft, setDraft] = useState<Draft>(mode.draft);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

    const narrowing = mode.kind === 'narrow';
    const opt = (values: readonly string[], label: (v: string) => string) =>
        values.map((v) => ({ value: v, label: label(v) }));
    const railOptions = opt(SPENDING_RAILS, (v) => t(`agentDetail.spending.rail.${v}`));
    const periodOptions = opt(SPENDING_BUDGET_PERIODS, (v) => t(`agentDetail.spending.period.${v}`));
    const personOptions = people.map((p) => ({ value: p.id, label: p.label }));

    const perTransactionMinor = toMinor(draft.perTransaction, draft.currency);
    const periodBudgetMinor = toMinor(draft.periodBudget, draft.currency);
    const unrestricted = splitList(draft.merchantDomains).length === 0 && splitList(draft.merchantCategoryCodes).length === 0;
    const replacesLive = mode.kind === 'declare' && takenRails.has(draft.rail);
    const complete =
        perTransactionMinor !== null &&
        periodBudgetMinor !== null &&
        /^[A-Z]{3}$/.test(draft.currency) &&
        draft.expiresAt !== '' &&
        draft.consentedByUserId !== '' &&
        draft.tokenRequestor.trim() !== '' &&
        draft.tokenReference.trim() !== '';

    const body = useMemo(
        () => ({
            rail: draft.rail,
            perTransactionLimitMinor: perTransactionMinor,
            periodBudgetMinor,
            budgetPeriod: draft.budgetPeriod,
            currency: draft.currency,
            merchantDomains: splitList(draft.merchantDomains),
            merchantCategoryCodes: splitList(draft.merchantCategoryCodes),
            expiresAt: draft.expiresAt,
            consentedByUserId: draft.consentedByUserId,
            tokenRequestor: draft.tokenRequestor.trim(),
            tokenReference: draft.tokenReference.trim(),
        }),
        [draft, perTransactionMinor, periodBudgetMinor],
    );

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            const failure = await onSubmit(body);
            if (failure !== null) setError(failure);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal showModal setShowModal={(o) => (o ? null : onClose())} size="lg" preventDefaultClose={busy}>
            <Modal.Header
                title={narrowing ? t('agentDetail.spending.narrowTitle') : t('agentDetail.spending.declareTitle')}
                description={narrowing ? t('agentDetail.spending.narrowIntro') : t('agentDetail.spending.declareIntro')}
            />
            <Modal.Body>
                <div className="space-y-default" data-testid="agent-spending-form">
                    <FormField label={t('agentDetail.spending.railLabel')} required>
                        <Combobox
                            hideSearch
                            id="agent-spending-rail"
                            disabled={narrowing}
                            selected={railOptions.find((o) => o.value === draft.rail) ?? null}
                            setSelected={(o) => set('rail', (o?.value as SpendingRail | undefined) ?? draft.rail)}
                            options={railOptions}
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full' }}
                        />
                    </FormField>
                    {replacesLive && (
                        <InlineNotice variant="info" icon={null}>
                            {t('agentDetail.spending.replacesNotice')}
                        </InlineNotice>
                    )}

                    <div className="grid gap-default sm:grid-cols-2">
                        <FormField label={t('agentDetail.spending.currencyLabel')} required>
                            <Input
                                id="agent-spending-currency"
                                value={draft.currency}
                                maxLength={3}
                                onChange={(e) => set('currency', e.target.value.toUpperCase())}
                            />
                        </FormField>
                        <FormField label={t('agentDetail.spending.periodLabel')} required>
                            <Combobox
                                hideSearch
                                id="agent-spending-period"
                                selected={periodOptions.find((o) => o.value === draft.budgetPeriod) ?? null}
                                setSelected={(o) => set('budgetPeriod', o?.value ?? draft.budgetPeriod)}
                                options={periodOptions}
                                matchTriggerWidth
                                buttonProps={{ className: 'w-full' }}
                            />
                        </FormField>
                        <FormField
                            label={t('agentDetail.spending.perTransaction')}
                            required
                            error={draft.perTransaction !== '' && perTransactionMinor === null
                                ? t('agentDetail.spending.amountInvalid') : undefined}
                        >
                            <Input
                                id="agent-spending-per-transaction"
                                inputMode="decimal"
                                value={draft.perTransaction}
                                onChange={(e) => set('perTransaction', e.target.value)}
                            />
                        </FormField>
                        <FormField
                            label={t('agentDetail.spending.periodBudget')}
                            required
                            error={draft.periodBudget !== '' && periodBudgetMinor === null
                                ? t('agentDetail.spending.amountInvalid') : undefined}
                        >
                            <Input
                                id="agent-spending-period-budget"
                                inputMode="decimal"
                                value={draft.periodBudget}
                                onChange={(e) => set('periodBudget', e.target.value)}
                            />
                        </FormField>
                    </div>

                    <FormField
                        label={t('agentDetail.spending.domainsLabel')}
                        description={t('agentDetail.spending.domainsHint')}
                    >
                        <Input
                            id="agent-spending-domains"
                            value={draft.merchantDomains}
                            onChange={(e) => set('merchantDomains', e.target.value)}
                        />
                    </FormField>
                    <FormField
                        label={t('agentDetail.spending.mccLabel')}
                        description={t('agentDetail.spending.mccHint')}
                    >
                        <Input
                            id="agent-spending-mccs"
                            value={draft.merchantCategoryCodes}
                            onChange={(e) => set('merchantCategoryCodes', e.target.value)}
                        />
                    </FormField>
                    {unrestricted && (
                        <InlineNotice variant="warning" icon={null}>
                            {t('agentDetail.spending.unrestrictedNotice')}
                        </InlineNotice>
                    )}

                    <FormField label={t('agentDetail.spending.expires')} required>
                        <DatePicker
                            id="agent-spending-expires"
                            className="w-full"
                            align="start"
                            value={draft.expiresAt === '' ? null : parseYMD(draft.expiresAt.slice(0, 10))}
                            onChange={(next) => {
                                const ymd = toYMD(next);
                                if (ymd === null) return;
                                // Keep the stored instant when the day is unchanged.
                                if (draft.expiresAt.slice(0, 10) === ymd) return;
                                set('expiresAt', `${ymd}T00:00:00.000Z`);
                            }}
                            aria-label={t('agentDetail.spending.expires')}
                        />
                    </FormField>

                    <FormField label={t('agentDetail.spending.consentedBy')} required>
                        <Combobox
                            id="agent-spending-consenter"
                            selected={personOptions.find((o) => o.value === draft.consentedByUserId) ?? null}
                            setSelected={(o) => set('consentedByUserId', o?.value ?? '')}
                            options={personOptions}
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full' }}
                        />
                    </FormField>

                    <FormField
                        label={t('agentDetail.spending.tokenRequestor')}
                        description={t('agentDetail.spending.tokenRequestorHint')}
                        required
                    >
                        <Input
                            id="agent-spending-requestor"
                            value={draft.tokenRequestor}
                            maxLength={80}
                            onChange={(e) => set('tokenRequestor', e.target.value)}
                        />
                    </FormField>
                    <FormField
                        label={t('agentDetail.spending.tokenReference')}
                        description={t('agentDetail.spending.tokenReferenceHint')}
                        required
                    >
                        <Input
                            id="agent-spending-reference"
                            value={draft.tokenReference}
                            maxLength={128}
                            onChange={(e) => set('tokenReference', e.target.value)}
                        />
                    </FormField>

                    {error && (
                        <InlineNotice variant="error" icon={null} data-testid="agent-spending-form-error">
                            {error}
                        </InlineNotice>
                    )}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Button type="button" variant="ghost" size="sm" onClick={onClose} text={t('agentDetail.spending.cancel')} />
                <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    disabled={busy || !complete}
                    loading={busy}
                    onClick={submit}
                    data-testid="agent-spending-save"
                    text={narrowing ? t('agentDetail.spending.narrowSave') : t('agentDetail.spending.declareSave')}
                />
            </Modal.Footer>
        </Modal>
    );
}
