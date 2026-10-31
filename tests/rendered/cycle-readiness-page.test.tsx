/**
 * The cycle readiness page words what the scorer reports, and leads to it (#4728).
 *
 *   - Recommendations and gap details come as codes and are translated here;
 *     the generic profile no longer sends a configuration note.
 *   - Each gap links to the thing it names.
 *   - A missing cycle says so; any other failure offers a retry.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme', cycleId: 'c1' }),
    useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/audits/cycles/c1/readiness',
    useSearchParams: () => new URLSearchParams(),
}));

// The shared next-intl mock builds a new translator on every call; give each
// namespace one, as the real library does, so effects keyed on it settle.
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

import CycleReadinessPage from '@/app/t/[tenantSlug]/(app)/audits/cycles/[cycleId]/readiness/page';

const EN = jest.requireActual('../../messages/en.json') as {
    audits: { readiness: Record<string, string> & { rec: Record<string, string>; gap: Record<string, string> } };
};
const R = EN.audits.readiness;

const result = {
    frameworkKey: 'SOC2',
    frameworkName: 'SOC 2',
    score: 42,
    breakdown: {
        coverage: { score: 40, weight: 0.5, mapped: 2, total: 5 },
        evidence: { score: 50, weight: 0.35, withEvidence: 1, total: 2 },
        issues: { score: 100, weight: 0.15, open: 0 },
    },
    gaps: [
        { type: 'UNMAPPED_REQUIREMENT', severity: 'HIGH', title: 'CC6.1: Logical access', details: 'Not mapped to any control', detail: { code: 'NOT_MAPPED' }, entityId: 'req1' },
        { type: 'MISSING_EVIDENCE', severity: 'MEDIUM', title: 'AC-1: Access policy', details: 'No active evidence attached', detail: { code: 'NO_EVIDENCE' }, entityId: 'ctl1' },
    ],
    recommendations: ["Map more of the framework's requirements to controls — coverage is below 50%"],
    recommendationCodes: [{ code: 'GENERIC_COVERAGE_LOW' }],
    computedAt: '2026-10-31T00:00:00.000Z',
};

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function serve(readiness: () => ReturnType<typeof reply>) {
    global.fetch = jest.fn(async (url: string) => {
        if (url.endsWith('/readiness')) return readiness();
        if (url.includes('action=history')) return reply(200, { snapshots: [] });
        return reply(200, { name: 'SOC 2 Type II 2026' });
    }) as unknown as typeof fetch;
}

describe('cycle readiness page', () => {
    it('translates the advice and the gaps, and links each gap to what it names', async () => {
        serve(() => reply(200, result));
        render(<CycleReadinessPage />);

        expect(await screen.findByText(R.rec.GENERIC_COVERAGE_LOW)).toBeInTheDocument();
        expect(screen.queryByText(/readinessWeightsJson/)).toBeNull();
        expect(screen.getByText(R.gap.notMapped)).toBeInTheDocument();
        expect(screen.getByText(R.gap.evidenceMissing)).toBeInTheDocument();

        const links = screen.getAllByTestId('readiness-gap-link').map((a) => a.getAttribute('href'));
        expect(links).toEqual(['/t/acme/frameworks/SOC2', '/t/acme/controls/ctl1']);
        expect(screen.getByText(R.frameworkReadiness.replace('{framework}', 'SOC 2'))).toBeInTheDocument();
    });

    it('says the cycle is gone when it is, with no retry', async () => {
        serve(() => reply(404, { error: { message: 'Audit cycle not found' } }));
        render(<CycleReadinessPage />);

        expect(await screen.findByText(R.notFound)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: R.retry })).toBeNull();
    });

    it('offers a retry when the score could not be worked out, and recovers', async () => {
        let calls = 0;
        serve(() => (calls++ === 0 ? reply(500, {}) : reply(200, result)));
        render(<CycleReadinessPage />);

        fireEvent.click(await screen.findByRole('button', { name: R.retry }));
        await waitFor(() => expect(screen.getByText(R.rec.GENERIC_COVERAGE_LOW)).toBeInTheDocument());
    });
});
