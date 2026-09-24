/**
 * THE SIX TERMS, ON THE SURFACE AN OPERATOR ACTUALLY READS.
 *
 * ── THE ASSERTION THAT MATTERS IS THE BLOCKED ONE ───────────────────────────
 *
 * A card that showed only "ready / not ready" would be cheaper and would look
 * correct. It would also be useless in the only state anyone opens it in: five
 * of six satisfied looks exactly like none, because every run executes on the
 * static engine and succeeds either way. So what is asserted first is that the
 * card NAMES the blocking term and offers the place to fix it.
 *
 * Copy is read out of `messages/en.json` rather than written here, so this
 * pins the WIRING and not the wording — a copy edit must not redden a test
 * about whether the blocking term is shown.
 */
import { render, screen } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/admin/integrations',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = lookup(ns, key);
        if (typeof v !== 'string') return key;
        if (params) for (const [p, val] of Object.entries(params)) {
            v = (v as string).replace(new RegExp('\\{' + p + '[^}]*\\}', 'g'), String(val));
        }
        return v;
    };
    return { useTranslations: (ns: string) => make(ns) };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

import { FlueEngineCard } from '@/app/t/[tenantSlug]/(app)/admin/integrations/FlueEngineCard';

const EN = jest.requireActual('../../messages/en.json') as {
    admin: { flue: { term: Record<string, string>; boundKeyNote: string; statusBlocked: string; statusReady: string; fix: string; optIn: string; operatorTerm: string; runsOnStatic: string } };
};
const COPY = EN.admin.flue;

type Term = { key: string; satisfied: boolean; actor: 'operator' | 'tenant'; count?: number };

const ALL_SATISFIED: Term[] = [
    { key: 'ENV', satisfied: true, actor: 'operator' },
    { key: 'TENANT', satisfied: true, actor: 'tenant' },
    { key: 'BUILD', satisfied: true, actor: 'operator' },
    { key: 'WORKFLOW', satisfied: true, actor: 'operator' },
    { key: 'REGISTERED_AGENT', satisfied: true, actor: 'tenant', count: 1 },
    { key: 'BOUND_KEY', satisfied: true, actor: 'tenant', count: 1 },
];

function stateWith(overrides: Partial<Record<string, boolean>>, mode = 'FLUE') {
    const terms = ALL_SATISFIED.map((t) =>
        t.key in overrides ? { ...t, satisfied: overrides[t.key]!, count: t.count === undefined ? undefined : 0 } : t,
    );
    const blockedOn = terms.find((t) => !t.satisfied)?.key ?? null;
    return {
        mode,
        effective: { driver: blockedOn ? 'static' : 'flue', reason: blockedOn ? 'X' : null },
        terms,
        ready: blockedOn === null,
        blockedOn,
    };
}

function mockFetch(state: unknown) {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => state })) as unknown as typeof fetch;
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('the Flue wiring card', () => {
    it('names the blocking term rather than only saying "not ready"', async () => {
        mockFetch(stateWith({ REGISTERED_AGENT: false }));

        render(<FlueEngineCard />);

        expect(await screen.findByText(COPY.statusBlocked)).toBeInTheDocument();
        // The whole point: WHICH term. Asserted on the LEAD SENTENCE, which
        // interpolates the blocking term's own label — the checklist below
        // names every term whether or not it blocks, so matching the label
        // alone would pass on a card that had picked the wrong one.
        expect(
            screen.getByText(COPY.runsOnStatic.replace('{term}', COPY.term.REGISTERED_AGENT)),
        ).toBeInTheDocument();
    });

    it('offers the place to fix a tenant-owned term, and no link for an operator one', async () => {
        mockFetch(stateWith({ REGISTERED_AGENT: false, ENV: false }));

        render(<FlueEngineCard />);
        await screen.findByText(COPY.statusBlocked);

        // The register is reachable from here; the deployment's env switch is
        // not, and a link inviting an admin to try would be a dead end.
        const fixLinks = screen.getAllByRole('link', { name: COPY.fix });
        expect(fixLinks.map((a) => a.getAttribute('href'))).toEqual(['/t/acme/admin/agents']);
        expect(screen.getAllByText(COPY.operatorTerm).length).toBeGreaterThan(0);
    });

    it('renders every term, satisfied or not', async () => {
        mockFetch(stateWith({ BOUND_KEY: false }));

        render(<FlueEngineCard />);
        await screen.findByText(COPY.statusBlocked);

        // The denominator. A checklist that hid satisfied terms would leave an
        // operator unable to tell "done" from "not shown".
        for (const label of Object.values(COPY.term)) {
            expect(screen.getByText(label)).toBeInTheDocument();
        }
    });

    it('spells out the term no settings surface implies', async () => {
        mockFetch(stateWith({}));

        render(<FlueEngineCard />);
        await screen.findByText(COPY.statusReady);

        // A browser session carries no agent identity, so a Flue run cannot be
        // started from the runs page by hand however the checklist looks.
        // Nothing else in the product says this.
        expect(screen.getByText(COPY.boundKeyNote)).toBeInTheDocument();
    });

    it('offers opt-in when the workspace has not opted in', async () => {
        mockFetch(stateWith({ TENANT: false }, 'STATIC'));

        render(<FlueEngineCard />);

        expect(await screen.findByRole('button', { name: COPY.optIn })).toBeInTheDocument();
    });

    it('renders nothing before the state arrives', () => {
        global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;

        const { container } = render(<FlueEngineCard />);

        // A card that rendered an empty checklist on a failed read would say
        // "no terms satisfied", which is a different claim from "unknown".
        expect(container.querySelector('[data-testid="flue-engine-card"]')).toBeNull();
    });
});
