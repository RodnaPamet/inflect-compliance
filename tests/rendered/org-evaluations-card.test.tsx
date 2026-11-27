/**
 * THE ORG "EVALUATIONS" CARD SHOWS EACH NIGHTLY'S LIVE STATE, AND ONLY THE
 * OPERATOR'S OWNER GETS THE SWITCHES (owner decisions 2026-11-12, 2026-11-27).
 *
 *   1. All three evaluations are shown, each with an On/Off badge from the
 *      stored state and when it last changed ("never switched on" for none).
 *   2. A viewer the server says may switch (`canSwitch`) gets one switch per
 *      nightly, with its spending cap beside it; flipping one PUTs that one
 *      nightly and refreshes the page.
 *   3. Everybody else gets no control, a "held by the platform operator" line
 *      per nightly, and a read-only notice.
 *   4. Each links to its own workflow's runs page (external, no opener), and
 *      nothing names a repository variable any more.
 *   5. Each shows its schedule and its spending cap from the typed content.
 *
 * Rendered through the real catalogue, in English and Bulgarian, so a missing
 * Bulgarian key fails here rather than at runtime.
 */
import * as React from 'react';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The repo's global `next-intl` mock (`__mocks__/next-intl.js`) is English
 * only and flattens `.rich` to text. This one resolves against the catalogue
 * of the locale under test, throws on a missing key, and builds the `<code>`
 * elements.
 */
const mockCatalogue: { current: Record<string, unknown> } = { current: {} };
jest.mock('next-intl', () => {
    const resolve = (key: string): string => {
        const value = key
            .split('.')
            .reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                mockCatalogue.current,
            );
        if (typeof value !== 'string') throw new Error(`missing message: ${key}`);
        return value;
    };
    const fill = (str: string, params: Record<string, unknown> = {}) =>
        str.replace(/\{(\w+)\}/g, (m, name: string) => (typeof params[name] === 'string' ? (params[name] as string) : m));
    return {
        useTranslations: (namespace: string) => {
            const t = (key: string, params?: Record<string, unknown>) => fill(resolve(`${namespace}.${key}`), params);
            t.rich = (
                key: string,
                params: Record<string, unknown> & { code: (c: React.ReactNode) => React.ReactNode },
            ) => {
                const parts = fill(resolve(`${namespace}.${key}`), params).split(/<code>(.*?)<\/code>/);
                return parts.map((part, i) => (
                    <React.Fragment key={i}>{i % 2 === 1 ? params.code(part) : part}</React.Fragment>
                ));
            };
            return t;
        },
    };
});

const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ refresh: mockRefresh, push: jest.fn(), replace: jest.fn() }),
}));
jest.mock('@/lib/org-context-provider', () => ({
    useOrgApiUrl: () => (p: string) => `/api/org/acme${p}`,
}));

import EN from '../../messages/en.json';
import BG from '../../messages/bg.json';
import { OrgEvaluationsCard } from '@/app/org/[orgSlug]/(app)/settings/OrgEvaluationsCard';
import type { EvalNightlySwitches } from '@/app-layer/usecases/eval-nightly-switches';
import { dateFormattersFor } from '@inflect/ui/lib/format-date';

const KEYS = ['ragas', 'garak', 'inspect'] as const;

function switches(canSwitch: boolean, overrides: Partial<EvalNightlySwitches['nightlies']> = {}): EvalNightlySwitches {
    return {
        canSwitch,
        nightlies: {
            ragas: { enabled: false, changedAt: null },
            garak: { enabled: true, changedAt: '2026-11-27T09:30:00.000Z' },
            inspect: { enabled: false, changedAt: '2026-11-20T18:05:00.000Z' },
            ...overrides,
        },
    };
}

function renderCard(state: EvalNightlySwitches, locale: 'en' | 'bg' = 'en') {
    mockCatalogue.current = (locale === 'en' ? EN : BG) as unknown as Record<string, unknown>;
    const { formatDateTime } = dateFormattersFor(locale);
    return render(<OrgEvaluationsCard switches={state} formatDateTime={(iso) => formatDateTime(iso)} />);
}

const REPO = 'https://github.com/RodnaPamet/inflect-compliance';

afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
    mockRefresh.mockReset();
});

