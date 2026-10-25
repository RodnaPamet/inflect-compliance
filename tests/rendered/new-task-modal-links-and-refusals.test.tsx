/**
 * The new-task form (`NewTaskModal` → `useNewTaskForm` + `NewTaskFields`)
 * — what it shows for staged links, and what it shows when the server
 * refuses (#4278).
 *
 *   - A staged link shows its type's label and the record's NAME. It
 *     rendered the raw enum (`CONTROL`, `FRAMEWORK_REQUIREMENT`) and the
 *     record's database id — including for the preset link a control /
 *     risk / asset page stages, which arrives as a bare type + id.
 *   - The link-failure warning names links the same way.
 *   - A refused create shows the server's reason. The hook read it only
 *     from a flat string `error`, but the API sends
 *     `{ error: { code, message } }`.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = walk(walk(en, ns), key);
            if (typeof v !== 'string') return key;
            let s = v;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                }
            }
            return s;
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/tasks',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({ tenantSlug: 'acme', tenantName: 'Acme' }),
}));

const toastWarning = jest.fn();
jest.mock('@/components/ui/hooks', () => ({
    ...jest.requireActual('@/components/ui/hooks'),
    useToast: () => ({
        error: jest.fn(),
        success: jest.fn(),
        warning: toastWarning,
        info: jest.fn(),
    }),
}));

import { NewTaskModal } from '@/app/t/[tenantSlug]/(app)/tasks/NewTaskModal';
import { useNewTaskForm } from '@/app/t/[tenantSlug]/(app)/tasks/_form/useNewTaskForm';

const en = require('../../messages/en.json');
const NEW = en.tasks.new;
const LINK = en.tasks.linkEntity as Record<string, string>;

const PRESET_CONTROL = { id: 'clx0presetcontrol0000001', code: 'AC-1', name: 'Access policy' };
const OTHER_CONTROL = { id: 'clx0othercontrol00000002', code: 'BC-4', name: 'Backup restore test' };

interface Reply {
    status?: number;
    body: unknown;
}
let writes: { create?: Reply; link?: Reply };

function response({ status = 200, body }: Reply): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

const EDITOR = { id: 'user-editor', name: 'Erin Editor', email: 'erin@example.com', image: null };
const READER = { id: 'user-reader', name: 'Rex Reader', email: 'rex@example.com', image: null };

function installFetch() {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        // The roster is the server's to narrow (#4278): the reviewer picker
        // asks for `audience=task-reviewer` and gets only who may review.
        if (String(input) === '/api/t/acme/users/assignable?audience=task-reviewer') {
            return response({ body: [EDITOR] });
        }
        if (String(input) === '/api/t/acme/users/assignable') {
            return response({ body: [EDITOR, READER] });
        }
        const url = String(input).split('?')[0];
        const method = init?.method ?? 'GET';
        if (method === 'POST' && url === '/api/t/acme/tasks') {
            return response(writes.create ?? { status: 201, body: { id: 'task-new' } });
        }
        if (method === 'POST' && url.endsWith('/links')) {
            return response(writes.link ?? { status: 201, body: {} });
        }
        if (url === '/api/t/acme/controls') {
            return response({ body: { rows: [PRESET_CONTROL, OTHER_CONTROL], truncated: false } });
        }
        return response({ body: [] });
    }) as unknown as typeof fetch;
}

function mount(opts: { preset?: boolean } = {}) {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <NewTaskModal
                open
                setOpen={jest.fn()}
                onCreated={jest.fn()}
                initialPendingLinks={
                    opts.preset ? [{ entityType: 'CONTROL', entityId: PRESET_CONTROL.id }] : undefined
                }
            />
        </SWRConfig>,
    );
}

const stagedList = () =>
    waitFor(() => {
        const el = document.getElementById('pending-links-list');
        if (!el) throw new Error('no staged links yet');
        return el;
    });

async function submitWithTitle(title: string) {
    const input = await waitFor(() => {
        const el = document.getElementById('task-title-input');
        if (!el) throw new Error('form not open yet');
        return el;
    });
    fireEvent.change(input, { target: { value: title } });
    fireEvent.submit(document.getElementById('new-task-form') as HTMLFormElement);
}

beforeEach(() => {
    writes = {};
    toastWarning.mockReset();
    installFetch();
});

describe('new-task form — staged links show names, not codes', () => {
    it('the preset link a control page stages shows the control’s label and name', async () => {
        mount({ preset: true });

        const list = await stagedList();
        await waitFor(() =>
            expect(list).toHaveTextContent(`${PRESET_CONTROL.code}: ${PRESET_CONTROL.name}`),
        );
        expect(within(list).getByText(LINK.CONTROL)).toBeInTheDocument();
        expect(list).not.toHaveTextContent('CONTROL');
        expect(list).not.toHaveTextContent(PRESET_CONTROL.id);
    });

    it('a link the user picks shows the picked record’s name', async () => {
        mount();

        // Entity type defaults to Control; pick a control and add it.
        const picker = await screen.findByTestId('new-task-link-entity-picker');
        await waitFor(() => expect(picker).not.toHaveTextContent(en.common.ui.loading));
        fireEvent.click(picker);
        const listbox = await screen.findByRole('listbox');
        fireEvent.click(
            within(listbox).getByRole('option', { name: `${OTHER_CONTROL.code}: ${OTHER_CONTROL.name}` }),
        );
        fireEvent.click(document.getElementById('add-link-btn') as HTMLElement);

        const list = await stagedList();
        expect(list).toHaveTextContent(`${OTHER_CONTROL.code}: ${OTHER_CONTROL.name}`);
        expect(within(list).getByText(LINK.CONTROL)).toBeInTheDocument();
        expect(list).not.toHaveTextContent(OTHER_CONTROL.id);
    });

    it('the link-failure warning names the link the same way', async () => {
        writes.link = { status: 400, body: { error: { code: 'BAD_REQUEST', message: 'nope' } } };
        mount({ preset: true });
        const list = await stagedList();
        await waitFor(() => expect(list).toHaveTextContent(PRESET_CONTROL.name));

        await submitWithTitle('Review access policy');

        await waitFor(() => expect(toastWarning).toHaveBeenCalled());
        const warning = String(toastWarning.mock.calls[0][0]);
        expect(warning).toContain(`${LINK.CONTROL}: ${PRESET_CONTROL.code}: ${PRESET_CONTROL.name}`);
        expect(warning).not.toContain(PRESET_CONTROL.id);
        expect(warning).not.toContain('CONTROL ');
    });
});

describe('new-task form — the reviewer picker (#4278)', () => {
    /** Open a people picker and read its option labels. */
    async function optionsOf(inputId: string): Promise<string> {
        const trigger = await waitFor(() => {
            const el = document.getElementById(inputId);
            if (!el) throw new Error(`no ${inputId} yet`);
            return el;
        });
        fireEvent.click(trigger);
        const listbox = await screen.findByRole('listbox');
        await waitFor(() => expect(within(listbox).queryAllByRole('option').length).toBeGreaterThan(0));
        const text = listbox.textContent ?? '';
        fireEvent.keyDown(listbox, { key: 'Escape' });
        return text;
    }

    it('offers only members whose role can edit tasks; the assignee picker offers everyone', async () => {
        mount();

        const reviewers = await optionsOf('task-reviewer-input');
        expect(reviewers).toContain(EDITOR.name);
        expect(reviewers).not.toContain(READER.name);
        expect(global.fetch).toHaveBeenCalledWith('/api/t/acme/users/assignable?audience=task-reviewer');

        await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
        const assignees = await optionsOf('task-assignee-input');
        expect(assignees).toContain(EDITOR.name);
        expect(assignees).toContain(READER.name);
    });
});

