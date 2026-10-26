/**
 * The task quick view (`TaskEditPanel`) offers two controls whose routes
 * ask a different key from the task's own edit rights:
 *
 *   - the evidence box's file upload POSTs to `/evidence/uploads`, whose
 *     usecase asserts `evidence.upload`;
 *   - the assignee picker POSTs to `/tasks/:id/assign`, which asks
 *     `tasks.assign` and `assertCanAssignTasks`.
 *
 * Both used to follow `canWrite` (the task edit rights), so a custom role
 * with `tasks.edit` but without either key was offered a control the server
 * refused (#4325, #4328). Built-in roles hold all three keys together, so a
 * built-in Editor is the control case.
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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
import { getPermissionsForRole } from '@/lib/permissions';

const TASK = { id: 'task-1', title: 'Rotate the admin keys', status: 'TRIAGED', severity: 'MEDIUM' };
const ATTACHED = { id: 'ev-1', title: 'Key rotation log', type: 'TEXT' };

function response(body: unknown): Response {
    return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

beforeEach(() => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/tasks/task-1')) {
            return response({
                ...TASK,
                key: 'TSK-1',
                description: null,
                type: 'TASK',
                priority: 'P2',
                dueAt: null,
                assigneeUserId: null,
                assignee: null,
            });
        }
        if (url.endsWith('/tasks/task-1/evidence')) return response({ evidence: [ATTACHED], links: [] });
        return response([]);
    }) as unknown as typeof fetch;
});

type Gates = Pick<
    React.ComponentProps<typeof TaskEditPanel>,
    'canWrite' | 'canUploadEvidence' | 'canAssign'
>;

/**
 * The gates the three mounts pass, from a role's keys: the task's edit
 * rights, and each control's own key inside them. `over` replaces keys the
 * way a custom role built on that role would.
 */
function gatesFor(
    role: 'EDITOR' | 'READER',
    over: { evidenceUpload?: boolean; tasksAssign?: boolean } = {},
): Gates {
    const p = getPermissionsForRole(role);
    const writeTier = role === 'EDITOR';
    const canWrite = writeTier && p.tasks.edit;
    return {
        canWrite,
        canUploadEvidence: canWrite && (over.evidenceUpload ?? p.evidence.upload),
        canAssign: canWrite && (over.tasksAssign ?? p.tasks.assign),
    };
}

function mount(gates: Gates) {
    return render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <TaskEditPanel tenantSlug="acme" task={TASK} {...gates} onSaved={jest.fn()} />
        </SWRConfig>,
    );
}

/** Wait for the GET to seed the form, then for the attached list to load. */
async function loaded() {
    await waitFor(() =>
        expect((document.getElementById('task-panel-title') as HTMLInputElement).value).toBe(TASK.title),
    );
    await screen.findByText(ATTACHED.title);
}

const assignee = () => document.getElementById('task-panel-assignee');
const title = () => document.getElementById('task-panel-title');

describe('TaskEditPanel — the evidence box follows evidence.upload', () => {
    it('a built-in Editor gets the file box and the URL link', async () => {
        mount(gatesFor('EDITOR'));
        await loaded();

        expect(screen.getByTestId('evidence-upload-dropzone')).toBeInTheDocument();
        expect(screen.getByTestId('evidence-link-url-form')).toBeInTheDocument();
    });

    it('a custom role with tasks.edit but not evidence.upload gets no box, and still sees what is attached', async () => {
        mount(gatesFor('EDITOR', { evidenceUpload: false }));
        await loaded();

        expect(screen.queryByTestId('evidence-upload-dropzone')).not.toBeInTheDocument();
        expect(screen.queryByTestId('evidence-link-url-form')).not.toBeInTheDocument();
        expect(screen.getByTestId('evidence-attached-list')).toHaveTextContent(ATTACHED.title);
        // The task's own fields are untouched by the evidence key.
        expect(title()).toBeEnabled();
    });
});

describe('TaskEditPanel — the assignee picker follows tasks.assign', () => {
    it('a built-in Editor can pick an assignee', async () => {
        mount(gatesFor('EDITOR'));
        await loaded();

        expect(assignee()).toBeEnabled();
    });

    it('a custom role with tasks.edit but not tasks.assign gets a locked picker, and the rest stays editable', async () => {
        mount(gatesFor('EDITOR', { tasksAssign: false }));
        await loaded();

        expect(assignee()).toBeDisabled();
        expect(title()).toBeEnabled();
        expect(screen.getByTestId('task-edit-autosave-status')).toBeInTheDocument();
    });
});

describe('TaskEditPanel — the two props default to canWrite and never exceed it', () => {
    it('a mount that passes neither keeps the box and the picker on canWrite', async () => {
        mount({ canWrite: true });
        await loaded();

        expect(screen.getByTestId('evidence-upload-dropzone')).toBeInTheDocument();
        expect(assignee()).toBeEnabled();
    });

    it('a read-only panel offers neither, whatever the two props say', async () => {
        mount({ canWrite: false, canUploadEvidence: true, canAssign: true });
        await loaded();

        expect(screen.queryByTestId('evidence-upload-dropzone')).not.toBeInTheDocument();
        expect(assignee()).toBeDisabled();
    });

    it('a Reader gets a read-only panel that still lists the attached evidence', async () => {
        mount(gatesFor('READER'));
        await loaded();

        expect(screen.queryByTestId('evidence-upload-dropzone')).not.toBeInTheDocument();
        expect(screen.getByTestId('evidence-attached-list')).toHaveTextContent(ATTACHED.title);
        expect(assignee()).toBeDisabled();
    });
});
