'use client';

/**
 * The six decisions a reviewer can record for one reconciliation row (#4871).
 *
 * The page offered Confirm and Defer only, though the usecase accepts six
 * (`legacy-reviewer-actions.ts`): an unmatched account, a service account or a
 * contractor could never be decided, so it came back every cycle. Owner
 * decision of 2026-11-01: the page offers all six, each with the server's own
 * permission rules — the decide route is `identity_reconciliation.confirm`,
 * and the form is shown only to a viewer who holds it.
 *
 * The record button is SECONDARY and sits in the Sheet body, not in a footer
 * action block: the repo-wide primary count is a downward ratchet, and this
 * page already chose secondary for its per-row Confirm for that reason.
 */
import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';

import { useTenantApiUrl, useTenantContext } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { AsyncCombobox, type AsyncOption } from '@/components/ui/async-combobox';
import { UserCombobox } from '@/components/ui/user-combobox';
import { DatePicker } from '@/components/ui/date-picker/date-picker';

export type DecisionKind = 'CONFIRM' | 'MANUAL' | 'NON_PERSON' | 'EXTERNAL' | 'ORPHAN';

export interface DecisionCandidate {
    employeeId: string;
    label: string;
}

/** The body the decide route takes, per kind. */
export type DecisionAction =
    | { kind: 'CONFIRM'; employeeId: string }
    | { kind: 'MANUAL'; employeeId: string; justification: string }
    | { kind: 'NON_PERSON'; ownerUserId: string; justification: string }
    | { kind: 'EXTERNAL'; justification: string; expiresAt: string }
    | { kind: 'ORPHAN'; justification: string };

/** The decide route's schema: `justification: z.string().min(10).max(2000)`. */
const MIN_REASON = 10;
const MAX_REASON = 2000;

const NEEDS_REASON: Readonly<Record<DecisionKind, boolean>> = {
    CONFIRM: false,
    MANUAL: true,
    NON_PERSON: true,
    EXTERNAL: true,
    ORPHAN: true,
};

