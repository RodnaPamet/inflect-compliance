'use client';

/**
 * REGISTER AN A2A PEER (#3807, the form for step 2e's
 * `POST /admin/agents/peers`).
 *
 * A peer is another organisation's agent, registered for identity and
 * attribution, never for authority. Registering records which card it
 * publishes, whose key signs its messages, which supplier it belongs to and
 * who in this tenant answers for it. It pins nothing: a registered peer is
 * refused until a person reads its card and approves it, on the peer's page,
 * which is where a successful registration lands.
 *
 * Inline in the list's banner rather than a dialog, like the detail page's
 * forms: the submit is the one action of its card, and a dialog's last button
 * must be a primary, which the product-wide ceiling has no slot for.
 */
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AsyncCombobox, type AsyncOption } from '@/components/ui/async-combobox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Heading } from '@/components/ui/typography';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';

/** How many matches one vendor search asks for. */
const VENDOR_SEARCH_LIMIT = 20;

/** `RegisterPeerAgentSchema`'s risk tiers. Optional: an unscored peer is registered and refused. */
const RISK_TIERS = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'] as const;

export interface PeerChoice {
    id: string;
    label: string;
}

export interface RegisteredPeer {
    peer: { id: string; name: string };
    card: { readable: boolean; reason?: string };
}

