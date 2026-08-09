/**
 * A failed velocity load is VISIBLE.
 *
 * B2-2 — `VelocityCard` used to do a bare `fetch(...).catch(() => {})`,
 * leaving its state null forever, and `if (!v) return null` rendered
 * nothing. That made a broken endpoint pixel-identical to the two states
 * that legitimately render nothing:
 *
 *   - still loading;
 *   - loaded fine, but there is genuinely no movement to report.
 *
 * A card that renders nothing when it breaks is a card nobody ever reports
 * as broken. The failure had no upper bound on how long it could persist.
 *
 * The two silent states stay silent — this is a supplementary dashboard
 * slot, and a skeleton for a card that may have nothing to say is worse
 * than no card. Only the ERROR state is new, and that is what is asserted
 * here: the three states must stay distinguishable.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';
import { VelocityCard } from '@/app/t/[tenantSlug]/(app)/risks/dashboard/VelocityCard';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns: string) => (key: string) => {
            const full = ns ? `${ns}.${key}` : key;
            return full.split('.').reduce<unknown>(
                (acc, k) => (acc as Record<string, unknown> | undefined)?.[k],
                en,
            ) as string ?? full;
        },
    };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    useMoneyFormatter: () => (n: number | null | undefined) => `€${n ?? 0}`,
}));

// Each render gets its own cache — SWR's is module-global, so a cached
// response from one test would satisfy the next one's fetch.
const renderCard = () =>
    render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <VelocityCard />
        </SWRConfig>,
    );

const VELOCITY = {
    topRising: [{ riskId: 'r1', title: 'Rising risk', deltaPercent: 12.5 }],
    topFalling: [],
    portfolioVelocity: {
        currentTotalAle: 200, previousTotalAle: 100, deltaPercent: 100, trend: 'RISING',
    },
};

describe('VelocityCard — the three empty-looking states are distinguishable', () => {
    afterEach(() => { jest.restoreAllMocks(); });

    it('shows an error with a retry when the load fails', async () => {
        global.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
        renderCard();
        const card = await screen.findByTestId('risk-velocity-error');
        expect(card).toHaveTextContent("Couldn't load risk velocity.");
        expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
        // And crucially NOT the success card — the old behaviour rendered
        // neither, which is what made the failure invisible.
        expect(screen.queryByTestId('risk-velocity')).toBeNull();
    });

    it('refetches when Retry is clicked', async () => {
        let call = 0;
        global.fetch = jest.fn(async () => {
            call += 1;
            return call === 1
                ? { ok: false, status: 500, json: async () => ({}) }
                : { ok: true, status: 200, json: async () => ({ velocity: VELOCITY }) };
        }) as unknown as typeof fetch;

        renderCard();
        await screen.findByTestId('risk-velocity-error');
        await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
        // Recovery, not just a second request — a retry that re-renders the
        // same error card would look identical from the outside.
        await waitFor(() => expect(screen.getByTestId('risk-velocity')).toBeInTheDocument());
        expect(screen.queryByTestId('risk-velocity-error')).toBeNull();
    });

    it('renders nothing — no error card — when there is genuinely nothing to report', async () => {
        // The legitimately-quiet case must NOT start showing an error just
        // because the error state now exists.
        global.fetch = jest.fn(async () => ({
            ok: true, status: 200,
            json: async () => ({
                velocity: {
                    topRising: [], topFalling: [],
                    portfolioVelocity: {
                        currentTotalAle: 0, previousTotalAle: 0, deltaPercent: 0, trend: 'STABLE',
                    },
                },
            }),
        })) as unknown as typeof fetch;
        const { container } = renderCard();
        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        await waitFor(() => expect(screen.queryByTestId('risk-velocity-error')).toBeNull());
        expect(screen.queryByTestId('risk-velocity')).toBeNull();
        expect(container).toBeEmptyDOMElement();
    });

    it('renders the card when there IS movement to report', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true, status: 200, json: async () => ({ velocity: VELOCITY }),
        })) as unknown as typeof fetch;
        renderCard();
        expect(await screen.findByTestId('risk-velocity')).toBeInTheDocument();
        expect(screen.queryByTestId('risk-velocity-error')).toBeNull();
    });
});
