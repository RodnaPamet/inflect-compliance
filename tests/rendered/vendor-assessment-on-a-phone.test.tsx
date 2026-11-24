/**
 * The public vendor questionnaire answers a respondent on a phone (#5896).
 *
 * On a 4,700 px form the errors were listed only at the top, out of sight, so
 * Submit appeared to do nothing. Now: a required question left empty is named
 * under the question, the page goes to the first one and focuses it, the
 * choices are 44 px rows, a progress count says how far along the form is,
 * and the submit bar stays on screen on a phone.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import { VendorAssessmentClient } from '@/app/vendor-assessment/[assessmentId]/VendorAssessmentClient';

const EN = jest.requireActual('../../messages/en.json') as Record<string, unknown>;
const T = (EN.external as { vendorAssessment: Record<string, string> }).vendorAssessment;

const q = (id: string, answerType: string, required = true, optionsJson: unknown = null) => ({
    id,
    sortOrder: 0,
    prompt: `Question ${id}`,
    helpText: null,
    answerType,
    required,
    weight: 1,
    optionsJson,
    scaleConfigJson: null,
});

const LOAD = {
    assessmentId: 'a1',
    status: 'SENT',
    expiresAtIso: null,
    vendor: { name: 'Acme' },
    template: {
        name: 'Security',
        description: null,
        sections: [
            {
                id: 's1',
                sortOrder: 0,
                title: 'Basics',
                description: null,
                questions: [
                    q('mfa', 'YES_NO'),
                    q('hosting', 'SINGLE_SELECT', true, [
                        { label: 'Cloud', value: 'cloud' },
                        { label: 'On premises', value: 'onprem' },
                    ]),
                    q('notes', 'TEXT', false),
                ],
            },
        ],
    },
    answers: [],
};

const fetchMock = jest.fn();
const scrollIntoView = jest.fn();
beforeAll(() => {
    Element.prototype.scrollIntoView = scrollIntoView;
});
beforeEach(() => {
    scrollIntoView.mockClear();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST'
            ? ({ ok: true, status: 200, json: async () => ({ ok: true }) } as Response)
            : ({ ok: true, status: 200, json: async () => LOAD } as Response),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
});

async function renderForm() {
    render(
        <NextIntlClientProvider locale="en" messages={EN}>
            <VendorAssessmentClient assessmentId="a1" initialToken="tok" />
        </NextIntlClientProvider>,
    );
    await screen.findByTestId('vendor-assessment-form');
}

const posts = () => fetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST');
const progress = () => screen.getByTestId('vendor-assessment-progress');
const fmt = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k]));

describe('a required question left empty', () => {
    it('is named under the question, scrolled to and focused, and nothing is sent', async () => {
        await renderForm();
        // Answer the first required question, leave the second.
        fireEvent.click(within(screen.getByTestId('q-mfa')).getByRole('radio', { name: 'Yes' }));
        await act(async () => {
            fireEvent.click(screen.getByTestId('vendor-assessment-submit-btn'));
        });

        expect(posts()).toHaveLength(0);
        const error = screen.getByTestId('q-hosting-error');
        expect(error).toHaveTextContent(T.answerRequired);
        expect(screen.queryByTestId('q-mfa-error')).toBeNull();
        // The question's controls point at its error.
        expect(within(screen.getByTestId('q-hosting')).getByRole('radiogroup')).toHaveAttribute(
            'aria-describedby',
            error.id,
        );
        // The summary counts, and the page goes to the question.
        expect(screen.getByTestId('vendor-assessment-submit-errors')).toHaveTextContent(
            fmt(T.questionsToFix, { count: 1 }),
        );
        await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
        expect(scrollIntoView.mock.contexts.at(-1)).toBe(document.getElementById('question-hosting'));
        expect(screen.getByTestId('q-hosting').contains(document.activeElement)).toBe(true);
    });

    it('loses its error once answered, and the form then submits', async () => {
        await renderForm();
        fireEvent.click(within(screen.getByTestId('q-mfa')).getByRole('radio', { name: 'No' }));
        await act(async () => {
            fireEvent.click(screen.getByTestId('vendor-assessment-submit-btn'));
        });
        expect(screen.getByTestId('q-hosting-error')).toBeInTheDocument();

        fireEvent.click(within(screen.getByTestId('q-hosting')).getByRole('radio', { name: 'Cloud' }));
        expect(screen.queryByTestId('q-hosting-error')).toBeNull();

        await act(async () => {
            fireEvent.click(screen.getByTestId('vendor-assessment-submit-btn'));
        });
        await waitFor(() => expect(posts()).toHaveLength(1));
        const body = JSON.parse(String((posts()[0][1] as RequestInit).body)) as { answers: unknown[] };
        expect(body.answers).toEqual([
            { questionId: 'mfa', answerJson: { value: 'no' }, evidenceId: null },
            { questionId: 'hosting', answerJson: { value: 'cloud' }, evidenceId: null },
        ]);
        expect(await screen.findByTestId('vendor-assessment-submitted')).toBeInTheDocument();
    });
});

describe('on a phone', () => {
    it('counts the answered questions', async () => {
        await renderForm();
        expect(progress()).toHaveTextContent(fmt(T.progress, { answered: 0, total: 3 }));
        fireEvent.click(within(screen.getByTestId('q-mfa')).getByRole('radio', { name: 'Yes' }));
        fireEvent.change(within(screen.getByTestId('q-notes')).getByRole('textbox'), { target: { value: 'ok' } });
        expect(progress()).toHaveTextContent(fmt(T.progress, { answered: 2, total: 3 }));
    });

    it('makes every choice a row at least 44 px tall', async () => {
        await renderForm();
        for (const radio of screen.getAllByRole('radio')) {
            const row = radio.closest('label')!;
            expect(row.className.split(/\s+/)).toContain('min-h-11');
        }
    });

    it('keeps the submit bar on screen, above the bottom inset', async () => {
        await renderForm();
        const bar = screen.getByTestId('vendor-assessment-submit-bar');
        const cls = bar.className.split(/\s+/);
        expect(cls).toEqual(expect.arrayContaining(['max-md:sticky', 'max-md:bottom-0']));
        expect(bar.className).toContain('env(safe-area-inset-bottom)');
        expect(within(bar).getByTestId('vendor-assessment-submit-btn')).toBeInTheDocument();
        // The card's padding is p-4 there, p-8 from md up.
        expect(screen.getByTestId('vendor-assessment-form').className.split(/\s+/)).toEqual(
            expect.arrayContaining(['p-4', 'md:p-8']),
        );
    });
});