export function RegisterPeerForm({
    owners,
    vendors,
    ownersUnavailable = false,
    vendorsUnavailable = false,
    onRegistered,
    onCancel,
}: {
    owners: PeerChoice[];
    /** The first page of suppliers, offered before anything is typed. */
    vendors: PeerChoice[];
    ownersUnavailable?: boolean;
    vendorsUnavailable?: boolean;
    onRegistered: (registered: RegisteredPeer) => void;
    onCancel: () => void;
}) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();

    const [name, setName] = useState('');
    const [cardUrl, setCardUrl] = useState('');
    const [signingPublicKey, setSigningPublicKey] = useState('');
    const [owner, setOwner] = useState<ComboboxOption | null>(null);
    const [vendor, setVendor] = useState<AsyncOption | null>(null);
    const [riskTier, setRiskTier] = useState<ComboboxOption | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const ownerOptions: ComboboxOption[] = owners.map((o) => ({ value: o.id, label: o.label }));
    const vendorOptions = useMemo<AsyncOption[]>(() => vendors.map((v) => ({ value: v.id, label: v.label })), [vendors]);
    // The first page when nothing is typed; otherwise every supplier whose name
    // matches, from the vendors route, so the picker is not limited to the
    // page the server rendered (#4901: it was cut at 200, silently).
    const searchVendors = useCallback(
        async (query: string, signal: AbortSignal): Promise<AsyncOption[]> => {
            const q = query.trim();
            if (q === '') return vendorOptions;
            const res = await fetch(apiUrl(`/vendors?q=${encodeURIComponent(q)}&limit=${VENDOR_SEARCH_LIMIT}`), { signal });
            if (!res.ok) return [];
            const body = (await res.json().catch(() => null)) as { items?: { id: string; name: string }[] } | null;
            return (body?.items ?? []).map((v) => ({ value: v.id, label: v.name }));
        },
        [apiUrl, vendorOptions],
    );
    const tierOptions: ComboboxOption[] = RISK_TIERS.map((tier) => ({ value: tier, label: t(`peers.register.tier.${tier}`) }));

    const complete =
        name.trim().length > 0 && cardUrl.trim().length > 0 && signingPublicKey.trim().length > 0 && owner !== null && vendor !== null;

    const submit = async () => {
        if (!complete || !owner || !vendor) return;
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/admin/agents/peers'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name.trim(),
                    cardUrl: cardUrl.trim(),
                    signingPublicKey: signingPublicKey.trim(),
                    ownerUserId: owner.value,
                    vendorId: vendor.value,
                    ...(riskTier ? { riskTier: riskTier.value } : {}),
                }),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                setError(apiErrorMessage(body, t('peers.register.failed')));
                return;
            }
            onRegistered(body as RegisteredPeer);
        } catch {
            setError(t('peers.register.failed'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Card className="space-y-default" data-testid="peer-register-form">
            <Heading level={2}>{t('peers.register.heading')}</Heading>
            <p className="text-sm text-content-muted">{t('peers.register.intro')}</p>
            <div className="grid grid-cols-1 gap-default md:grid-cols-2">
                <FormField label={t('peers.register.name')} required>
                    <Input id="peer-register-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
                </FormField>
                <FormField label={t('peers.register.cardUrl')} description={t('peers.register.cardUrlHint')} required>
                    <Input
                        id="peer-register-card-url"
                        type="url"
                        value={cardUrl}
                        maxLength={2048}
                        placeholder={t('peers.register.cardUrlPlaceholder')}
                        onChange={(e) => setCardUrl(e.target.value)}
                    />
                </FormField>
                <FormField label={t('peers.register.signingKey')} description={t('peers.register.signingKeyHint')} required>
                    <Input
                        id="peer-register-signing-key"
                        value={signingPublicKey}
                        maxLength={256}
                        className="font-mono"
                        onChange={(e) => setSigningPublicKey(e.target.value)}
                    />
                </FormField>
                <FormField label={t('peers.register.owner')} description={t('peers.register.ownerHint')} required>
                    <div>
                    <Combobox
                        id="peer-register-owner"
                        options={ownerOptions}
                        selected={owner}
                        setSelected={setOwner}
                        placeholder={t('peers.register.ownerPlaceholder')}
                        searchPlaceholder={t('peers.register.search')}
                        matchTriggerWidth
                        forceDropdown
                        buttonProps={{ className: 'w-full' }}
                        caret
                    />
                    {ownersUnavailable && (
                        <p className="mt-1 text-xs text-content-error" data-testid="peer-register-owners-unavailable">
                            {t('peers.register.ownersUnavailable')}
                        </p>
                    )}
                    </div>
                </FormField>
                <FormField label={t('peers.register.vendor')} description={t('peers.register.vendorHint')} required>
                    <div>
                    <AsyncCombobox
                        id="peer-register-vendor"
                        value={vendor?.value ?? null}
                        onChange={(o) => setVendor(o)}
                        onSearch={searchVendors}
                        initialOptions={vendorOptions}
                        placeholder={t('peers.register.vendorPlaceholder')}
                        searchPlaceholder={t('peers.register.search')}
                        matchTriggerWidth
                    />
                    {vendorsUnavailable ? (
                        <p className="mt-1 text-xs text-content-error" data-testid="peer-register-vendors-unavailable">
                            {t('peers.register.vendorsUnavailable')}
                        </p>
                    ) : vendors.length === 0 ? (
                        <p className="mt-1 text-xs text-content-muted" data-testid="peer-register-no-vendors">
                            {t('peers.register.vendorsEmpty')}{' '}
                            <Link href={tenantHref('/vendors')} className="text-content-info underline">
                                {t('peers.register.vendorsLink')}
                            </Link>
                        </p>
                    ) : null}
                    </div>
                </FormField>
                <FormField label={t('peers.register.riskTier')} description={t('peers.register.riskTierHint')}>
                    <Combobox
                        hideSearch
                        id="peer-register-risk-tier"
                        options={tierOptions}
                        selected={riskTier}
                        setSelected={setRiskTier}
                        placeholder={t('peers.register.riskTierPlaceholder')}
                        matchTriggerWidth
                        buttonProps={{ className: 'w-full' }}
                        caret
                    />
                </FormField>
            </div>
            {error && (
                <InlineNotice variant="error" data-testid="peer-register-error">
                    {error}
                </InlineNotice>
            )}
            <div className="flex flex-wrap gap-compact">
                <Button
                    type="button"
                    // Secondary: the one action of an inline card.
                    variant="secondary"
                    size="sm"
                    disabled={!complete || busy}
                    loading={busy}
                    onClick={() => void submit()}
                    data-testid="peer-register-submit"
                >
                    {t('peers.register.submit')}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
                    {t('peers.register.cancel')}
                </Button>
            </div>
        </Card>
    );
}
