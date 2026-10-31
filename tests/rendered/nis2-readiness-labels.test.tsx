/** @jest-environment jsdom */

/**
 * The NIS2 readiness page words what it shows, and offers only what the
 * server allows (#4733).
 *
 *   - Criticality, answer, priority and effort are worded, not printed as
 *     stored (`CRITICAL`, `PARTIALLY`, `URGENT`, `WEEKS`).
 *   - A reader in another language is told once that the questions are in
 *     English.
 *   - "Create findings + tasks" is not offered to a role the server refuses,
 *     and says why it is greyed out when there is nothing to create.
 *   - A failed load offers a retry.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

let locale = 'en';
jest.mock('next-intl', () => {
    const shared = jest.requireActual('../../__mocks__/next-intl.js');
    const translators = new Map<string, unknown>();
    return {
        ...shared,
        useLocale: () => locale,
        useTranslations: (ns: string) => {
            if (!translators.has(ns)) translators.set(ns, shared.useTranslations(ns));
            return translators.get(ns);
        },
    };
});

let canWrite = true;
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({ permissions: { canRead: true, canWrite, canAdmin: false, canAudit: false, canExport: false } }),
}));

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/frameworks/NIS2/readiness',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme', frameworkKey: 'NIS2' }),
}));

import { Nis2ReadinessClient } from '@/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/readiness/Nis2ReadinessClient';

const EN = jest.requireActual('../../messages/en.json') as {
    frameworks: { readiness: Record<string, string> & Record<'criticality' | 'answer' | 'priorityTier' | 'timeToFix', Record<string, string>> };
};
const R = EN.frameworks.readiness;

const gap = (criticality: string) => ({
    questionId: `q-${criticality}`,
    domainId: 1,
    criticality,
    consequence: 'FINE',
    fineExposure: true,
    timeToFix: 'WEEKS',
    legalBasis: 'Art. 21(2)(a)',
    answer: 'PARTIALLY',
    priority: 55,
    priorityTier: 'URGENT',
    plainText: { en: `Gap ${criticality}`, de: `Lücke ${criticality}` },
});
const payload = (gaps: ReturnType<typeof gap>[]) => ({
    readiness: {
        score: { overall: 40, byDomain: [{ domainId: 1, code: 'GOV', name: { en: 'Governance', de: 'Steuerung' }, score: 40, answered: 3, total: 5 }] },
        gaps,
        fineExposureGaps: gaps.length,
        answeredTotal: 3,
        questionTotal: 5,
    },
    snapshots: [],
    focusAreas: [],
});

const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
let readinessReply: () => ReturnType<typeof reply>;

beforeEach(() => {
    locale = 'en';
    canWrite = true;
    readinessReply = () => reply(200, payload([gap('CRITICAL')]));
    global.fetch = jest.fn(async () => readinessReply()) as unknown as typeof fetch;
});

describe('NIS2 readiness page', () => {
    it('words criticality, answer, priority and effort', async () => {
        render(<Nis2ReadinessClient tenantSlug="acme" />);
        await screen.findByText('Gap CRITICAL');
        for (const word of [R.criticality.CRITICAL, R.answer.PARTIALLY, R.priorityTier.URGENT, R.timeToFix.WEEKS]) {
            expect(screen.getAllByText(word).length).toBeGreaterThan(0);
        }
        for (const raw of ['CRITICAL', 'PARTIALLY', 'URGENT', 'WEEKS']) {
            expect(screen.queryByText(raw)).toBeNull();
        }
        expect(document.getElementById('nis2-readiness-english-note')).toBeNull();
    });

    it('tells a reader in another language that the questions are in English, and shows them in English', async () => {
        locale = 'bg';
        render(<Nis2ReadinessClient tenantSlug="acme" />);
        expect(await screen.findByText('Gap CRITICAL')).toBeInTheDocument();
        expect(screen.queryByText('Lücke CRITICAL')).toBeNull();
        expect(document.getElementById('nis2-readiness-english-note')).toHaveTextContent(R.questionsInEnglish);
    });

    it('does not offer findings to a role the server refuses, and says who can', async () => {
        canWrite = false;
        render(<Nis2ReadinessClient tenantSlug="acme" />);
        await screen.findByText('Gap CRITICAL');
        expect(document.getElementById('nis2-create-findings-btn')).toBeNull();
        expect(document.getElementById('nis2-create-findings-restricted')).toHaveTextContent(R.createRestricted);
    });

    it('says why the button is greyed out when no gap is high or critical', async () => {
        readinessReply = () => reply(200, payload([gap('LOW')]));
        render(<Nis2ReadinessClient tenantSlug="acme" />);
        await screen.findByText('Gap LOW');
        expect((document.getElementById('nis2-create-findings-btn') as HTMLButtonElement).disabled).toBe(true);
        expect(document.getElementById('nis2-create-findings-none')).toHaveTextContent(R.createFindingsNone);
    });

    it('offers a retry when the page could not load, and recovers', async () => {
        let calls = 0;
        readinessReply = () => (calls++ === 0 ? reply(500, {}) : reply(200, payload([gap('CRITICAL')])));
        render(<Nis2ReadinessClient tenantSlug="acme" />);
        expect(await screen.findByText(R.loadFailed)).toBeInTheDocument();
        const retry = screen.getByRole('button', { name: R.retry });
        await act(async () => { fireEvent.click(retry); });
        await waitFor(() => expect(screen.getByText('Gap CRITICAL')).toBeInTheDocument());
    });
});
