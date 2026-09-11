'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

import type { AgentSummary, OwnerChoice, VendorChoice } from './AgentDetailClient';

/**
 * AMEND A REGISTERED AGENT (#2447) — the highest-priority of the nine headless
 * capabilities, and the one whose absence is a governance gap rather than an
 * inconvenience.
 *
 * `PATCH /admin/agents/:id` has existed since the register shipped.
 * `updateRegisteredAgent` validates all nine fields, re-checks ownership and
 * supplier attribution on the MERGED row, and enforces the risk-tier autonomy
 * ceiling. No .tsx file called it. So autonomy — the central authority dial —
 * was set at creation and frozen: an agent granted too much could not be turned
 * DOWN without somebody issuing an API call by hand.
 *
 * ── ONLY CHANGED FIELDS ARE SENT, AND THAT IS NOT AN OPTIMISATION ───
 *
 * The schema is all-optional and its refinement asks "does what the caller sent
 * describe an unattributed third party". Sending the whole form back every time
 * would re-submit unchanged values and re-run refinements against them — so
 * amending only an agent's NAME could be refused for a supplier attribution the
 * operator never touched and cannot see from here. A patch of exactly what
 * changed asks the server the question the operator actually asked.
 *
 * ── THE SERVER'S REFUSAL IS THE BETTER MESSAGE ──────────────────────
 *
 * Raising autonomy past the assessed tier's ceiling is refused with a sentence
 * that says what to do about it — complete the risk assessment, or reduce data
 * access and make actions reversible, because the tier is what lifts the cap.
 * That is surfaced verbatim rather than replaced with a generic failure: the
 * client cannot compute the ceiling (it is derived from a tier the client does
 * not hold) and should not pretend to.
 */

const DATA_ACCESS_SCOPES = [
    'NONE',
    'READ_METADATA',
    'READ_TENANT_DATA',
    'WRITE_TENANT_DATA',
    'EXTERNAL_EGRESS',
] as const;
const REVERSIBILITIES = ['REVERSIBLE', 'COMPENSABLE', 'TERMINAL'] as const;
const PROVENANCES = ['FIRST_PARTY', 'THIRD_PARTY'] as const;
const AUTONOMY_MAX = 6;

interface Draft {
    name: string;
    description: string;
    autonomyLevel: string;
    dataAccessScope: string;
    reversibility: string;
    provenance: string;
    modelRef: string;
    ownerUserId: string;
    vendorId: string;
}

function draftOf(agent: AgentSummary): Draft {
    return {
        name: agent.name,
        description: agent.description ?? '',
        autonomyLevel: String(agent.autonomyLevel),
        dataAccessScope: agent.dataAccessScope,
        reversibility: agent.reversibility,
        provenance: agent.provenance,
        modelRef: agent.modelRef ?? '',
        ownerUserId: agent.ownerUserId,
        vendorId: agent.vendorId ?? '',
    };
}

