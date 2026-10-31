/**
 * #4815 — the Billing page says the plan and status in words, the plan a
 * self-hosted workspace actually has, a failed checkout's reason (not
 * "[object Object]"), and what happened when Stripe sends the user back.
 */
import * as React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

const EN = jest.requireActual('../../messages/en.json') as {
    admin: { billing: Record<string, unknown>; billingLog: { events: Record<string, string> } };
} & Record<string, unknown>;
const billing = EN.admin.billing as Record<string, string> & {
    planName: Record<string, string>;
    statusName: Record<string, string>;
};

jest.mock('next-intl/server', () => {
    const en = jest.requireActual('../../messages/en.json') as Record<string, unknown>;
    const lookup = (o: unknown, path: string): unknown =>
        path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o);
    return {
        __esModule: true,
        getTranslations: async (ns: string) => {
            const bag = lookup(en, ns);
            const t = (key: string, values?: Record<string, unknown>) => {
                const v = lookup(bag, key);
                if (typeof v !== 'string') return key;
                return v.replace(/\{(\w+)\}/g, (_m, k: string) => String(values?.[k] ?? ''));
            };
            t.rich = (key: string) => t(key);
            return t;
        },
    };
});

const gate = { allowed: true, ctx: { tenantId: 't1' }, tenantSlug: 'acme' };
jest.mock('@/app/t/[tenantSlug]/(app)/admin/_lib/admin-page-gate', () => ({
    gateAdminPage: async () => gate,
}));

const reads: { account: unknown; events: unknown[] } = { account: null, events: [] };
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenant: { findUnique: async () => ({ name: 'Acme' }) },
        billingAccount: { findUnique: async () => reads.account },
        billingEvent: { findMany: async () => reads.events },
    },
}));

let mode: 'SAAS' | 'SELFHOSTED' = 'SAAS';
jest.mock('@/lib/billing/entitlements', () => ({ getBillingMode: () => mode }));
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));
jest.mock('@/components/layout/PageBreadcrumbs', () => ({ PageBreadcrumbs: () => null }));

import BillingPage from '@/app/t/[tenantSlug]/(app)/admin/billing/page';

afterEach(() => {
    cleanup();
    reads.account = null;
    reads.events = [];
    mode = 'SAAS';
    delete (globalThis as { fetch?: unknown }).fetch;
});

async function renderPage(billingParam?: string) {
    const el = await BillingPage({
        params: Promise.resolve({ tenantSlug: 'acme' }),
        searchParams: Promise.resolve(billingParam ? { billing: billingParam } : {}),
    });
    return render(
        <NextIntlClientProvider locale="en" messages={EN}>
            {el}
        </NextIntlClientProvider>,
    );
}

describe('plan and status in words', () => {
    it('a past-due Pro workspace reads "Pro" and "Past due", not stored values', async () => {
        reads.account = { plan: 'PRO', status: 'PAST_DUE', stripeSubscriptionId: 'sub_1' };
        await renderPage();
        expect(document.getElementById('billing-plan-badge')).toHaveTextContent(billing.planName.PRO);
        expect(document.getElementById('billing-status-badge')).toHaveTextContent(billing.statusName.PAST_DUE);
        expect(document.body.textContent).not.toContain('PAST DUE');
    });

    it('self-hosted shows Enterprise, the plan its entitlements apply', async () => {
        mode = 'SELFHOSTED';
        await renderPage();
        expect(document.getElementById('billing-plan-badge')).toHaveTextContent(billing.planName.ENTERPRISE);
        expect(document.getElementById('billing-self-hosted-banner')).toBeInTheDocument();
    });
});

describe('returning from Stripe', () => {
    it('says the checkout completed', async () => {
        await renderPage('success');
        expect(document.getElementById('billing-checkout-success')).toHaveTextContent(billing.checkoutSuccessTitle);
    });

    it('says the checkout was canceled', async () => {
        await renderPage('canceled');
        expect(document.getElementById('billing-checkout-canceled')).toHaveTextContent(billing.checkoutCanceledTitle);
    });

    it('says nothing on an ordinary visit', async () => {
        await renderPage();
        expect(document.getElementById('billing-checkout-success')).toBeNull();
        expect(document.getElementById('billing-checkout-canceled')).toBeNull();
    });
});

describe('upgrade buttons', () => {
    it('name the plan in words and show the server\'s refusal, not "[object Object]"', async () => {
        (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({
            ok: false,
            status: 403,
            json: async () => ({ error: { code: 'FORBIDDEN', message: 'billing_unavailable: self-hosted' } }),
        }));
        await renderPage();
        const button = document.getElementById('billing-upgrade-pro-btn') as HTMLElement;
        expect(button).toHaveTextContent('Upgrade to Pro');
        fireEvent.click(button);
        expect(await screen.findByText('billing_unavailable: self-hosted')).toBeInTheDocument();
        expect(document.body.textContent).not.toContain('[object Object]');
    });
});

describe('the event log', () => {
    it('labels known events and names unknown ones', async () => {
        reads.events = [
            { id: 'e1', type: 'invoice.payment_failed', stripeEventId: 'evt_1234567890123456789012', createdAt: new Date('2026-10-01') },
            { id: 'e2', type: 'customer.discount.created', stripeEventId: 'evt_abcdefghijabcdefghij00', createdAt: new Date('2026-10-02') },
        ];
        await renderPage();
        expect(screen.getByText(EN.admin.billingLog.events.paymentFailed)).toBeInTheDocument();
        expect(screen.getByText('Other Stripe event (customer.discount.created)')).toBeInTheDocument();
    });
});
