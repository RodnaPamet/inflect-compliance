/**
 * The task quick-view panel (`TaskEditPanel`) against a server that says
 * no, and its status picker (#4278).
 *
 *   - A refused status change, field save or reassignment shows the
 *     server's reason. The panel read the reason only from a flat string
 *     `error`, but the API sends `{ error: { code, message } }`, so every
 *     refusal — the reviewer gate, an illegal move, the type-relevance rule
 *     — showed the same generic "save failed".
 *   - The status picker never offers Open, which no task can move to; a
 *     task that IS Open still shows its status.
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

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
}));

import { TaskEditPanel } from '@/components/controls-shared/TaskEditPanel';

const en = require('../../messages/en.json');
const STATUS = en.tasks.statusLabels as Record<string, string>;
const SAVE_FAILED = en.sharedPanels.detail.errors.saveFailed as string;
const ASSIGN_FAILED = en.sharedPanels.detail.errors.assigneeUpdateFailed as string;

const MEMBER = { id: 'user-sam', name: 'Sam Ray', email: 'sam@example.com', image: null };

interface Reply {
    status?: number;
    body: unknown;
}
let writes: { status?: Reply; patch?: Reply; assign?: Reply };

function response({ status = 200, body }: Reply): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

function refusal(status: number, message: string): Reply {
    return { status, body: { error: { code: 'REFUSED', message, requestId: 'req-1' } } };
}

function installFetch(taskStatus: string) {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (method === 'POST' && url.endsWith('/status') && writes.status) return response(writes.status);
        if (method === 'POST' && url.endsWith('/assign') && writes.assign) return response(writes.assign);
        if (method === 'PATCH' && writes.patch) return response(writes.patch);
        if (url.endsWith('/users/assignable')) {
            return response({ body: [MEMBER] });
        }
        if (url.endsWith('/tasks/task-1')) {
            return response({
                body: {
                    id: 'task-1',
                    key: 'TSK-1',
                    title: 'Rotate the admin keys',
                    description: null,
                    type: 'TASK',
                    severity: 'MEDIUM',
                    priority: 'P2',
                    status: taskStatus,
                    dueAt: null,
                    assigneeUserId: null,
                    assignee: null,
                },
            });
        }
        return response({ body: [] });
    }) as unknown as typeof fetch;
}

function mount(taskStatus: string) {
    installFetch(taskStatus);
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TaskEditPanel
                tenantSlug="acme"
                task={{ id: 'task-1', title: 'Rotate the admin keys', status: taskStatus, severity: 'MEDIUM' }}
                canWrite
                onSaved={jest.fn()}
            />
        </SWRConfig>,
    );
}

/** Wait for the GET to seed the form (the title input carries it). */
async function loaded() {
    await waitFor(() =>
        expect((document.getElementById('task-panel-title') as HTMLInputElement).value).toBe(
            'Rotate the admin keys',
        ),
    );
    // The panel only commits once its load has landed; the input value is
    // seeded in the same pass, so give the effect one more tick.
    await waitFor(() => expect(screen.getByTestId('task-edit-autosave-status')).toBeInTheDocument());
}

async function statusOptions(): Promise<string[]> {
    fireEvent.click(document.getElementById('task-panel-status') as HTMLElement);
    const listbox = await screen.findByRole('listbox');
    return within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent?.trim() ?? '');
}

beforeEach(() => {
    writes = {};
});

describe('TaskEditPanel — the status picker', () => {
    it('does not offer Open to a task in any other status', async () => {
        mount('TRIAGED');
        await loaded();

        const options = await statusOptions();
        expect(options).not.toContain(STATUS.OPEN);
        expect(options).toContain(STATUS.TRIAGED);
    });

    it('still shows Open as the status of a task that is Open', async () => {
        mount('OPEN');
        await loaded();

        expect(document.getElementById('task-panel-status')).toHaveTextContent(STATUS.OPEN);
    });
});

describe('TaskEditPanel — a refused write shows the server’s reason', () => {
    it('a status change', async () => {
        const reason =
            'This task has a reviewer, so it must be In review before it can be closed. Move it to In review for sign-off first.';
        writes.status = refusal(400, reason);
        mount('TRIAGED');
        await loaded();

        await statusOptions();
        fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: STATUS.BLOCKED }));

        expect(await screen.findByText(reason)).toBeInTheDocument();
        expect(screen.queryByText(SAVE_FAILED)).not.toBeInTheDocument();
    });

    it('a field save', async () => {
        const reason = 'Audit Finding tasks must have a control, or a link to a control or framework requirement.';
        writes.patch = refusal(400, reason);
        mount('CLOSED');
        await loaded();

        const title = document.getElementById('task-panel-title') as HTMLInputElement;
        fireEvent.change(title, { target: { value: 'Rotate the admin keys now' } });
        fireEvent.blur(title);

        expect(await screen.findByText(reason)).toBeInTheDocument();
        expect(screen.queryByText(SAVE_FAILED)).not.toBeInTheDocument();
    });

    it('a reassignment', async () => {
        const reason = 'A task’s reviewer must be different from its assignee.';
        writes.assign = refusal(400, reason);
        mount('TRIAGED');
        await loaded();

        fireEvent.click(document.getElementById('task-panel-assignee') as HTMLElement);
        const listbox = await screen.findByRole('listbox');
        fireEvent.click(await within(listbox).findByRole('option', { name: new RegExp(MEMBER.name) }));

        expect(await screen.findByText(reason)).toBeInTheDocument();
        expect(screen.queryByText(ASSIGN_FAILED)).not.toBeInTheDocument();
    });
});
