/**
 * THE ORG "EVALUATIONS" CARD DESCRIBES BOTH NIGHTLIES (owner decision 2026-11-12).
 *
 *   1. Both evaluations are shown, each marked off by default.
 *   2. Each names the repository variable that switches it, and the value.
 *   3. Each links to its own workflow's runs page, and the card links to the
 *      repository's Actions variables page — external links that open apart
 *      from the app and pass it no opener.
 *   4. Each shows its schedule and its spending cap from the typed content.
 *
 * Rendered through the real catalogue, in English and Bulgarian, so a missing
 * Bulgarian key fails here rather than at runtime.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

/**
 * The repo's global `next-intl` mock (`__mocks__/next-intl.js`) is English
 * only and flattens `.rich` to text. This one resolves against the catalogue
 * of the locale under test, throws on a missing key, and builds the `<code>`
 * elements, so the test sees that a variable name renders as code and that
 * every Bulgarian key resolves.
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

import EN from '../../messages/en.json';
import BG from '../../messages/bg.json';
import { OrgEvaluationsCard } from '@/app/org/[orgSlug]/(app)/settings/OrgEvaluationsCard';

function renderCard(locale: 'en' | 'bg' = 'en') {
    mockCatalogue.current = (locale === 'en' ? EN : BG) as unknown as Record<string, unknown>;
    return render(<OrgEvaluationsCard />);
}

const REPO = 'https://github.com/RodnaPamet/inflect-compliance';

describe('OrgEvaluationsCard', () => {
    it('shows both evaluations, each off by default', () => {
        renderCard();
        const card = screen.getByTestId('org-evaluations');
        expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent('Evaluations');
        for (const key of ['garak', 'inspect']) {
            const entry = screen.getByTestId(`org-evals-${key}`);
            expect(entry).toHaveTextContent('Off by default');
        }
        expect(screen.getByTestId('org-evals-garak')).toHaveTextContent('garak');
        expect(screen.getByTestId('org-evals-inspect')).toHaveTextContent('Inspect');
    });

    it('names each switch variable and the value that turns it on', () => {
        renderCard();
        const garak = screen.getByTestId('org-evals-garak-switch');
        expect(within(garak).getByText('GARAK_ENABLED').tagName).toBe('CODE');
        expect(garak).toHaveTextContent('Repository variable GARAK_ENABLED set to true');
        const inspect = screen.getByTestId('org-evals-inspect-switch');
        expect(within(inspect).getByText('AGENT_EVALS_ENABLED').tagName).toBe('CODE');
        expect(inspect).toHaveTextContent('Repository variable AGENT_EVALS_ENABLED set to true');
    });

    it('links to each workflow run page and to the Actions variables page', () => {
        renderCard();
        const links: Array<[string, string]> = [
            ['org-evals-garak-runs-link', `${REPO}/actions/workflows/garak.yml`],
            ['org-evals-inspect-runs-link', `${REPO}/actions/workflows/agent-evals.yml`],
            ['org-evals-variables-link', `${REPO}/settings/variables/actions`],
        ];
        for (const [testId, href] of links) {
            const a = screen.getByTestId(testId);
            expect(a).toHaveAttribute('href', href);
            expect(a).toHaveAttribute('target', '_blank');
            expect(a.getAttribute('rel')).toContain('noopener');
        }
    });

    it('shows each schedule and spending cap', () => {
        renderCard();
        const garak = screen.getByTestId('org-evals-garak');
        expect(garak).toHaveTextContent('01:15 UTC');
        expect(garak).toHaveTextContent('USD 2.50 a night');
        expect(garak).toHaveTextContent('USD 5 nightly cap');
        expect(garak).toHaveTextContent('D-EV-11');
        expect(garak).toHaveTextContent('GARAK_CI_ANTHROPIC_KEY');
        const inspect = screen.getByTestId('org-evals-inspect');
        expect(inspect).toHaveTextContent('02:20 UTC');
        expect(inspect).toHaveTextContent('USD 10 a night');
        expect(inspect).toHaveTextContent('D-EV-6');
        expect(inspect).toHaveTextContent('INSPECT_CI_ANTHROPIC_KEY');
        expect(screen.getByTestId('org-evaluations')).toHaveTextContent('ANTHROPIC_API_KEY');
    });

    it('renders every string in Bulgarian too', () => {
        renderCard('bg');
        expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Оценки');
        expect(screen.getByTestId('org-evals-garak-switch')).toHaveTextContent('GARAK_ENABLED');
        expect(screen.getByTestId('org-evals-inspect')).toHaveTextContent('10 USD');
    });
});
