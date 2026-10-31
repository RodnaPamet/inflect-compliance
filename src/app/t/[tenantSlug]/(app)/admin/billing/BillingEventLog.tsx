'use client';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Activity, CreditCard, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { DataTable, createColumns } from '@/components/ui/table';

/**
 * Renders a list of recent billing events with icons and human-readable labels.
 * Receives pre-formatted events from the server component.
 */

/** Stripe event type → label key under `admin.billingLog.events` and its icon. */
const EVENT_CONFIG: Record<string, { key: string; icon: typeof Activity; color: string }> = {
    'checkout.session.completed': { key: 'checkoutCompleted', icon: CreditCard, color: 'text-content-success' },
    'customer.subscription.created': { key: 'subscriptionCreated', icon: CheckCircle, color: 'text-[var(--brand-default)]' },
    'customer.subscription.updated': { key: 'subscriptionUpdated', icon: Activity, color: 'text-content-info' },
    'customer.subscription.deleted': { key: 'subscriptionCanceled', icon: XCircle, color: 'text-content-error' },
    'invoice.payment_failed': { key: 'paymentFailed', icon: AlertTriangle, color: 'text-content-error' },
    'invoice.payment_succeeded': { key: 'paymentSucceeded', icon: CheckCircle, color: 'text-content-success' },
};

interface BillingEvent {
    id: string;
    type: string;
    stripeEventId: string;
    createdAt: string;
}

export function BillingEventLog({ events }: { events: BillingEvent[] }) {
    const t = useTranslations('admin');
    const columns = useMemo(() => createColumns<BillingEvent>([
        {
            id: 'event',
            header: t('billingLog.event'),
            accessorKey: 'type',
            cell: ({ row }) => {
                const known = EVENT_CONFIG[row.original.type];
                // An event type we have no label for: say so, and keep Stripe's
                // own name beside it so it can still be looked up.
                const config = known
                    ? { ...known, label: t(`billingLog.events.${known.key}` as Parameters<typeof t>[0]) }
                    : { label: t('billingLog.events.other', { type: row.original.type }), icon: Activity, color: 'text-content-muted' };
                const Icon = config.icon;
                return (
                    <div className="flex items-center gap-tight">
                        <Icon className={`w-4 h-4 ${config.color}`} />
                        <span className="text-sm text-content-emphasis">{config.label}</span>
                    </div>
                );
            },
        },
        {
            id: 'time',
            header: t('billingLog.time'),
            accessorKey: 'createdAt',
            cell: ({ getValue }) => (
                <span className="text-content-muted whitespace-nowrap">
                    {formatDateTime(getValue() as string)}
                </span>
            ),
        },
        {
            id: 'stripeId',
            header: t('billingLog.stripeId'),
            accessorKey: 'stripeEventId',
            cell: ({ getValue }) => (
                <span className="text-content-subtle font-mono">
                    {(getValue() as string).slice(0, 20)}…
                </span>
            ),
        },
    ]), [t]);

    return (
        <DataTable
            data={events}
            columns={columns}
            getRowId={(e) => e.id}
            emptyState={t('billingLog.empty')}
            resourceName={(p) => p ? t('billingLog.resourcePlural') : t('billingLog.resourceSingular')}
            data-testid="billing-event-log"
        />
    );
}
