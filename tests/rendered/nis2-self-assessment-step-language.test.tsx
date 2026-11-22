/**
 * The NIS2 self-assessment step shows the questions in the reader's language
 * (#5764), by the same rule as the readiness page.
 *
 * The step picked German, else English, so a Bulgarian reader read the
 * questions in English there while the readiness page showed them in
 * Bulgarian. A text with no Bulgarian translation (the legalese `text`) falls
 * back to English, never to German.
 */
import { fireEvent, render, screen } from '@testing-library/react';

let mockLocale = 'bg';

// The shared next-intl mock builds a new translator on every call. The real
// one is stable per namespace, and the step's load callback depends on it, so
// an unstable one re-runs the load on every render.
jest.mock('next-intl', () => {
    const shared = jest.requireActual('../../__mocks__/next-intl.js');
    const translators = new Map<string, unknown>();
    return {
        ...shared,
        useLocale: () => mockLocale,
        useTranslations: (ns: string) => {
            if (!translators.has(ns)) translators.set(ns, shared.useTranslations(ns));
            return translators.get(ns);
        },
    };
});

import { Nis2SelfAssessmentStep } from '@/components/onboarding/Nis2SelfAssessmentStep';

function state() {
    return {
        assessmentId: 'run_1',
        status: 'IN_PROGRESS',
        domains: [{ id: 1, code: 'GOV', name: { en: 'Governance EN', de: 'Steuerung DE', bg: 'Управление BG' }, day: 1 }],
        questions: [{
            id: 'gap-1-01',
            domainId: 1,
            text: { en: 'Regulator wording EN', de: 'Behördenwortlaut DE' },
            plainText: { en: 'Security policy EN', de: 'Richtlinie DE', bg: 'Политика за сигурност BG' },
            legalBasis: 'Art. 21',
            criticality: 'HIGH',
            respondent: 'CEO',
            consequence: 'FINE',
            fineExposure: true,
            timeToFix: 'WEEKS',
            day: 1,
            dependsOn: [],
        }],
        answers: [],
        progress: { answered: 0, total: 1 },
    };
}

beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => state() }) as unknown as typeof fetch;
});

describe('Nis2SelfAssessmentStep — question language', () => {
    it('shows a Bulgarian reader the Bulgarian domain name and question', async () => {
        mockLocale = 'bg';
        render(<Nis2SelfAssessmentStep tenantSlug="acme" showIntro={false} />);

        fireEvent.click(await screen.findByRole('button', { name: /Управление BG/ }));
        expect(await screen.findByText('Политика за сигурност BG')).toBeInTheDocument();
        expect(screen.queryByText('Governance EN')).toBeNull();
        expect(screen.queryByText('Security policy EN')).toBeNull();
    });

    it('shows an English reader English, never German', async () => {
        mockLocale = 'en';
        render(<Nis2SelfAssessmentStep tenantSlug="acme" showIntro={false} />);

        fireEvent.click(await screen.findByRole('button', { name: /Governance EN/ }));
        expect(await screen.findByText('Security policy EN')).toBeInTheDocument();
        expect(screen.queryByText('Richtlinie DE')).toBeNull();
    });

    it('falls back to English, not German, for a reader of a language the bank does not carry', async () => {
        mockLocale = 'de';
        render(<Nis2SelfAssessmentStep tenantSlug="acme" showIntro={false} />);

        fireEvent.click(await screen.findByRole('button', { name: /Governance EN/ }));
        expect(await screen.findByText('Security policy EN')).toBeInTheDocument();
        expect(screen.queryByText('Richtlinie DE')).toBeNull();
        expect(screen.queryByText('Steuerung DE')).toBeNull();
    });
});