/**
 * Drives the hook directly: `NewTaskModal` renders `form.error` verbatim in
 * `#new-task-error`, but submits with a bare `void form.submit()`, so a
 * refused submit is also an unhandled rejection the test runner would
 * fail on for reasons unrelated to the message.
 */
function CreateHarness() {
    const form = useNewTaskForm({ onSuccess: jest.fn() });
    return (
        <>
            <button type="button" onClick={() => form.setField('title', 'Rotate the admin keys')}>
                fill
            </button>
            <button type="button" onClick={() => void form.submit().catch(() => undefined)}>
                submit
            </button>
            <p role="alert">{form.error}</p>
        </>
    );
}

describe('new-task form — a refused create shows the server’s reason', () => {
    it('surfaces the envelope’s message, not the generic fallback', async () => {
        const reason = 'A task’s reviewer must be different from its assignee.';
        writes.create = {
            status: 400,
            body: { error: { code: 'BAD_REQUEST', message: reason, requestId: 'req-1' } },
        };
        render(<CreateHarness />);

        fireEvent.click(screen.getByRole('button', { name: 'fill' }));
        fireEvent.click(screen.getByRole('button', { name: 'submit' }));

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(reason));
        expect(screen.getByRole('alert')).not.toHaveTextContent(NEW.createFailed);
    });
});
