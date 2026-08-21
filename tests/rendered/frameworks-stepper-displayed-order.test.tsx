/**
 * #98 — the record stepper on the framework detail page, keyed by SLUG.
 *
 * Frameworks are the awkward member of the #107 cohort for two reasons, and
 * this suite exists because a structural test would miss both:
 *
 *   1. The detail route is `[frameworkKey]`, so the order must be over
 *      `Framework.key`, not `Framework.id`. The two are different strings on
 *      the same row — a publisher that emits ids while the page passes a slug
 *      produces `ids.indexOf(currentId) === -1`, and `EntityPrevNextNav`
 *      responds to that by rendering NOTHING. The failure mode is silence, so
 *      the assertions below are on the arrows existing and on where they
 *      actually navigate.
 *   2. `FrameworksClient` has no SWR read at all — the frameworks page is
 *      server-rendered and hands the client its rows as props. The publish
 *      hook takes rows, not a fetch, so the wiring is the same; but it means
 *      the ONLY thing that can put the displayed order in front of the detail
 *      page is the publish call.
 *
 * Both mounts share one SWR cache — separate React trees, exactly as list →
 * detail navigation produces.
 */
import * as React from 'react';
import { render, screen, fireEvent, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

// next-intl is ESM (jest cannot parse it); resolve real en.json values.
// Memoised per namespace — the global mock returns a fresh `t` per render,
// which makes page-level suites loop rather than fail.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
                }
            }
            return v;
        };
        t.rich = (key: string) => {
            const v = resolve(ns, key);
            return typeof v === 'string'
                ? v.replace(/<(\w+)>(.*?)<\/\1>/g, (_m: string, _tag: string, inner: string) => inner)
                : key;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

const mockReplace = jest.fn();
// `useParams` is load-bearing here, not boilerplate: the published order is
// stored under a TENANT-SCOPED cache key, so a mount without `tenantSlug`
// reads a different key than the one the list wrote.
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme', frameworkKey: 'NIS2' }),
    useRouter: () => ({
        push: jest.fn(),
        replace: (...args: unknown[]) => mockReplace(...args),
        refresh: jest.fn(),
    }),
    usePathname: () => '/t/acme/frameworks/NIS2',
    useSearchParams: () => new URLSearchParams(),
}));

const mockUseTenantSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => mockUseTenantSWR(...args),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    usePermissions: () => ({ frameworks: { install: true, view: true } }),
}));

import { FrameworksClient } from '@/app/t/[tenantSlug]/(app)/frameworks/FrameworksClient';
import FrameworkDetailPage from '@/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/page';
import { frameworkOrderKey } from '@/app/t/[tenantSlug]/(app)/frameworks/framework-order';
import { useEntityListIds } from '@/lib/hooks/use-entity-list-ids';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * `listFrameworks` order — what the server page renders and what the list
 * endpoint returns.
 *
 * The ids are deliberately unrelated to the keys (and sorted the other way),
 * so an `.id`-keyed order is not accidentally interchangeable with a
 * `.key`-keyed one anywhere below.
 */
const ROWS = [
    { id: 'fw_z', key: 'ISO27001', name: 'ISO/IEC 27001' },
    { id: 'fw_y', key: 'NIS2', name: 'NIS2 Directive' },
    { id: 'fw_x', key: 'ISO9001', name: 'ISO 9001' },
].map((fw) => ({
    ...fw,
    description: null,
    version: '2022',
    kind: 'SECURITY',
    metadataJson: null,
    _count: { requirements: 10, packs: 1 },
}));

const COVERAGES = Object.fromEntries(
    ROWS.map((fw) => [fw.key, { coveragePercent: 25, mapped: 5, total: 20 }]),
);

/** One cache shared by the list mount and the detail mount. */
function makeSharedCache() {
    const cache = new Map();
    return function Wrapper({ children }: { children: React.ReactNode }) {
        return (
            <SWRConfig value={{ provider: () => cache, shouldRetryOnError: false }}>
                <KeyboardShortcutProvider>
                    <TooltipProvider>{children}</TooltipProvider>
                </KeyboardShortcutProvider>
            </SWRConfig>
        );
    };
}

/** The four requests the detail page fires on mount. */
function installFetchMock() {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.endsWith('/tree')
            ? {
                  framework: {
                      id: 'fw_y',
                      key: 'NIS2',
                      name: 'NIS2 Directive',
                      version: '2022',
                      kind: 'SECURITY',
                      description: null,
                  },
                  nodes: [],
                  totals: { sections: 0, requirements: 0, maxDepth: 0 },
              }
            : url.includes('action=packs')
            ? []
            : url.includes('action=coverage')
            ? {
                  framework: { key: 'NIS2', name: 'NIS2 Directive', version: '2022' },
                  total: 20,
                  mapped: 5,
                  unmapped: 15,
                  coveragePercent: 25,
                  bySection: [],
                  unmappedRequirements: [],
                  controlMappings: [],
              }
            : {
                  id: 'fw_y',
                  key: 'NIS2',
                  name: 'NIS2 Directive',
                  version: '2022',
                  description: null,
                  kind: 'SECURITY',
                  _count: { requirements: 10, packs: 1 },
              };
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
}