describe('OrgEvaluationsCard — state', () => {
    it('shows all three evaluations, each with its live state', () => {
        renderCard(switches(false));
        const card = screen.getByTestId('org-evaluations');
        expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent('Evaluations');
        expect(screen.getByTestId('org-evals-ragas')).toHaveTextContent('Ragas');
        expect(screen.getByTestId('org-evals-garak')).toHaveTextContent('garak');
        expect(screen.getByTestId('org-evals-inspect')).toHaveTextContent('Inspect');

        expect(screen.getByTestId('org-evals-garak-badge')).toHaveTextContent('On');
        expect(screen.getByTestId('org-evals-garak')).toHaveAttribute('data-enabled', 'true');
        expect(screen.getByTestId('org-evals-garak-since')).toHaveTextContent('On since 27 Nov 2026, 09:30 UTC');
        expect(screen.getByTestId('org-evals-inspect-badge')).toHaveTextContent('Off');
        expect(screen.getByTestId('org-evals-inspect-since')).toHaveTextContent('Off since 20 Nov 2026, 18:05 UTC');
        expect(screen.getByTestId('org-evals-ragas-badge')).toHaveTextContent('Off');
        expect(screen.getByTestId('org-evals-ragas-since')).toHaveTextContent('Off — never switched on');
    });

    it('names no repository variable any more', () => {
        renderCard(switches(true));
        const text = screen.getByTestId('org-evaluations').textContent ?? '';
        expect(text).not.toMatch(/GARAK_ENABLED|RAG_EVAL_ENABLED|AGENT_EVALS_ENABLED|Repository variable/);
    });
});

