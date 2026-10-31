/**
 * The NIS2 self-assessment step outside the wizard (#4734).
 *
 *   - A completed run is shown read-only, with the way to a new run, and its
 *     button continues instead of completing again.
 *   - Without the wizard's skip there is no "Skip for now": it used to render
 *     on the resume page and do nothing.
 *   - The wizard's "You selected NIS2" introduction can be left out.
 */
import { fireEvent, render, screen } from '@testing-library/react';

// The shared next-intl mock builds a new translator on every call. The real
// one is stable per namespace, and the step's load callback depends on it, so
// an unstable one re-runs the load on every render.
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

import { Nis2SelfAssessmentStep } from '@/components/onboarding/Nis2SelfAssessmentStep';

const EN = jest.requireActual('../../messages/en.json') as {
    onboarding: { nis2Step: Record<string, string> };
};
const tn = EN.onboarding.nis2Step;

function state(status: string) {
    return {
        assessmentId: 'run_1',
        status,
        domains: [{ id: 1, code: 'GOV', name: { en: 'Governance', de: 'Governance' }, day: 1 }],
        questions: [{
            id: 'gap-1-01',
            domainId: 1,
            text: { en: 'Is there a security policy?', de: 'Gibt es eine Richtlinie?' },
            plainText: { en: 'Security policy', de: 'Richtlinie' },
            legalBasis: 'Art. 21',
            criticality: 'HIGH',
            respondent: 'CEO',
            consequence: 'FINE',
            fineExposure: true,
            timeToFix: 'WEEKS',
            day: 1,
            dependsOn: [],
        }],
        answers: [{ questionId: 'gap-1-01', answer: 'YES', note: null }],
        progress: { answered: 1, total: 1 },
    };
}

beforeEach(() => {
    global.fetch = jest.fn() as unknown as typeof fetch;
});

function load(status: string) {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200, json: async () => state(status) });
}

describe('Nis2SelfAssessmentStep', () => {
    it('shows a completed run read-only and offers a new run instead', async () => {
        load('COMPLETED');
        render(<Nis2SelfAssessmentStep tenantSlug="acme" onCompleted={jest.fn()} showIntro={false} />);

        expect(await screen.findByText(tn.finalisedTitle)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: tn.openGapPage })).toHaveAttribute('href', '/t/acme/audits/nis2-gap');
        fireEvent.click(screen.getByRole('button', { name: /Governance/ }));
        const radios = await screen.findAllByRole('radio');
        expect(radios.length).toBeGreaterThan(0);
        for (const radio of radios) expect(radio).toBeDisabled();
        expect(screen.getByRole('button', { name: tn.continue })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: tn.complete })).toBeNull();
    });

    it('offers no skip when the page has none to give, and leaves out the wizard introduction', async () => {
        load('IN_PROGRESS');
        render(<Nis2SelfAssessmentStep tenantSlug="acme" onCompleted={jest.fn()} showIntro={false} />);

        expect(await screen.findByRole('button', { name: tn.complete })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: tn.skipForNow })).toBeNull();
        expect(screen.queryByText(tn.intro)).toBeNull();
        expect(screen.queryByText(tn.finalisedTitle)).toBeNull();
    });

    it('keeps the skip and the introduction in the wizard', async () => {
        load('IN_PROGRESS');
        render(<Nis2SelfAssessmentStep tenantSlug="acme" onCompleted={jest.fn()} onSkip={jest.fn()} />);

        expect(await screen.findByRole('button', { name: tn.skipForNow })).toBeInTheDocument();
        expect(screen.getByText(tn.intro)).toBeInTheDocument();
    });
});
