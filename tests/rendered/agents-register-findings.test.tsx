/**
 * The agent register, as the help-site guide found it (#4471).
 *
 * Each block is one finding, asserted at the surface a reader meets:
 *
 *   - the authority tier is a word, not the stored code;
 *   - a register longer than the page says so;
 *   - the not-enforcing banner names the page and the button that exist;
 *   - registering a third-party agent with no supplier says why, before the
 *     request, and a refused request shows the server's reason rather than
 *     "Invalid request payload";
 *   - the supplier picker reaches a vendor past the first page it was given;
 *   - a reader who may not list vendors is told so rather than offered a
 *     search every keystroke of which would be refused.
 */
import * as React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(180_000);

// next-intl is ESM. Resolved against the real en.json, memoised per namespace
// so a column `useMemo([t])` stays stable. `{param}` and `{param, number}`
// substitution only.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const walk = (root: unknown, dotted: string): unknown =>
        dotted.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = walk(walk(en, ns), key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    // `{cap, number}` too: the truncation notice formats its cap.
                    v = (v as string).replace(new RegExp('\\{' + p + '(, number)?\\}', 'g'), String(val));
            return v as string;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns?: string) => make(ns ?? ''), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/agents',
    useSearchParams: () => new URLSearchParams(),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import {
    AgentsClient,
    GovernanceBanner,
    type AgentRow,
} from '@/app/t/[tenantSlug]/(app)/agents/AgentsClient';
import { NewAgentModal } from '@/app/t/[tenantSlug]/(app)/agents/NewAgentModal';

type Bag = Record<string, unknown>;
const EN = require('../../messages/en.json') as Bag;
const BG = require('../../messages/bg.json') as Bag;
const at = (bag: Bag, dotted: string): string => {
    const v = dotted
        .split('.')
        .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Bag)[k] : undefined), bag);
    if (typeof v !== 'string') throw new Error(`no string at ${dotted}`);
    return v;
};

function makeRow(overrides: Partial<AgentRow> = {}): AgentRow {
    return {
        id: 'agent-1',
        name: 'Control reconciler',
        status: 'ACTIVE',
        autonomyLevel: 3,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        riskTier: 'MODERATE',
        isLegacyPlaceholder: false,
        owner: { id: 'user-1', name: 'Dana Iveagh', email: 'dana@acme.test' },
        aiSystem: { id: 'sys-1', riskTier: 'LIMITED', classificationClauseId: 'Art 50' },
        _count: { apiKeys: 0 },
        ...overrides,
    };
}

function renderRegister(props: Partial<React.ComponentProps<typeof AgentsClient>> = {}) {
    return render(
        <TooltipProvider delayDuration={0}>
            <AgentsClient
                initialRows={[makeRow()]}
                tenantSlug="acme"
                owners={[{ id: 'user-1', label: 'Dana Iveagh' }]}
                vendors={[]}
                kpiCounts={{ total: 1, active: 1, unscored: 0, egress: 0 }}
                governance={{
                    enforcing: true,
                    unboundCredentials: 0,
                    unboundCredentialSamples: [],
                    concurrency: { cap: null, inFlight: 0 },
                }}
                assurance={null}
                proposalsAwaitingReview={null}
                canWrite
                canReviewProposals
                {...props}
            />
        </TooltipProvider>,
    );
}

afterEach(() => {
    jest.restoreAllMocks();
});

// ─── The authority tier ─────────────────────────────────────────────────────

