/**
 * The risk-create payload, asserted against the actual request body.
 *
 * B2-8 — these four contracts used to be checked by source-scanning
 * `NewRiskModal.tsx` for the characters `title:`, `description:`,
 * `payload.templateId = selectedTemplate.id` and so on. That proves the text
 * exists in a file; it cannot tell you the body is right, and it went red the
 * moment the payload moved into a hook without anything actually breaking.
 *
 * Now the payload lives in `useNewRiskForm`, which is plain enough to render
 * and drive — so the assertions below read the fetch body the server would
 * have received.
 *
 * WHAT THIS PROTECTS: the empty-string→omitted translation. The schema keeps
 * optional fields as `''` so the inputs stay controlled; the API expects
 * those keys ABSENT, not empty. Send `category: ''` and the server either
 * rejects the enum or writes an empty category. That conversion happens in
 * exactly one place, and this is the test that says so.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { useNewRiskForm } from '@/app/t/[tenantSlug]/(app)/risks/_form/useNewRiskForm';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
}));

function lastBody(fetchMock: jest.Mock, index = 0): Record<string, unknown> {
    return JSON.parse((fetchMock.mock.calls[index][1] as RequestInit).body as string);
}

const okCreate = () =>
    jest.fn(async () => ({ ok: true, status: 201, json: async () => ({ id: 'risk-1' }) }));

describe('useNewRiskForm — the POST body', () => {
    let onCreated: jest.Mock;
    beforeEach(() => {
        onCreated = jest.fn();
    });

    const setup = (opts: { templateId?: string | null } = {}) =>
        renderHook(() =>
            useNewRiskForm({
                onCreated,
                templateId: opts.templateId ?? null,
                fallbackErrorMessage: 'Could not create the risk.',
            }),
        );

    it('sends only the required fields when nothing optional is filled in', async () => {
        const fetchMock = okCreate();
        global.fetch = fetchMock as unknown as typeof fetch;
        const { result } = setup();

        act(() => result.current.setField('title', 'Server room flooding'));
        await act(async () => { await result.current.submit(); });

        expect(fetchMock).toHaveBeenCalledWith('/api/t/acme/risks', expect.objectContaining({ method: 'POST' }));
        // The empty optionals are ABSENT, not empty strings. This is the
        // whole point of the conversion step.
        expect(lastBody(fetchMock)).toEqual({
            title: 'Server room flooding',
            likelihood: 3,
            impact: 3,
        });
    });

    it('includes each optional field only once it has a value', async () => {
        const fetchMock = okCreate();
        global.fetch = fetchMock as unknown as typeof fetch;
        const { result } = setup();

        act(() => {
            result.current.setField('title', 'T');
            result.current.setField('description', 'Some detail');
            result.current.setField('category', 'Operational');
            result.current.setField('ownerUserId', 'u-1');
            result.current.setField('treatment', 'TREAT');
            result.current.setField('treatmentNotes', 'Add a pump');
            result.current.setField('likelihood', 4);
            result.current.setField('impact', 5);
        });
        await act(async () => { await result.current.submit(); });

        expect(lastBody(fetchMock)).toEqual({
            title: 'T',
            description: 'Some detail',
            category: 'Operational',
            ownerUserId: 'u-1',
            treatment: 'TREAT',
            treatmentNotes: 'Add a pump',
            likelihood: 4,
            impact: 5,
        });
    });

    it('trims title, description and notes — and omits whitespace-only ones', async () => {
        const fetchMock = okCreate();
        global.fetch = fetchMock as unknown as typeof fetch;
        const { result } = setup();

        act(() => {
            result.current.setField('title', '  Padded title  ');
            result.current.setField('description', '   ');
            result.current.setField('treatmentNotes', '  note  ');
        });
        await act(async () => { await result.current.submit(); });

        const body = lastBody(fetchMock);
        expect(body.title).toBe('Padded title');
        expect(body.treatmentNotes).toBe('note');
        // Whitespace-only is "not filled in", not a value.
        expect(body).not.toHaveProperty('description');
    });

    it('serialises nextReviewAt from the date input to an ISO instant', async () => {
        const fetchMock = okCreate();
        global.fetch = fetchMock as unknown as typeof fetch;
        const { result } = setup();

        act(() => {
            result.current.setField('title', 'T');
            result.current.setField('nextReviewAt', '2026-11-30');
        });
        await act(async () => { await result.current.submit(); });

        // `<input type=date>` yields YYYY-MM-DD; the API wants an instant.
        expect(lastBody(fetchMock).nextReviewAt).toBe(
            new Date('2026-11-30').toISOString(),
        );
    });

    it('passes templateId through when a template is selected', async () => {
        const fetchMock = okCreate();
        global.fetch = fetchMock as unknown as typeof fetch;
        const { result } = setup({ templateId: 'tmpl-7' });

        act(() => result.current.setField('title', 'T'));
        await act(async () => { await result.current.submit(); });

        expect(lastBody(fetchMock).templateId).toBe('tmpl-7');
    });

    it('omits templateId entirely when none is selected', async () => {
        const fetchMock = okCreate();
        global.fetch = fetchMock as unknown as typeof fetch;
        const { result } = setup({ templateId: null });

        act(() => result.current.setField('title', 'T'));
        await act(async () => { await result.current.submit(); });

        expect(lastBody(fetchMock)).not.toHaveProperty('templateId');
    });

    it('hands the created risk to onCreated so the link phase can run', async () => {
        const fetchMock = okCreate();
        global.fetch = fetchMock as unknown as typeof fetch;
        const { result } = setup();

        act(() => result.current.setField('title', 'T'));
        await act(async () => { await result.current.submit(); });

        expect(onCreated).toHaveBeenCalledWith({ id: 'risk-1' });
    });
});

describe('useNewRiskForm — gating and failure', () => {
    const setup = () =>
        renderHook(() =>
            useNewRiskForm({
                onCreated: jest.fn(),
                fallbackErrorMessage: 'Could not create the risk.',
            }),
        );

    it('cannot submit without a title', () => {
        const { result } = setup();
        expect(result.current.canSubmit).toBe(false);
    });

    it('cannot submit on a whitespace-only title', () => {
        // The pre-B2-8 gate was `title.trim().length > 0`; the schema's
        // `.trim().min(1)` has to reproduce it, not merely "be a schema".
        const { result } = setup();
        act(() => result.current.setField('title', '   '));
        expect(result.current.canSubmit).toBe(false);
    });

    it('can submit once a real title is present', () => {
        const { result } = setup();
        act(() => result.current.setField('title', 'A risk'));
        expect(result.current.canSubmit).toBe(true);
    });

    it('rejects a category outside the canonical list', () => {
        // The schema validates against `@/lib/risk/categories`, the same
        // list the combobox is projected from — so a drifting third copy
        // would surface here rather than as a silently un-submittable form.
        const { result } = setup();
        act(() => {
            result.current.setField('title', 'A risk');
            result.current.setField('category', 'Not A Real Category');
        });
        expect(result.current.canSubmit).toBe(false);
    });

    it('surfaces the SERVER message on failure, not the fallback', async () => {
        global.fetch = jest.fn(async () => ({
            ok: false, status: 409,
            json: async () => ({ error: 'A risk with that key already exists' }),
        })) as unknown as typeof fetch;
        const { result } = setup();

        act(() => result.current.setField('title', 'Dup'));
        await act(async () => { await result.current.submit(); });

        await waitFor(() =>
            expect(result.current.error).toBe('A risk with that key already exists'),
        );
    });

    it('falls back to the caller-supplied localised message when the server sends none', async () => {
        global.fetch = jest.fn(async () => ({
            ok: false, status: 500, json: async () => ({}),
        })) as unknown as typeof fetch;
        const { result } = setup();

        act(() => result.current.setField('title', 'Boom'));
        await act(async () => { await result.current.submit(); });

        await waitFor(() =>
            expect(result.current.error).toBe('Could not create the risk.'),
        );
    });

    it('reset() restores the initial values', async () => {
        const { result } = setup();
        act(() => result.current.setField('title', 'Typed something'));
        expect(result.current.fields.title).toBe('Typed something');
        act(() => result.current.reset());
        expect(result.current.fields.title).toBe('');
        expect(result.current.canSubmit).toBe(false);
    });

    it('applyFields sets several fields at once — the template path', async () => {
        const { result } = setup();
        act(() =>
            result.current.applyFields({
                title: 'From template',
                category: 'Technical',
                likelihood: 5,
                impact: 2,
            }),
        );
        expect(result.current.fields).toMatchObject({
            title: 'From template',
            category: 'Technical',
            likelihood: 5,
            impact: 2,
        });
        // Untouched fields keep their initial values.
        expect(result.current.fields.treatment).toBe('');
    });
});
