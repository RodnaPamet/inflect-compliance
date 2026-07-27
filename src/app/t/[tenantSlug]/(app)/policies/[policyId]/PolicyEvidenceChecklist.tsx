'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { Combobox } from '@/components/ui/combobox';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Card } from '@/components/ui/card';
import { Heading, textLinkVariants } from '@/components/ui/typography';
import Link from 'next/link';
import type { PolicyEvidenceItemDTO } from '@/lib/dto/policy.dto';

interface Props {
    policyId: string;
    items: PolicyEvidenceItemDTO[];
    canWrite: boolean;
    onChanged: () => void;
}

interface EvidenceOption { value: string; label: string }

/**
 * Evidence-to-Retain checklist. Each item is a suggested piece of
 * evidence the policy declares; the tenant links it to a real Evidence
 * record so the policy's operational proof is navigable. Linking reuses
 * the PATCH /policies/[id]/evidence-items/[itemId] endpoint.
 */
export function PolicyEvidenceChecklist({ policyId, items, canWrite, onChanged }: Props) {
    const t = useTranslations('policies');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [options, setOptions] = useState<EvidenceOption[]>([]);
    const [busy, setBusy] = useState('');
    const [newLabel, setNewLabel] = useState('');
    const [adding, setAdding] = useState(false);

    useEffect(() => {
        if (!canWrite) return;
        fetch(apiUrl('/evidence'))
            .then((r) => r.json())
            .then((d) => {
                const rows = Array.isArray(d) ? d : (d?.rows ?? []);
                setOptions(rows.map((e: { id: string; title: string }) => ({ value: e.id, label: e.title })));
            })
            .catch(() => {});
    }, [apiUrl, canWrite]);

    const patch = async (itemId: string, evidenceId: string | null) => {
        setBusy(itemId);
        try {
            const res = await fetch(apiUrl(`/policies/${policyId}/evidence-items/${itemId}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ evidenceId }),
            });
            if (res.ok) onChanged();
        } finally {
            setBusy('');
        }
    };

    // Add a new evidence-to-retain item (wires addPolicyEvidenceItem via POST).
    const addItem = async () => {
        const label = newLabel.trim();
        if (!label || adding) return;
        setAdding(true);
        try {
            const res = await fetch(apiUrl(`/policies/${policyId}/evidence-items`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label }),
            });
            if (res.ok) { setNewLabel(''); onChanged(); }
        } finally {
            setAdding(false);
        }
    };

    // Render the card whenever there are items OR the user can add one.
    if (!items.length && !canWrite) return null;

    const linkedCount = items.filter((i) => i.evidenceId).length;

    return (
        <Card>
            <div className="flex items-center justify-between mb-default">
                <Heading level={3} className="text-sm">{t('evidence.title')}</Heading>
                <StatusBadge variant={linkedCount === items.length ? 'success' : 'neutral'}>
                    {t('evidence.linkedCount', { linked: linkedCount, total: items.length })}
                </StatusBadge>
            </div>
            <ul className="space-y-tight" id="policy-evidence-checklist">
                {items.map((item) => (
                    <li
                        key={item.id}
                        className="flex items-start justify-between gap-compact rounded border border-border-subtle p-compact"
                    >
                        <div className="flex-1 min-w-0">
                            <span className="text-sm">{item.label}</span>
                            {item.evidence && (
                                <div className="mt-0.5 text-xs">
                                    <Link
                                        // R5-P3 #9 — /evidence/{id} is not a route (the detail is a
                                        // sheet opened by ?ev=); the old href 404'd. Deep-link the sheet.
                                        href={tenantHref(`/evidence?ev=${item.evidence.id}`)}
                                        className={textLinkVariants({ tone: 'link' })}
                                    >
                                        ↳ {item.evidence.title}
                                    </Link>
                                </div>
                            )}
                        </div>
                        {canWrite && (
                            item.evidenceId ? (
                                <Button
                                    variant="ghost"
                                    size="xs"
                                    className="text-content-muted"
                                    disabled={busy === item.id}
                                    onClick={() => patch(item.id, null)}
                                    id={`unlink-evidence-${item.id}`}
                                >
                                    {t('evidence.unlink')}
                                </Button>
                            ) : (
                                <div className="w-56 shrink-0">
                                    <Combobox
                                        id={`link-evidence-${item.id}`}
                                        selected={null}
                                        setSelected={(opt) => opt && patch(item.id, opt.value)}
                                        options={options}
                                        placeholder={t('evidence.linkPlaceholder')}
                                        matchTriggerWidth
                                        buttonProps={{ disabled: busy === item.id }}
                                    />
                                </div>
                            )
                        )}
                    </li>
                ))}
            </ul>
            {canWrite && (
                <div className="mt-default flex items-center gap-tight">
                    <input
                        className="input flex-1"
                        value={newLabel}
                        onChange={(e) => setNewLabel(e.target.value)}
                        placeholder={t('evidence.addPlaceholder')}
                        data-testid="policy-evidence-add-input"
                    />
                    <Button variant="secondary" size="sm" onClick={addItem} disabled={!newLabel.trim() || adding} id="policy-evidence-add-btn">
                        {t('evidence.add')}
                    </Button>
                </div>
            )}
            <p className="mt-default text-xs text-content-subtle italic">
                {t('evidence.note')}
            </p>
        </Card>
    );
}