describe('the authority tier is shown as a word', () => {
    it('renders the filter’s own label, never the stored code', () => {
        renderRegister({
            initialRows: [makeRow({ id: 'a1', riskTier: 'MODERATE' }), makeRow({ id: 'a2', riskTier: 'CRITICAL' })],
        });
        const table = screen.getByTestId('agents-table');
        expect(within(table).getByText(at(EN, 'agents.register.filterEnums.riskTier.MODERATE'))).toBeInTheDocument();
        expect(within(table).getByText(at(EN, 'agents.register.filterEnums.riskTier.CRITICAL'))).toBeInTheDocument();
        expect(within(table).queryByText('MODERATE')).toBeNull();
        expect(within(table).queryByText('CRITICAL')).toBeNull();
    });

    it('shows a tier this client has no label for as stored, not as a key path', () => {
        renderRegister({ initialRows: [makeRow({ riskTier: 'SOME_LATER_TIER' })] });
        const table = screen.getByTestId('agents-table');
        expect(within(table).getByText('SOME_LATER_TIER')).toBeInTheDocument();
        expect(within(table).queryByText(/filterEnums/)).toBeNull();
    });
});

// ─── The 200-agent page ─────────────────────────────────────────────────────

describe('a register longer than the page says so', () => {
    it('shows the truncation notice when the server says the page is truncated', () => {
        renderRegister({ truncated: true, truncationCap: 200 });
        expect(screen.getByTestId('list-truncation-banner')).toHaveTextContent('200');
    });

    it('shows nothing when the whole register fits', () => {
        renderRegister({ truncated: false });
        expect(screen.queryByTestId('list-truncation-banner')).toBeNull();
    });
});

// ─── The not-enforcing banner ───────────────────────────────────────────────

describe('the not-enforcing banner names the page and the control that exist', () => {
    it('names "Security & MFA" and "Enforce registration", as the security page labels them', () => {
        render(
            <GovernanceBanner
                governance={{
                    enforcing: false,
                    unboundCredentials: 0,
                    unboundCredentialSamples: [],
                    concurrency: { cap: null, inFlight: 0 },
                }}
            />,
        );
        const banner = screen.getByTestId('agents-governance-banner');
        expect(banner).toHaveTextContent(at(EN, 'admin.security.title'));
        expect(banner).toHaveTextContent(at(EN, 'admin.security.agentEnforcement.enableAction'));
        expect(banner.textContent).not.toMatch(/Security settings|Require registered agent/);
    });

    it('does the same in Bulgarian', () => {
        const sentence = at(BG, 'agents.register.governance.notEnforcing');
        expect(sentence).toContain(at(BG, 'admin.security.title'));
        expect(sentence).toContain(at(BG, 'admin.security.agentEnforcement.enableAction'));
        expect(sentence).not.toMatch(/настройките за сигурност|Изисквай регистриран агент/);
    });
});

// ─── Capacity controls follow their own gate ───────────────────────────────

describe('the cap and budget forms follow the capacity gate', () => {
    it('hides both forms when the reader may register but not set capacity', () => {
        renderRegister({ canWrite: true, canSetCapacity: false });
        expect(screen.queryByTestId('agents-concurrency-input')).toBeNull();
        expect(screen.queryByTestId('agents-budget-save')).toBeNull();
    });

    it('shows both forms when the reader may set capacity', () => {
        renderRegister({ canWrite: true, canSetCapacity: true });
        expect(screen.getByTestId('agents-concurrency-input')).toBeInTheDocument();
        expect(screen.getByTestId('agents-budget-save')).toBeInTheDocument();
    });
});

// ─── The registration form ─────────────────────────────────────────────────

interface FetchCall {
    url: string;
    init?: RequestInit;
}

function mockFetch(handler: (url: string, init?: RequestInit) => { ok: boolean; body: unknown }) {
    const calls: FetchCall[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        const { ok, body } = handler(url, init);
        return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
    }) as unknown as typeof fetch;
    return calls;
}

function renderModal(props: Partial<React.ComponentProps<typeof NewAgentModal>> = {}) {
    const onCreated = jest.fn();
    render(
        <TooltipProvider delayDuration={0}>
            <NewAgentModal
                tenantSlug="acme"
                owners={[{ id: 'user-1', label: 'Dana Iveagh' }]}
                vendors={[{ id: 'v-1', name: 'Acme Supplies' }]}
                onClose={jest.fn()}
                onCreated={onCreated}
                {...props}
            />
        </TooltipProvider>,
    );
    return { onCreated };
}