export function DecisionForm({
    candidates,
    onDecide,
}: {
    candidates: readonly DecisionCandidate[];
    onDecide: (action: DecisionAction) => Promise<void>;
}) {
    const t = useTranslations('admin.integrations.legacyQueue');
    const apiUrl = useTenantApiUrl();
    const { tenantSlug } = useTenantContext();

    const [kind, setKind] = useState<DecisionKind>(candidates.length > 0 ? 'CONFIRM' : 'MANUAL');
    const [candidate, setCandidate] = useState<string | null>(candidates[0]?.employeeId ?? null);
    const [employee, setEmployee] = useState<string | null>(null);
    const [owner, setOwner] = useState<string | null>(null);
    const [expiresAt, setExpiresAt] = useState<Date | null>(null);
    const [reason, setReason] = useState('');
    const [saving, setSaving] = useState(false);
    // The usecase refuses an expiry that is not in the future, so the earliest
    // day offered is tomorrow: a date is midnight, and today's midnight is past.
    const [firstExpiryDay] = useState(() => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + 1);
        return d;
    });

    const searchEmployees = useCallback(
        async (query: string, signal: AbortSignal): Promise<AsyncOption[]> => {
            const res = await fetch(apiUrl(`/personnel?q=${encodeURIComponent(query)}`), { signal });
            if (!res.ok) return [];
            const body = (await res.json()) as {
                employees?: Array<{ id: string; fullName: string; workEmail?: string | null }>;
            };
            return (body.employees ?? []).map((e) => ({
                value: e.id,
                label: e.workEmail ? `${e.fullName} · ${e.workEmail}` : e.fullName,
            }));
        },
        [apiUrl],
    );

    const reasonText = reason.trim();
    const ready =
        (!NEEDS_REASON[kind] || reasonText.length >= MIN_REASON) &&
        (kind !== 'CONFIRM' || candidate !== null) &&
        (kind !== 'MANUAL' || employee !== null) &&
        (kind !== 'NON_PERSON' || owner !== null) &&
        (kind !== 'EXTERNAL' || expiresAt !== null);

    const submit = async () => {
        let action: DecisionAction;
        switch (kind) {
            case 'CONFIRM':
                action = { kind, employeeId: candidate! };
                break;
            case 'MANUAL':
                action = { kind, employeeId: employee!, justification: reasonText };
                break;
            case 'NON_PERSON':
                action = { kind, ownerUserId: owner!, justification: reasonText };
                break;
            case 'EXTERNAL':
                action = { kind, justification: reasonText, expiresAt: expiresAt!.toISOString() };
                break;
            case 'ORPHAN':
                action = { kind, justification: reasonText };
                break;
        }
        setSaving(true);
        try {
            await onDecide(action);
        } finally {
            setSaving(false);
        }
    };

    const kinds: DecisionKind[] = [
        ...(candidates.length > 0 ? (['CONFIRM'] as const) : []),
        'MANUAL',
        'NON_PERSON',
        'EXTERNAL',
        'ORPHAN',
    ];

    return (
        <section className="space-y-default border-t border-border-subtle pt-default" data-testid="legacy-decision-form">
            <h3 className="text-sm font-medium text-content-emphasis">{t('decideTitle')}</h3>
            <RadioGroup
                value={kind}
                onValueChange={(v) => setKind(v as DecisionKind)}
                aria-label={t('decideTitle')}
                className="space-y-1.5"
            >
                {kinds.map((k) => {
                    const id = `legacy-decision-${k}`;
                    return (
                        <label key={k} htmlFor={id} className="flex items-start gap-compact cursor-pointer">
                            <RadioGroupItem id={id} value={k} size="sm" className="mt-0.5" />
                            <span className="min-w-0">
                                <span className="block text-sm text-content-emphasis">{t(`decision.${k}`)}</span>
                                <span className="block text-xs text-content-muted">{t(`decisionHint.${k}`)}</span>
                            </span>
                        </label>
                    );
                })}
            </RadioGroup>

            {kind === 'CONFIRM' && candidates.length > 1 && (
                <FormField label={t('decideCandidate')}>
                    <RadioGroup
                        value={candidate ?? ''}
                        onValueChange={(v) => setCandidate(v)}
                        aria-label={t('decideCandidate')}
                        className="space-y-1"
                    >
                        {candidates.map((c) => (
                            <label key={c.employeeId} htmlFor={`legacy-candidate-${c.employeeId}`} className="flex items-center gap-compact text-sm">
                                <RadioGroupItem id={`legacy-candidate-${c.employeeId}`} value={c.employeeId} size="sm" />
                                {c.label}
                            </label>
                        ))}
                    </RadioGroup>
                </FormField>
            )}

            {kind === 'MANUAL' && (
                <FormField label={t('decidePerson')} required>
                    <AsyncCombobox
                        id="legacy-decision-person"
                        value={employee}
                        onChange={(opt) => setEmployee(opt?.value ?? null)}
                        onSearch={searchEmployees}
                        placeholder={t('decidePersonPlaceholder')}
                        searchPlaceholder={t('decidePersonSearch')}
                        matchTriggerWidth
                    />
                </FormField>
            )}

            {kind === 'NON_PERSON' && (
                <FormField label={t('owner')} required>
                    <UserCombobox
                        tenantSlug={tenantSlug}
                        id="legacy-decision-owner"
                        selectedId={owner}
                        onChange={(userId) => setOwner(userId)}
                        placeholder={t('decideOwnerPlaceholder')}
                    />
                </FormField>
            )}

            {kind === 'EXTERNAL' && (
                <FormField label={t('expiresAt')} required>
                    <DatePicker
                        id="legacy-decision-expires"
                        className="w-full"
                        align="start"
                        value={expiresAt}
                        onChange={(next) => setExpiresAt(next)}
                        disabledDays={{ before: firstExpiryDay }}
                        aria-label={t('expiresAt')}
                    />
                </FormField>
            )}

            {NEEDS_REASON[kind] && (
                <FormField label={t('justification')} description={t('justificationHint')} required>
                    <Textarea
                        id="legacy-decision-reason"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        rows={3}
                        maxLength={MAX_REASON}
                        className="w-full"
                    />
                </FormField>
            )}

            <Button variant="secondary" onClick={() => void submit()} disabled={!ready || saving} loading={saving} id="legacy-decision-submit">
                {t('decideSubmit')}
            </Button>
        </section>
    );
}