/** The framework keys the list actually put on screen, read back from the DOM. */
function renderedKeys(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('[data-testid^="fw-card-"]')).map((el) =>
        (el.getAttribute('data-testid') ?? '').replace('fw-card-', ''),
    );
}

beforeEach(() => {
    mockReplace.mockReset();
    mockUseTenantSWR.mockReset();
    window.localStorage.clear();
    installFetchMock();
});

describe('frameworks stepper walks the displayed order, keyed by slug', () => {
    it('steps to the neighbouring framework KEY the list rendered', async () => {
        const Wrapper = makeSharedCache();
        // The fallback list read answers in the OPPOSITE order. A reader that
        // ignored what the list published would step ISO27001, not ISO9001.
        mockUseTenantSWR.mockImplementation((key: unknown) => ({
            data: key == null ? undefined : [...ROWS].reverse(),
            isLoading: false,
            error: null,
            mutate: jest.fn(),
        }));

        const { container } = render(
            <Wrapper>
                <FrameworksClient
                    frameworks={ROWS}
                    coverages={COVERAGES}
                    tenantSlug="acme"
                />
            </Wrapper>,
        );
        // Derived from the DOM, not restated as a literal: the claim is "the
        // stepper walks what is on screen", not "both equal a constant".
        const onScreen = renderedKeys(container);
        expect(onScreen).toEqual(['ISO27001', 'NIS2', 'ISO9001']);

        render(
            <Wrapper>
                <FrameworkDetailPage />
            </Wrapper>,
        );
        // Both arrows render — NIS2 sits in the middle of the displayed order.
        const nav = await screen.findByTestId('entity-prev-next-nav');
        expect(nav).toBeInTheDocument();

        const current = onScreen.indexOf('NIS2');
        fireEvent.click(screen.getByTestId('entity-nav-next'));
        expect(mockReplace).toHaveBeenCalledWith(`/t/acme/frameworks/${onScreen[current + 1]}`);

        mockReplace.mockReset();
        fireEvent.click(screen.getByTestId('entity-nav-prev'));
        expect(mockReplace).toHaveBeenCalledWith(`/t/acme/frameworks/${onScreen[current - 1]}`);
    });

    it('publishes slugs, not ids, so the reader can find the open framework', () => {
        const Wrapper = makeSharedCache();
        mockUseTenantSWR.mockImplementation(() => ({
            data: undefined,
            isLoading: false,
            error: null,
            mutate: jest.fn(),
        }));

        const { container } = render(
            <Wrapper>
                <FrameworksClient
                    frameworks={ROWS}
                    coverages={COVERAGES}
                    tenantSlug="acme"
                />
            </Wrapper>,
        );

        const { result } = renderHook(
            () =>
                useEntityListIds<{ key: string }>(CACHE_KEYS.frameworks.list(), {
                    getId: frameworkOrderKey,
                }),
            { wrapper: Wrapper },
        );
        expect(result.current).toEqual(renderedKeys(container));
        // Explicitly NOT the ids — the route cannot address those.
        expect(result.current).not.toContain('fw_y');
    });

    it('falls back to the list endpoint on a deep link, matching by slug', async () => {
        // Nobody rendered the list this session, so nothing is published. The
        // fallback read supplies rows whose `.id` is not what the route
        // carries — the read side's `getId` is what makes them addressable.
        const Wrapper = makeSharedCache();
        mockUseTenantSWR.mockImplementation((key: unknown) => ({
            data: key == null ? undefined : ROWS,
            isLoading: false,
            error: null,
            mutate: jest.fn(),
        }));

        render(
            <Wrapper>
                <FrameworkDetailPage />
            </Wrapper>,
        );
        await screen.findByTestId('entity-prev-next-nav');

        fireEvent.click(screen.getByTestId('entity-nav-next'));
        expect(mockReplace).toHaveBeenCalledWith('/t/acme/frameworks/ISO9001');
    });

    it('hides the arrows when there is no order to walk', async () => {
        // A cold cache with an empty list is not a degradation: stepping "the
        // order the list showed" is meaningless when there was no list.
        const Wrapper = makeSharedCache();
        mockUseTenantSWR.mockImplementation(() => ({
            data: [],
            isLoading: false,
            error: null,
            mutate: jest.fn(),
        }));

        render(
            <Wrapper>
                <FrameworkDetailPage />
            </Wrapper>,
        );
        // The page itself finished loading (the header title is up) — so an
        // absent nav is a decision, not a not-yet.
        await waitFor(() =>
            expect(screen.getByTestId('page-header-title')).toHaveTextContent(
                'NIS2 Directive',
            ),
        );
        await waitFor(() =>
            expect(screen.queryByTestId('entity-prev-next-nav')).not.toBeInTheDocument(),
        );
    });
});
