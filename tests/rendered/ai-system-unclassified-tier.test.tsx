/** @jest-environment jsdom */

/**
 * UNCLASSIFIED on the AI-system register and the AI-system detail page (#3691,
 * deploy 1 of 2).
 *
 * UNCLASSIFIED marks a provisional entry nobody has classified against the EU
 * AI Act. It is not a fifth tier, and above all it is not MINIMAL — the one
 * reading that would put a false sentence on a compliance page, because
 * MINIMAL is a classification that carries (almost) no obligations. Both
 * surfaces used to fall back to MINIMAL's look for anything they did not
 * recognise: the badge table had no UNCLASSIFIED key and `?? 'neutral'` is
 * MINIMAL's tone, and the detail header printed whatever the column held as
 * "<tier> risk". So each claim below is pinned against the rendering it
 * replaced:
 *
 *   • the register counts unclassified systems SEPARATELY in its header
 *     sentence, and says nothing about them when there are none;
 *   • an UNCLASSIFIED row's badge is a warning, not MINIMAL's neutral;
 *   • the detail page says the system is not classified — in the header line
 *     and in a notice — instead of "UNCLASSIFIED risk", and offers no
 *     conformity artifacts.
 */

import * as React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, {
        custom: jest.fn(), dismiss: jest.fn(), success: jest.fn(),
        error: jest.fn(), warning: jest.fn(), info: jest.fn(),
        message: jest.fn(), loading: jest.fn(),
    }),
}));

// next-intl is ESM (jest cannot parse it), and so is `intl-messageformat`, so
// the real ICU engine is not available here. The repo-wide mock substitutes
// `{name}` placeholders only, which would leave the register's header sentence
// as its own `{unclassified, plural, …}` template — and a test asserting on the
// COUNT would then be asserting on a template. So this mock also evaluates the
// flat `plural` blocks the catalogue uses (`=N` / `one` / `other`, bodies with
// no nested braces). A plural whose argument was not passed is left raw, the
// way a missing argument never yields the sentence it was meant to.
//
// Memoised per namespace — a fresh `t` per render invalidates every
// `useMemo([tx])` downstream and turns a page render into a loop.
jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const PLURAL = /\{(\w+),\s*plural,((?:\s*(?:=\d+|one|other)\s*\{[^{}]*\})+)\s*\}/g;
    const OPTION = /(=\d+|one|other)\s*\{([^{}]*)\}/g;
    const has = (params: Record<string, unknown> | undefined, name: string) =>
        !!params && Object.prototype.hasOwnProperty.call(params, name);
    const format = (str: string, params?: Record<string, unknown>) =>
        str
            .replace(PLURAL, (block: string, name: string, options: string) => {
                if (!has(params, name)) return block;
                const n = Number(params![name]);
                const forms = new Map<string, string>();
                for (const m of options.matchAll(OPTION)) forms.set(m[1], m[2]);
                const body =
                    forms.get(`=${n}`) ?? (n === 1 ? forms.get('one') : undefined) ?? forms.get('other');
                return body === undefined ? block : body.split('#').join(String(n));
            })
            .replace(/\{(\w+)\}/g, (m: string, name: string) => (has(params, name) ? String(params![name]) : m));
    const cache = new Map<string, unknown>();
    const makeT = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const val = lookup(ns, key);
            return typeof val === 'string' ? format(val, params) : key;
        };
        t.rich = t; t.markup = t; t.raw = (k: string) => lookup(ns, k);
        t.has = (k: string) => lookup(ns, k) !== undefined;
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, makeT(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
        useFormatter: () => ({
            dateTime: String, number: String, relativeTime: String,
            list: (l: string[]) => l.join(', '),
        }),
        NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
    };
});

const routeParams: { current: Record<string, string> } = { current: { tenantSlug: 'acme' } };
const pathname = { current: '/t/acme/risks/ai-systems' };
const routerMock = {
    push: jest.fn(), replace: jest.fn(), back: jest.fn(),
    refresh: jest.fn(), prefetch: jest.fn(),
};
jest.mock('next/navigation', () => ({
    useParams: () => routeParams.current,
    useRouter: () => routerMock,
    usePathname: () => pathname.current,
    useSearchParams: () => new URLSearchParams(),
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
    notFound: jest.fn(),
    redirect: jest.fn(),
}));