export function AgentAmendModal({
    agent,
    owners,
    vendors,
    onClose,
    onAmended,
}: {
    agent: AgentSummary;
    owners: OwnerChoice[];
    vendors: VendorChoice[];
    onClose: () => void;
    onAmended: () => void;
}) {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();

    const initial = useMemo(() => draftOf(agent), [agent]);
    const [draft, setDraft] = useState<Draft>(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
        setDraft((d) => ({ ...d, [k]: v }));

    /** Exactly what the operator changed — see the docstring. */
    const patch = useMemo(() => {
        const out: Record<string, unknown> = {};
        if (draft.name !== initial.name) out.name = draft.name.trim();
        if (draft.description !== initial.description) {
            out.description = draft.description.trim() === '' ? null : draft.description.trim();
        }
        if (draft.autonomyLevel !== initial.autonomyLevel) {
            out.autonomyLevel = Number(draft.autonomyLevel);
        }
        if (draft.dataAccessScope !== initial.dataAccessScope) out.dataAccessScope = draft.dataAccessScope;
        if (draft.reversibility !== initial.reversibility) out.reversibility = draft.reversibility;
        if (draft.provenance !== initial.provenance) out.provenance = draft.provenance;
        if (draft.modelRef !== initial.modelRef) {
            out.modelRef = draft.modelRef.trim() === '' ? null : draft.modelRef.trim();
        }
        if (draft.ownerUserId !== initial.ownerUserId) out.ownerUserId = draft.ownerUserId;
        if (draft.vendorId !== initial.vendorId) {
            out.vendorId = draft.vendorId === '' ? null : draft.vendorId;
        }
        return out;
    }, [draft, initial]);

    const changedCount = Object.keys(patch).length;
    const lowering = Number(draft.autonomyLevel) < agent.autonomyLevel;

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(apiUrl(`/admin/agents/${agent.id}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                // Verbatim. The tier-ceiling refusal tells the operator what to
                // do about it; a generic message would throw that away.
                setError(body?.error ?? t('agentDetail.amend.failed'));
                return;
            }
            onAmended();
            onClose();
        } finally {
            setBusy(false);
        }
    }

    const opt = (values: readonly string[]) => values.map((v) => ({ value: v, label: v }));

    return (
        <Modal showModal setShowModal={(o) => (o ? null : onClose())} size="lg" preventDefaultClose={busy}>
            <Modal.Header title={t('agentDetail.amend.title', { name: agent.name })} />
            <Modal.Body>
                <div className="space-y-default" data-testid="agent-amend-modal">
                    <FormField label={t('agentDetail.amend.name')} required>
                        <Input value={draft.name} onChange={(e) => set('name', e.target.value)} maxLength={200} />
                    </FormField>

                    <FormField label={t('agentDetail.amend.description')}>
                        <Input
                            value={draft.description}
                            onChange={(e) => set('description', e.target.value)}
                            maxLength={4000}
                        />
                    </FormField>

                    <FormField label={t('agentDetail.amend.autonomy')}>
                        <Combobox
                            hideSearch
                            id="agent-amend-autonomy"
                            selected={
                                opt(Array.from({ length: AUTONOMY_MAX + 1 }, (_, i) => String(i)))
                                    .find((o) => o.value === draft.autonomyLevel) ?? null
                            }
                            setSelected={(o) => set('autonomyLevel', o?.value ?? draft.autonomyLevel)}
                            options={opt(Array.from({ length: AUTONOMY_MAX + 1 }, (_, i) => String(i)))}
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full' }}
                        />
                    </FormField>

                    {/* LOWERING is always permitted and never needs a
                        re-assessment, which is worth saying at the point of the
                        change: an operator turning an agent down during an
                        incident should not wonder whether they must re-assess
                        first. Raising is refused by the server when it exceeds
                        the tier's ceiling, and that refusal explains itself. */}
                    {lowering && (
                        <InlineNotice variant="info" icon={null}>
                            {t('agentDetail.amend.loweringAlwaysAllowed')}
                        </InlineNotice>
                    )}

                    <FormField label={t('agentDetail.amend.dataAccess')}>
                        <Combobox
                            hideSearch
                            id="agent-amend-scope"
                            selected={opt(DATA_ACCESS_SCOPES).find((o) => o.value === draft.dataAccessScope) ?? null}
                            setSelected={(o) => set('dataAccessScope', o?.value ?? draft.dataAccessScope)}
                            options={opt(DATA_ACCESS_SCOPES)}
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full' }}
                        />
                    </FormField>

                    <FormField label={t('agentDetail.amend.reversibility')}>
                        <Combobox
                            hideSearch
                            id="agent-amend-reversibility"
                            selected={opt(REVERSIBILITIES).find((o) => o.value === draft.reversibility) ?? null}
                            setSelected={(o) => set('reversibility', o?.value ?? draft.reversibility)}
                            options={opt(REVERSIBILITIES)}
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full' }}
                        />
                    </FormField>

                    <FormField label={t('agentDetail.amend.provenance')}>
                        <Combobox
                            hideSearch
                            id="agent-amend-provenance"
                            selected={opt(PROVENANCES).find((o) => o.value === draft.provenance) ?? null}
                            setSelected={(o) => set('provenance', o?.value ?? draft.provenance)}
                            options={opt(PROVENANCES)}
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full' }}
                        />
                    </FormField>

                    <FormField label={t('agentDetail.amend.modelRef')}>
                        <Input value={draft.modelRef} onChange={(e) => set('modelRef', e.target.value)} />
                    </FormField>

                    <FormField label={t('agentDetail.amend.owner')} required>
                        <Combobox
                            id="agent-amend-owner"
                            selected={
                                owners.map((o) => ({ value: o.id, label: o.label }))
                                    .find((o) => o.value === draft.ownerUserId) ?? null
                            }
                            setSelected={(o) => set('ownerUserId', o?.value ?? draft.ownerUserId)}
                            options={owners.map((o) => ({ value: o.id, label: o.label }))}
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full' }}
                        />
                    </FormField>

                    <FormField label={t('agentDetail.amend.vendor')}>
                        <Combobox
                            id="agent-amend-vendor"
                            selected={
                                [{ value: '', label: t('agentDetail.amend.vendorNone') },
                                 ...vendors.map((v) => ({ value: v.id, label: v.name }))]
                                    .find((o) => o.value === draft.vendorId) ?? null
                            }
                            setSelected={(o) => set('vendorId', o?.value ?? '')}
                            options={[
                                { value: '', label: t('agentDetail.amend.vendorNone') },
                                ...vendors.map((v) => ({ value: v.id, label: v.name })),
                            ]}
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full' }}
                        />
                    </FormField>

                    {error && (
                        <InlineNotice variant="error" icon={null} data-testid="agent-amend-error">
                            {error}
                        </InlineNotice>
                    )}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Button type="button" variant="ghost" size="sm" onClick={onClose} text={t('agentDetail.kill.cancel')} />
                <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    // Nothing changed means nothing to send. A submit that
                    // PATCHes `{}` writes an audit row saying an agent was
                    // amended when it was not.
                    disabled={busy || changedCount === 0}
                    onClick={submit}
                    data-testid="agent-amend-save"
                    text={t('agentDetail.amend.save', { count: changedCount })}
                />
            </Modal.Footer>
        </Modal>
    );
}
