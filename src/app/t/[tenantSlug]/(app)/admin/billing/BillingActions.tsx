'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CreditCard, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiErrorMessage } from '@/lib/api-error';

/**
 * Client component for billing actions.
 * Handles POST to checkout/portal routes and redirects to Stripe.
 */
export function BillingActions({
    plan,
    portal,
    tenantSlug,
}: {
    plan?: 'PRO' | 'ENTERPRISE';
    portal?: boolean;
    tenantSlug: string;
}) {
    const t = useTranslations('admin.billing');
    const [loading, setLoading] = useState(false);

    // The server's reason when it gave one (a 403 such as billing_unavailable),
    // else a sentence. Never the raw envelope: `error` is `{ code, message }`.
    async function refusal(res: Response): Promise<string> {
        if (res.status >= 500) return t('actionFailed');
        const body: unknown = await res.json().catch(() => null);
        return apiErrorMessage(body, t('actionFailed'));
    }
    const [error, setError] = useState<string | null>(null);

    async function handleCheckout() {
        if (!plan) return;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/t/${tenantSlug}/billing/checkout`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plan }),
            });
            if (!res.ok) {
                setError(await refusal(res));
                setLoading(false);
                return;
            }
            const { url } = await res.json();
            window.location.href = url;
        } catch {
            setError(t('actionFailed'));
            setLoading(false);
        }
    }

    async function handlePortal() {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/t/${tenantSlug}/billing/portal`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            if (!res.ok) {
                setError(await refusal(res));
                setLoading(false);
                return;
            }
            const { url } = await res.json();
            window.location.href = url;
        } catch {
            setError(t('actionFailed'));
            setLoading(false);
        }
    }

    if (portal) {
        return (
            <div>
                <Button
                    variant="primary"
                    onClick={handlePortal}
                    disabled={loading}
                    loading={loading}
                    id="billing-portal-btn"
                >
                    {!loading && <ExternalLink className="w-4 h-4" />}
                    {t('manageBilling')}
                </Button>
                {error && <p className="text-xs text-content-error mt-2">{error}</p>}
            </div>
        );
    }

    return (
        <div>
            <Button
                variant={plan === 'ENTERPRISE' ? 'secondary' : 'primary'}
                onClick={handleCheckout}
                disabled={loading}
                loading={loading}
                id={`billing-upgrade-${plan?.toLowerCase()}-btn`}
            >
                {!loading && <CreditCard className="w-4 h-4" />}
                {plan ? t('upgradeTo', { plan: t(`planName.${plan}`) }) : null}
            </Button>
            {error && <p className="text-xs text-content-error mt-2">{error}</p>}
        </div>
    );
}