import { SWRConfig } from 'swr';
import {
    AiSystemsClient,
    type AiSystemRow,
} from '@/app/t/[tenantSlug]/(app)/risks/ai-systems/AiSystemsClient';
import {
    AiSystemDetailClient,
    type AiSystemDetail,
} from '@/app/t/[tenantSlug]/(app)/risks/ai-systems/[systemId]/AiSystemDetailClient';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { getPermissionsForRole } from '@/lib/permissions';
import { statusBadgeVariants } from '@/components/ui/status-badge';

/** The copy the operator reads — assertions compare against the catalogue. */
const AI = (
    jest.requireActual('../../messages/en.json') as {
        risks: {
            aiSystems: {
                provider: string;
                detail: {
                    notClassifiedLine: string;
                    notClassifiedNotice: string;
                    metaLine: string;
                    conformityHeading: string;
                };
            };
        };
    }
).risks.aiSystems;

const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
    modules: { processCanvas: false },
};

function Wrapper({ children }: { children: React.ReactNode }) {
    return (
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={TENANT_CTX}>
                <KeyboardShortcutProvider>
                    <TooltipProvider>{children}</TooltipProvider>
                </KeyboardShortcutProvider>
            </TenantProvider>
        </SWRConfig>
    );
}

async function flush(times = 6) {
    await act(async () => {
        for (let i = 0; i < times; i++) await Promise.resolve();
    });
}

/** A badge's own class contract, asked of the component rather than typed here. */
const badgeClasses = (variant: 'neutral' | 'warning'): string[] =>
    statusBadgeVariants({ variant }).split(' ').filter(Boolean);

beforeEach(() => {
    routeParams.current = { tenantSlug: 'acme' };
    pathname.current = '/t/acme/risks/ai-systems';
    routerMock.push.mockReset();
    routerMock.replace.mockReset();
});

// ─── The register ───────────────────────────────────────────────────────────

function row(id: string, name: string, riskTier: string): AiSystemRow {
    return {
        id,
        name,
        provider: 'Acme Labs',
        deploymentRole: 'PROVIDER',
        riskTier,
        classificationClauseId: riskTier === 'UNCLASSIFIED' ? null : 'art-6-annex-iii',
        status: 'ACTIVE',
        ownerUserId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        _count: { requirementLinks: 0 },
    };
}

async function renderRegister(rows: AiSystemRow[]) {
    const view = render(
        <Wrapper>
            <AiSystemsClient initialRows={rows} tenantSlug="acme" canWrite />
        </Wrapper>,
    );
    await waitFor(() => {
        expect(view.container.querySelector('[data-testid^="ai-system-row-"]')).not.toBeNull();
    });
    await flush();
    return view;
}

function headerDescription(): string {
    return screen.getByTestId('page-header-description').textContent ?? '';
}

/** The tier badge in one system's row — the element holding the tier as its own text. */
function tierBadge(systemId: string, tier: string): HTMLElement {
    const tr = screen.getByTestId(`ai-system-row-${systemId}`).closest('tr');
    if (!tr) throw new Error(`no table row around ai-system-row-${systemId}`);
    return within(tr as HTMLElement).getByText(tier);
}

