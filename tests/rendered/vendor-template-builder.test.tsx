/** @jest-environment jsdom */

/**
 * The vendor template builder (#4934): a choice question is sent with its
 * options and a scale with its range, a draft question can be edited and
 * removed (through the undo window), order moves by button, answer types read
 * as words, and publishing asks first.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// A stable translator per namespace that resolves `{n, plural, …}`, so a
// plural message is checked as a reader sees it (the shared mock leaves it raw).
jest.mock('next-intl', () => {
    const shared = jest.requireActual('../../__mocks__/next-intl.js');
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const PLURAL = /\{(\w+),\s*plural,((?:\s*(?:=\d+|one|other)\s*\{[^{}]*\})+)\s*\}/g;
    const OPTION = /(=\d+|one|other)\s*\{([^{}]*)\}/g;
    const has = (params: Record<string, unknown> | undefined, name: string) =>
        !!params && Object.prototype.hasOwnProperty.call(params, name);
    const format = (str: string, params?: Record<string, unknown>) =>
        str
            .replace(PLURAL, (block: string, name: string, options: string) => {
                if (!has(params, name)) return block;
                const n = Number(params![name]);
                const forms = new Map<string, string>();
                for (const m of options.matchAll(OPTION)) forms.set(m[1], m[2]);
                const body = forms.get(`=${n}`) ?? (n === 1 ? forms.get('one') : undefined) ?? forms.get('other');
                return body === undefined ? block : body.split('#').join(String(n));
            })
            .replace(/\{(\w+)\}/g, (m: string, name: string) => (has(params, name) ? String(params![name]) : m));
    const translators = new Map<string, unknown>();
    return {
        ...shared,
        useTranslations: (ns: string) => {
            if (!translators.has(ns)) {
                const t = (key: string, params?: Record<string, unknown>) => {
                    const val = lookup(ns, key);
                    return typeof val === 'string' ? format(val, params) : key;
                };
                translators.set(ns, t);
            }
            return translators.get(ns);
        },
    };
});

// Stable, as the real provider's are: a new function each render would
// re-run the page's load effect forever.
jest.mock('@/lib/tenant-context-provider', () => {
    const href = (path: string) => `/t/acme${path}`;
    const apiUrl = (path: string) => `/api/t/acme${path}`;
    const ctx = { permissions: { canWrite: true } };
    return {
        useTenantHref: () => href,
        useTenantApiUrl: () => apiUrl,
        useTenantContext: () => ctx,
    };
});
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/vendor-templates/tpl-1',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));


// The undo window is the hook's own business (it has its own tests); here it
// hands back what the page asked of it, so the test can let it close or undo.
const undoToasts: Array<{
    message: string;
    action: () => Promise<unknown>;
    undoAction?: () => void | Promise<void>;
}> = [];
jest.mock('@/components/ui/hooks', () => {
    const actual = jest.requireActual('@/components/ui/hooks');
    const trigger = (input: (typeof undoToasts)[number]) => {
        undoToasts.push(input);
    };
    return { ...actual, useToastWithUndo: () => trigger };
});

import { VendorTemplateBuilderClient } from '@/app/t/[tenantSlug]/(app)/admin/vendor-templates/[templateId]/VendorTemplateBuilderClient';

const EN = jest.requireActual('../../messages/en.json') as {
    admin: { templateBuilder: Record<string, string>; vendorAnswerType: Record<string, string> };
};
const TB = EN.admin.templateBuilder;
const AT = EN.admin.vendorAnswerType;

const fill = (template: string, params: Record<string, string | number>) =>
    template.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));

function tree(overrides: Record<string, unknown> = {}) {
    return {
        id: 'tpl-1',
        key: 'security',
        version: 1,
        name: 'Security questionnaire',
        description: null,
        isPublished: false,
        sections: [
            { id: 's-1', sortOrder: 0, title: 'Access', description: null },
            { id: 's-2', sortOrder: 1, title: 'Encryption', description: null },
        ],
        questions: [
            {
                id: 'q-1', sectionId: 's-1', sortOrder: 0, prompt: 'Do you use MFA?',
                answerType: 'YES_NO', required: true, weight: 1, optionsJson: null, scaleConfigJson: null,
            },
            {
                id: 'q-2', sectionId: 's-1', sortOrder: 1, prompt: 'How often do you review access?',
                answerType: 'SINGLE_SELECT', required: true, weight: 2,
                optionsJson: [
                    { label: 'Quarterly', value: 'quarterly', points: 0 },
                    { label: 'Never', value: 'never', points: 3 },
                ],
                scaleConfigJson: null,
            },
        ],
        ...overrides,
    };
}

const fetchMock = jest.fn();
function respond(body: unknown, ok = true, status = 200) {
    return Promise.resolve({ ok, status, json: async () => body });
}
function callsTo(method: string, pathEnd: string) {
    return fetchMock.mock.calls.filter(
        ([url, init]) => String(url).endsWith(pathEnd) && ((init as RequestInit | undefined)?.method ?? 'GET') === method,
    );
}

beforeEach(() => {
    undoToasts.length = 0;
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (!init || !init.method || init.method === 'GET') return respond(tree());
        return respond({});
    });
    global.fetch = fetchMock as unknown as typeof fetch;
});

async function renderBuilder() {
    render(<VendorTemplateBuilderClient templateId="tpl-1" />);
    await screen.findByText('Do you use MFA?');
}

async function chooseType(sectionId: string, label: string) {
    fireEvent.click(document.getElementById(`new-question-${sectionId}-type`)!);
    fireEvent.click(await screen.findByRole('option', { name: label }));
}

describe('VendorTemplateBuilderClient', () => {
    it('shows each answer type as words and the weight as a sentence, not codes', async () => {
        await renderBuilder();
        const mfa = screen.getByTestId('question-q-1');
        const review = screen.getByTestId('question-q-2');
        expect(within(mfa).getByText(AT.YES_NO)).toBeTruthy();
        expect(within(review).getByText(AT.SINGLE_SELECT)).toBeTruthy();
        expect(screen.queryByText('SINGLE_SELECT')).toBeNull();
        expect(screen.queryByText('YES_NO')).toBeNull();
        expect(within(review).getByText(fill(TB.weightValue, { weight: 2 }))).toBeTruthy();
        expect(screen.queryByText(/w=/)).toBeNull();
        // A choice question says what the vendor chooses from.
        expect(within(review).getByText('Quarterly · Never')).toBeTruthy();
    });

    it('sends a single-choice question with the options typed for it', async () => {
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'POST' && String(url).endsWith('/sections/s-2/questions')) {
                const body = JSON.parse(String(init.body));
                return respond({ id: 'q-new', sectionId: 's-2', sortOrder: 0, ...body }, true, 201);
            }
            return respond(tree());
        });
        await renderBuilder();
        const encryption = screen.getByTestId('section-s-2');
        fireEvent.change(within(encryption).getByLabelText(TB.promptLabel), { target: { value: 'Where are keys kept?' } });
        await chooseType('s-2', AT.SINGLE_SELECT);
        fireEvent.change(within(encryption).getByLabelText(fill(TB.optionLabel, { n: 1 })), { target: { value: 'In an HSM' } });
        fireEvent.change(within(encryption).getByLabelText(fill(TB.optionPoints, { n: 1 })), { target: { value: '0' } });
        fireEvent.change(within(encryption).getByLabelText(fill(TB.optionLabel, { n: 2 })), { target: { value: 'In code' } });
        fireEvent.change(within(encryption).getByLabelText(fill(TB.optionPoints, { n: 2 })), { target: { value: '5' } });
        await act(async () => {
            fireEvent.submit(within(encryption).getByTestId('add-question-form'));
        });

        const [, init] = callsTo('POST', '/sections/s-2/questions')[0];
        expect(JSON.parse(String((init as RequestInit).body))).toEqual({
            prompt: 'Where are keys kept?',
            answerType: 'SINGLE_SELECT',
            required: true,
            weight: 1,
            optionsJson: [
                { label: 'In an HSM', value: 'in-an-hsm', points: 0 },
                { label: 'In code', value: 'in-code', points: 5 },
            ],
            scaleConfigJson: null,
        });
        // Added in place, under the right section, without reloading the tree.
        expect(await within(screen.getByTestId('section-s-2')).findByText('Where are keys kept?')).toBeTruthy();
    });

    it('refuses to send a choice question with no options, and says why', async () => {
        await renderBuilder();
        const encryption = screen.getByTestId('section-s-2');
        fireEvent.change(within(encryption).getByLabelText(TB.promptLabel), { target: { value: 'Pick one' } });
        await chooseType('s-2', AT.MULTI_SELECT);
        await act(async () => {
            fireEvent.submit(within(encryption).getByTestId('add-question-form'));
        });
        expect(within(encryption).getByText(TB.optionsNeeded)).toBeTruthy();
        expect(callsTo('POST', '/sections/s-2/questions')).toHaveLength(0);
    });

    it('sends a scale question with its range and end labels', async () => {
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'POST') return respond({ id: 'q-new', sectionId: 's-2', sortOrder: 0, ...JSON.parse(String(init.body)) }, true, 201);
            return respond(tree());
        });
        await renderBuilder();
        const encryption = screen.getByTestId('section-s-2');
        fireEvent.change(within(encryption).getByLabelText(TB.promptLabel), { target: { value: 'How mature is your key management?' } });
        await chooseType('s-2', AT.SCALE);
        fireEvent.change(within(encryption).getByLabelText(TB.scaleMax), { target: { value: '4' } });
        fireEvent.change(within(encryption).getByLabelText(TB.scaleLowLabel), { target: { value: 'Ad hoc' } });
        fireEvent.change(within(encryption).getByLabelText(TB.scaleHighLabel), { target: { value: 'Optimised' } });
        await act(async () => {
            fireEvent.submit(within(encryption).getByTestId('add-question-form'));
        });
        const body = JSON.parse(String((callsTo('POST', '/sections/s-2/questions')[0][1] as RequestInit).body));
        expect(body.scaleConfigJson).toEqual({ min: 1, max: 4, labels: ['Ad hoc', 'Optimised'] });
        expect(body.optionsJson).toBeNull();
    });

    it('edits a draft question in place, keeping the stored option values', async () => {
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'PATCH') {
                return respond({ ...tree().questions[1], ...JSON.parse(String(init.body)) });
            }
            return respond(tree());
        });
        await renderBuilder();
        fireEvent.click(screen.getByRole('button', { name: fill(TB.editQuestion, { prompt: 'How often do you review access?' }) }));
        const form = screen.getByTestId('edit-question-form');
        fireEvent.change(within(form).getByLabelText(fill(TB.optionLabel, { n: 1 })), { target: { value: 'Every quarter' } });
        await act(async () => {
            fireEvent.submit(form);
        });

        const [url, init] = callsTo('PATCH', '/questions/q-2')[0];
        expect(String(url)).toBe('/api/t/acme/vendor-assessment-templates/tpl-1/questions/q-2');
        expect(JSON.parse(String((init as RequestInit).body)).optionsJson).toEqual([
            { label: 'Every quarter', value: 'quarterly', points: 0 },
            { label: 'Never', value: 'never', points: 3 },
        ]);
        expect(await screen.findByText('Every quarter · Never')).toBeTruthy();
        expect(screen.queryByTestId('edit-question-form')).toBeNull();
    });

    it('removes a question through the undo window, and Undo puts it back where it was', async () => {
        await renderBuilder();
        fireEvent.click(screen.getByRole('button', { name: fill(TB.removeQuestion, { prompt: 'Do you use MFA?' }) }));
        expect(screen.queryByText('Do you use MFA?')).toBeNull();
        expect(undoToasts).toHaveLength(1);
        expect(undoToasts[0].message).toBe(TB.questionRemoved);
        // Nothing is sent until the window closes.
        expect(callsTo('DELETE', '/questions/q-1')).toHaveLength(0);

        await act(async () => {
            await undoToasts[0].undoAction?.();
        });
        const rows = within(screen.getByTestId('section-s-1')).getAllByTestId(/^question-/);
        expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['question-q-1', 'question-q-2']);
    });

    it('sends the DELETE when the window closes, and says how many questions a section takes with it', async () => {
        await renderBuilder();
        fireEvent.click(screen.getByRole('button', { name: fill(TB.removeSection, { title: 'Access' }) }));
        expect(screen.queryByTestId('section-s-1')).toBeNull();
        expect(undoToasts[0].message).toBe('Section removed, with 2 questions');
        await act(async () => {
            await undoToasts[0].action();
        });
        expect(callsTo('DELETE', '/sections/s-1')).toHaveLength(1);
    });

    it('moves a question down with a button and offers to save the new order', async () => {
        await renderBuilder();
        expect(document.getElementById('save-order-btn')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: fill(TB.moveQuestionDown, { prompt: 'Do you use MFA?' }) }));
        const rows = within(screen.getByTestId('section-s-1')).getAllByTestId(/^question-/);
        expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['question-q-2', 'question-q-1']);
        // The first row cannot move up, the last cannot move down.
        expect(
            (screen.getByRole('button', { name: fill(TB.moveSectionUp, { title: 'Access' }) }) as HTMLButtonElement).disabled,
        ).toBe(true);

        await act(async () => {
            fireEvent.click(document.getElementById('save-order-btn')!);
        });
        const body = JSON.parse(String((callsTo('POST', '/reorder')[0][1] as RequestInit).body));
        expect(body.sections[0].questions).toEqual([
            { id: 'q-2', sectionId: 's-1', sortOrder: 0 },
            { id: 'q-1', sectionId: 's-1', sortOrder: 1 },
        ]);
    });

    it('asks before publishing, and publishes only on confirm', async () => {
        await renderBuilder();
        fireEvent.click(document.getElementById('publish-template-btn')!);
        expect(callsTo('POST', '/publish')).toHaveLength(0);
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getAllByText(TB.publishConfirmBody).length).toBeGreaterThan(0);
        await act(async () => {
            fireEvent.click(within(dialog).getByRole('button', { name: TB.publish }));
        });
        await waitFor(() => expect(callsTo('POST', '/publish')).toHaveLength(1));
    });

    it("shows the server's sentence when an edit is refused, not a status code", async () => {
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (init?.method === 'PATCH') {
                return respond(
                    { error: { code: 'BAD_REQUEST', message: '"Security questionnaire" is published and can no longer be changed. Make a new draft from it to edit it.' } },
                    false,
                    400,
                );
            }
            return respond(tree());
        });
        await renderBuilder();
        fireEvent.click(screen.getByRole('button', { name: fill(TB.editSection, { title: 'Access' }) }));
        await act(async () => {
            fireEvent.submit(screen.getByTestId('edit-section-form'));
        });
        expect((await screen.findByTestId('builder-error')).textContent).toMatch(/Make a new draft/);
        expect(screen.getByTestId('builder-error').textContent).not.toMatch(/\(\d{3}\)/);
    });

    it('offers no edits on a published template', async () => {
        fetchMock.mockImplementation(() => respond(tree({ isPublished: true })));
        await renderBuilder();
        expect(screen.getByTestId('published-banner')).toBeTruthy();
        expect(screen.queryByRole('button', { name: fill(TB.editQuestion, { prompt: 'Do you use MFA?' }) })).toBeNull();
        expect(screen.queryByTestId('add-question-form')).toBeNull();
    });
});
