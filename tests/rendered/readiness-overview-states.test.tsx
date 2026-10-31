/**
 * The readiness overview shows each cycle's score and says when a read
 * failed, instead of showing "nothing yet" (#4729).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// A stable translator per namespace, as next-intl gives, so effects settle.
jest.mock('next-intl', () => {
    const shared = jest.requireActual('../../__mocks__/next-intl.js');
    const translators = new Map<string, unknown>();
    return {
        ...shared,
        useTranslations: (ns: string) => {
            if (!translators.has(ns)) translators.set(ns, shared.useTranslations(ns));
            return translators.get(ns);
        },
    };
});

import { ReadinessOverviewClient } from '@/app/t/[tenantSlug]/(app)/audits/readiness/ReadinessOverviewClient';

const EN = jest.requireActual('../../messages/en.json') as { audits: { overview: Record<string, string> } };
const O = EN.audits.overview;

const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const overview = {
    cycles: [{ id: 'c1', name: 'SOC 2 FY26', frameworkKey: 'SOC2', frameworkName: 'SOC 2', status: 'PLANNING' }],
    scoresByCycleId: { c1: { score: 63 } },
};

function serve(coverage: () => ReturnType<typeof reply>) {
    global.fetch = jest.fn(async (url: string) => {
        if (url.endsWith('/audits/readiness/overview')) return coverage();
        if (url.endsWith('/tests/readiness')) return reply(200, []);
        return reply(200, { latest: null });
    }) as unknown as typeof fetch;
}

describe('readiness overview', () => {
    it("shows each cycle's coverage score and its framework's name", async () => {
        serve(() => reply(200, overview));
        render(<ReadinessOverviewClient tenantSlug="acme" />);

        const row = await screen.findByTestId('overview-coverage-row');
        expect(row).toHaveTextContent('SOC 2 FY26');
        expect(row).toHaveTextContent('· SOC 2');
        expect(row).not.toHaveTextContent('SOC2');
        expect(row).toHaveTextContent(O.coverageScore.replace('{pct}', '63'));
        expect(row).toHaveAttribute('href', '/t/acme/audits/cycles/c1/readiness');
    });

    it('says the read failed rather than that there are no cycles, and recovers on retry', async () => {
        let calls = 0;
        serve(() => (calls++ === 0 ? reply(500, {}) : reply(200, overview)));
        render(<ReadinessOverviewClient tenantSlug="acme" />);

        expect(await screen.findByText(O.loadFailed)).toBeInTheDocument();
        expect(screen.queryByText(O.coverageEmpty)).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: O.retry }));
        await waitFor(() => expect(screen.getByTestId('overview-coverage-row')).toBeInTheDocument());
    });

    it('shows a loading state, not the empty state, while it reads', () => {
        global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
        render(<ReadinessOverviewClient tenantSlug="acme" />);

        expect(screen.getAllByText(O.loading).length).toBeGreaterThan(0);
        expect(screen.queryByText(O.coverageEmpty)).toBeNull();
        expect(screen.queryByText(O.testEmpty)).toBeNull();
    });
});