describe('the register counts unclassified systems on their own', () => {
    const MIXED: AiSystemRow[] = [
        row('sys-1', 'Resume screener', 'HIGH'),
        row('sys-2', 'Meeting notes bot', 'MINIMAL'),
        row('sys-3', 'Intake draft A', 'UNCLASSIFIED'),
        row('sys-4', 'Intake draft B', 'UNCLASSIFIED'),
    ];

    it('reports the unclassified count separately in the header sentence', async () => {
        await renderRegister(MIXED);
        const description = headerDescription();

        // Every placeholder was resolved — a raw `{…}` left in the sentence
        // means an argument the catalogue asks for was never passed.
        expect(description).not.toContain('{');
        // All four are registered, one is high-risk, and the two provisional
        // entries are reported as exactly that — not folded into any tier.
        expect(description).toContain('4 AI systems registered');
        expect(description).toContain('· 1 high-risk');
        expect(description).toContain('· 2 not yet classified');
    });

    it('says nothing about unclassified systems when there are none — MINIMAL is not unclassified', async () => {
        // The pair for the case above: a MINIMAL system is classified, so a
        // register of classified systems carries no "not yet classified"
        // clause at all, rather than "· 0 not yet classified" or a count that
        // swept MINIMAL in.
        await renderRegister([
            row('sys-1', 'Resume screener', 'HIGH'),
            row('sys-2', 'Meeting notes bot', 'MINIMAL'),
        ]);
        const description = headerDescription();

        expect(description).toContain('2 AI systems registered');
        expect(description).not.toContain('{');
        expect(description).not.toContain('not yet classified');
    });

    it("tones an UNCLASSIFIED row's badge as a warning, never as MINIMAL's neutral", async () => {
        await renderRegister(MIXED);

        const minimal = tierBadge('sys-2', 'MINIMAL').className.split(' ');
        const unclassified = tierBadge('sys-3', 'UNCLASSIFIED').className.split(' ');

        // Positive anchor: MINIMAL really is the neutral badge, so the absence
        // below is measured against the tone it would have fallen back to.
        expect(minimal).toEqual(expect.arrayContaining(badgeClasses('neutral')));
        expect(unclassified).toEqual(expect.arrayContaining(badgeClasses('warning')));
        expect(unclassified).not.toEqual(expect.arrayContaining(badgeClasses('neutral')));
    });
});

// ─── The detail page ────────────────────────────────────────────────────────

function system(riskTier: string): AiSystemDetail {
    const classified = riskTier !== 'UNCLASSIFIED';
    return {
        id: 'sys-1',
        name: classified ? 'Credit scorer' : 'Intake draft A',
        provider: 'Acme Labs',
        deploymentRole: 'PROVIDER',
        riskTier,
        status: 'ACTIVE',
        purpose: null,
        useContext: null,
        classificationClauseId: classified ? 'annex-iii-5b' : null,
        classificationRationale: classified ? 'Creditworthiness evaluation of natural persons.' : null,
        requirementLinks: [],
    };
}

async function renderDetail(detail: AiSystemDetail) {
    routeParams.current = { tenantSlug: 'acme', systemId: detail.id };
    pathname.current = `/t/acme/risks/ai-systems/${detail.id}`;
    const view = render(
        <Wrapper>
            <AiSystemDetailClient system={detail} tenantSlug="acme" canWrite />
        </Wrapper>,
    );
    await waitFor(() => {
        expect(view.container.querySelector('[data-testid="page-header-title"]')).not.toBeNull();
    });
    await flush();
    return view;
}

describe('the detail page says an UNCLASSIFIED system is not classified', () => {
    it('renders the not-classified notice and header line, and no conformity card', async () => {
        const { container } = await renderDetail(system('UNCLASSIFIED'));

        // Positive anchor: the page rendered THIS system.
        expect(screen.getByTestId('page-header-title').textContent).toBe('Intake draft A');

        const notice = container.querySelector('#ai-system-not-classified');
        expect(notice).not.toBeNull();
        expect(notice?.textContent).toContain(AI.detail.notClassifiedNotice);

        // The header line states the absence of a classification, not
        // "UNCLASSIFIED risk · unclassified · Provider".
        const description = headerDescription();
        expect(description).toBe(AI.detail.notClassifiedLine.replace('{role}', AI.provider));
        expect(description).not.toMatch(/\brisk\b/);
        expect(description).not.toContain('MINIMAL');

        expect(screen.queryByText(AI.detail.conformityHeading)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Technical Documentation (Annex IV)' })).not.toBeInTheDocument();
    });

    it('a HIGH system gets the conformity card and the tier line, and no notice — the pair proves the branch', async () => {
        const { container } = await renderDetail(system('HIGH'));

        expect(screen.getByTestId('page-header-title').textContent).toBe('Credit scorer');
        expect(container.querySelector('#ai-system-not-classified')).toBeNull();
        expect(screen.queryByText(AI.detail.notClassifiedNotice)).not.toBeInTheDocument();

        expect(headerDescription()).toBe(
            AI.detail.metaLine
                .replace('{tier}', 'HIGH')
                .replace('{clause}', 'annex-iii-5b')
                .replace('{role}', AI.provider),
        );

        expect(screen.getByText(AI.detail.conformityHeading)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Technical Documentation (Annex IV)' })).toBeEnabled();
    });
});
