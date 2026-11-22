/**
 * #5225 — a vendor's NUMBER answer can be a decimal or a negative, and an
 * optional field they clear does not block the submission.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';


import { VendorAssessmentClient } from '@/app/vendor-assessment/[assessmentId]/VendorAssessmentClient';

const EN = jest.requireActual('../../messages/en.json') as Record<string, unknown>;
const T = (EN.external as { vendorAssessment: Record<string, string> }).vendorAssessment;

const question = (id: string, required: boolean) => ({
    id,
    sortOrder: 0,
    prompt: `Question ${id}`,
    helpText: null,
    answerType: 'NUMBER',
    required,
    weight: 1,
    optionsJson: null,
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
        sections: [{ id: 's1', sortOrder: 0, title: 'Numbers', description: null, questions: [question('q-temp', true), question('q-opt', false)] }],
    },
    answers: [],
};

it('types -0.5 as typed, sends it as a number, and omits a cleared optional answer', async () => {
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
        return { ok: true, status: 200, json: async () => LOAD } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(
        <NextIntlClientProvider locale="en" messages={EN}>
            <VendorAssessmentClient assessmentId="a1" initialToken="tok" />
        </NextIntlClientProvider>,
    );

    const temp = within(await screen.findByTestId('q-q-temp')).getByRole('textbox') as HTMLInputElement;
    for (const step of ['-', '-0', '-0.', '-0.5']) {
        fireEvent.change(temp, { target: { value: step } });
        expect(temp.value).toBe(step);
    }
    const opt = within(screen.getByTestId('q-q-opt')).getByRole('textbox') as HTMLInputElement;
    fireEvent.change(opt, { target: { value: '7' } });
    fireEvent.change(opt, { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: T.submit }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'POST')).toBe(true));
    const post = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as { answers: unknown[] };
    expect(body.answers).toEqual([{ questionId: 'q-temp', answerJson: { value: -0.5 }, evidenceId: null }]);
});