describe('OrgEvaluationsCard — who switches', () => {
    it('gives a viewer who may switch one switch per nightly, each with its cap beside it', () => {
        renderCard(switches(true));
        expect(screen.queryByTestId('org-evals-read-only')).toBeNull();
        for (const key of KEYS) {
            const toggle = screen.getByTestId(`org-evals-${key}-toggle`);
            expect(toggle).toHaveAttribute('role', 'switch');
        }
        expect(screen.getByTestId('org-evals-garak-toggle')).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByTestId('org-evals-ragas-toggle')).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByTestId('org-evals-ragas-switch')).toHaveTextContent('While on, it may spend: USD 4 a night');
        expect(screen.getByTestId('org-evals-garak-switch')).toHaveTextContent('USD 2.50 a night');
    });

    it('turning a nightly on PUTs that one nightly, shows the saved state, and refreshes', async () => {
        const user = userEvent.setup();
        const calls: Array<{ url: string; init: RequestInit }> = [];
        (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return {
                ok: true,
                status: 200,
                json: async () => ({ switches: switches(true, { ragas: { enabled: true, changedAt: '2026-11-27T10:00:00.000Z' } }) }),
            };
        }) as unknown as typeof fetch;

        renderCard(switches(true));
        await user.click(screen.getByTestId('org-evals-ragas-toggle'));

        await waitFor(() => expect(screen.getByTestId('org-evals-ragas-toggle')).toHaveAttribute('aria-checked', 'true'));
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('/api/org/acme/eval-nightlies');
        expect(calls[0].init.method).toBe('PUT');
        expect(JSON.parse(String(calls[0].init.body))).toEqual({ nightly: 'ragas', enabled: true });
        expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('a refused switch stays where it was and says why', async () => {
        const user = userEvent.setup();
        (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({
            ok: false,
            status: 403,
            json: async () => ({ error: { message: 'The evaluation nightlies are switched by the platform operator.' } }),
        })) as unknown as typeof fetch;

        renderCard(switches(true));
        await user.click(screen.getByTestId('org-evals-garak-toggle'));

        expect(await screen.findByTestId('org-evals-garak-toggle-error')).toHaveTextContent('switched by the platform operator');
        expect(screen.getByTestId('org-evals-garak-toggle')).toHaveAttribute('aria-checked', 'true');
        expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('gives everybody else no control, the operator line, and a read-only notice', () => {
        renderCard(switches(false));
        expect(screen.getByTestId('org-evals-read-only')).toHaveTextContent(
            "Only an owner of the platform operator's organization can switch one on or off.",
        );
        for (const key of KEYS) {
            expect(screen.queryByTestId(`org-evals-${key}-toggle`)).toBeNull();
            expect(screen.getByTestId(`org-evals-${key}-switch`)).toHaveTextContent('Held by the platform operator');
        }
        expect(screen.queryByRole('switch')).toBeNull();
    });
});

describe('OrgEvaluationsCard — facts and links', () => {
    it('links to each workflow run page, opening apart from the app', () => {
        renderCard(switches(false));
        const links: Array<[string, string]> = [
            ['org-evals-ragas-runs-link', `${REPO}/actions/workflows/rag-eval.yml`],
            ['org-evals-garak-runs-link', `${REPO}/actions/workflows/garak.yml`],
            ['org-evals-inspect-runs-link', `${REPO}/actions/workflows/agent-evals.yml`],
        ];
        for (const [testId, href] of links) {
            const a = screen.getByTestId(testId);
            expect(a).toHaveAttribute('href', href);
            expect(a).toHaveAttribute('target', '_blank');
            expect(a.getAttribute('rel')).toContain('noopener');
        }
    });

    // #5924: each link is a line of its own, 17px of text, so on a phone it
    // answers a 44px square; and the name and its badge wrap, where at 360px
    // the badge used to run past the screen edge.
    it('gives each link a touch square, and lets an entry’s badge wrap under its name', () => {
        renderCard(switches(false), 'bg');
        for (const key of KEYS) {
            expect(screen.getByTestId(`org-evals-${key}-runs-link`).className.split(/\s+/)).toEqual(
                expect.arrayContaining(['relative', 'pointer-coarse:after:min-h-11', 'pointer-coarse:after:min-w-11']),
            );
            const row = screen.getByTestId(`org-evals-${key}-badge`).closest('div.flex');
            expect(row?.className.split(/\s+/)).toContain('flex-wrap');
        }
    });

    it('shows each schedule and spending cap', () => {
        renderCard(switches(false));
        const ragas = screen.getByTestId('org-evals-ragas');
        expect(ragas).toHaveTextContent('00:40 UTC');
        expect(ragas).toHaveTextContent('USD 4 a night');
        expect(ragas).toHaveTextContent('USD 6.50 nightly cap shared with the garak evaluation');
        expect(ragas).toHaveTextContent('D-EV-11');
        expect(ragas).toHaveTextContent('RAGAS_ANTHROPIC_API_KEY');
        const garak = screen.getByTestId('org-evals-garak');
        expect(garak).toHaveTextContent('01:15 UTC');
        expect(garak).toHaveTextContent('USD 2.50 a night');
        expect(garak).toHaveTextContent('USD 6.50 nightly cap');
        expect(garak).toHaveTextContent('D-EV-11');
        expect(garak).toHaveTextContent('GARAK_CI_ANTHROPIC_KEY');
        const inspect = screen.getByTestId('org-evals-inspect');
        expect(inspect).toHaveTextContent('02:20 UTC');
        expect(inspect).toHaveTextContent('USD 10 a night');
        expect(inspect).toHaveTextContent('D-EV-6');
        expect(inspect).toHaveTextContent('INSPECT_CI_ANTHROPIC_KEY');
        expect(screen.getByTestId('org-evaluations')).toHaveTextContent('ANTHROPIC_API_KEY');
    });

    it('renders every string in Bulgarian too, for both audiences', () => {
        renderCard(switches(false), 'bg');
        expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Оценки');
        expect(screen.getByTestId('org-evals-inspect')).toHaveTextContent('10 USD');
        expect(screen.getByTestId('org-evals-garak-badge')).toHaveTextContent('Включено');
        expect(screen.getByTestId('org-evals-ragas-since')).toHaveTextContent('никога не е включвано');
        // The date in the reader's language, from the helper the page passes.
        expect(screen.getByTestId('org-evals-garak-since')).toHaveTextContent('Включено от 27 ное 2026, 09:30 UTC');
        expect(screen.getByTestId('org-evals-garak-switch')).toHaveTextContent('оператора на платформата');
    });

    it('renders the switches in Bulgarian', () => {
        renderCard(switches(true), 'bg');
        expect(screen.getByTestId('org-evals-ragas-switch')).toHaveTextContent('Докато е включена, може да изразходва');
    });
});