async function chooseThirdParty(user: ReturnType<typeof userEvent.setup>) {
    const trigger = document.getElementById('agent-provenance-input');
    if (!trigger) throw new Error('no provenance picker');
    await user.click(trigger);
    await user.click(await screen.findByText(at(EN, 'agents.register.new.provenanceThirdParty')));
}

async function submit(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: at(EN, 'agents.register.new.submit') }));
}

describe('registering a third-party agent', () => {
    it('refuses a third-party agent with no supplier before sending, and says why', async () => {
        const calls = mockFetch(() => ({ ok: true, body: { id: 'new' } }));
        const user = userEvent.setup();
        renderModal();
        await user.type(document.getElementById('agent-name-input') as HTMLElement, 'Supplier bot');
        await chooseThirdParty(user);
        await submit(user);

        expect(await screen.findByText(at(EN, 'agents.register.new.vendorRequired'))).toBeInTheDocument();
        expect(calls.filter((c) => c.url.endsWith('/admin/agents'))).toHaveLength(0);
    });

    it('offers no "None" supplier: the field only exists where one is required', async () => {
        mockFetch(() => ({ ok: true, body: { items: [] } }));
        const user = userEvent.setup();
        renderModal();
        await chooseThirdParty(user);
        await user.click(document.getElementById('agent-vendorId-input') as HTMLElement);
        expect(await screen.findByText('Acme Supplies')).toBeInTheDocument();
        expect(screen.queryByText(at(EN, 'agents.register.new.noneApplicable'), { selector: '[role="option"] *' })).toBeNull();
    });

    it('finds a supplier past the first page by searching every vendor', async () => {
        const calls = mockFetch((url) => {
            if (url.includes('/vendors?')) {
                return { ok: true, body: { items: [{ id: 'v-999', name: 'Zeta Components' }] } };
            }
            return { ok: true, body: { id: 'agent-new' } };
        });
        const user = userEvent.setup();
        const { onCreated } = renderModal();
        await user.type(document.getElementById('agent-name-input') as HTMLElement, 'Supplier bot');
        await chooseThirdParty(user);
        await user.click(document.getElementById('agent-vendorId-input') as HTMLElement);
        await user.type(
            await screen.findByPlaceholderText(at(EN, 'agents.register.new.vendorSearchPlaceholder')),
            'Zeta',
        );
        await user.click(await screen.findByText('Zeta Components'));

        const search = calls.find((c) => c.url.includes('/vendors?'));
        expect(search?.url).toBe('/api/t/acme/vendors?q=Zeta&limit=50');

        await submit(user);
        await waitFor(() => expect(onCreated).toHaveBeenCalledWith('agent-new'));
        const post = calls.find((c) => c.url === '/api/t/acme/admin/agents');
        expect(JSON.parse(String(post?.init?.body))).toMatchObject({
            provenance: 'THIRD_PARTY',
            vendorId: 'v-999',
        });
    });

    it('tells a reader who may not list vendors so, and searches nothing', async () => {
        const calls = mockFetch(() => ({ ok: true, body: { items: [] } }));
        const user = userEvent.setup();
        renderModal({ vendors: [], canListVendors: false });
        await chooseThirdParty(user);

        expect(screen.getByText(at(EN, 'agents.register.new.vendorUnavailable'))).toBeInTheDocument();
        expect(document.getElementById('agent-vendorId-input')).toBeDisabled();
        expect(calls.filter((c) => c.url.includes('/vendors'))).toHaveLength(0);
    });
});

describe('a refused registration shows the server’s reason', () => {
    it('shows a validation refusal’s reasons, never "Invalid request payload"', async () => {
        mockFetch(() => ({
            ok: false,
            body: {
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid request payload',
                    details: [{ path: ['name'], code: 'too_small', message: 'Name is required' }],
                },
            },
        }));
        const user = userEvent.setup();
        renderModal();
        await user.type(document.getElementById('agent-name-input') as HTMLElement, 'Bot');
        await submit(user);

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Name is required');
        expect(alert).not.toHaveTextContent('Invalid request payload');
    });
});
