/** @jest-environment jsdom */

import * as React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, {
        custom: jest.fn(), dismiss: jest.fn(), success: jest.fn(),
        error: jest.fn(), warning: jest.fn(), info: jest.fn(),
        message: jest.fn(), loading: jest.fn(),
    }),
}));

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/processes',
    useSearchParams: () => new URLSearchParams(),
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
    notFound: jest.fn(),
    redirect: jest.fn(),
}));

import { SWRConfig } from 'swr';
import {
    CanvasDocumentBar,
    type CanvasDocumentBarProps,
} from '@/components/processes/CanvasDocumentBar';
import { RulesTab, type AutomationRuleRow } from '@/app/t/[tenantSlug]/(app)/processes/RulesTab';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';

/**
 * #4640 — the Processes page offered every role every write: a Reader could
 * draw, rename and press Save on a map, and create, toggle and archive rules,
 * and each ended in a refusal. Map writes take `processes.edit`, deleting a
 * map and every rule write take the Admin tier, so the page now offers only
 * those.
 */

const ACTIVE = {
    id: 'map-1', name: 'Invoice approval', description: null,
    status: 'DRAFT' as const, version: 3,
    createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
    nodeCount: 2, edgeCount: 1,
};

function barProps(canEdit: boolean, canDelete: boolean): CanvasDocumentBarProps {
    return {
        tenantSlug: 'acme',
        doc: {
            activeId: ACTIVE.id,
            processes: [ACTIVE],
            activeProcess: ACTIVE,
            editedName: ACTIVE.name,
            loadedMap: { version: ACTIVE.version },
            error: null,
        },
        busy: { saving: false, loading: false, creating: false, duplicating: false },
        editorState: {
            snapEnabled: true, autosaveStatus: 'idle', autosaveError: null,
            canUndo: true, canRedo: true,
        },
        handlers: {
            onActiveIdChange: jest.fn(), setEditedName: jest.fn(), handleSave: jest.fn(),
            handleNew: jest.fn(), handleDuplicate: jest.fn(), handleRenameCommit: jest.fn(),
            handleUndo: jest.fn(), handleRedo: jest.fn(), setSnapEnabled: jest.fn(),
            onSwitchMode: jest.fn(), onChangeStatus: jest.fn(), onDelete: jest.fn(),
        },
        canEdit,
        canDelete,
    };
}

const WRITE_LABELS = ['New process', 'Duplicate', 'Undo', 'Redo', 'Save'];

describe('Processes map bar — writes follow the server (#4640)', () => {
    it('a Reader is offered no write, and the name cannot be typed into', () => {
        const { queryByRole, getByLabelText } = render(<CanvasDocumentBar {...barProps(false, false)} />);
        for (const name of [...WRITE_LABELS, 'Delete']) {
            expect(queryByRole('button', { name })).toBeNull();
        }
        expect(queryByRole('combobox', { name: 'Process status' })).toBeNull();
        expect((getByLabelText('Process name') as HTMLInputElement).readOnly).toBe(true);
    });

    it('an Editor can change maps but is not offered Delete', () => {
        const { getByRole, queryByRole, getByLabelText } = render(<CanvasDocumentBar {...barProps(true, false)} />);
        for (const name of WRITE_LABELS) {
            expect(getByRole('button', { name })).toBeTruthy();
        }
        expect(queryByRole('button', { name: 'Delete' })).toBeNull();
        expect((getByLabelText('Process name') as HTMLInputElement).readOnly).toBe(false);
    });

    it('an Owner or Admin is offered Delete', () => {
        const { getByRole } = render(<CanvasDocumentBar {...barProps(true, true)} />);
        expect(getByRole('button', { name: 'Delete' })).toBeTruthy();
    });
});

const RULES: AutomationRuleRow[] = [{
    id: 'rule-1', name: 'Notify owner on overdue task', triggerEvent: 'TASK_OVERDUE',
    actionType: 'NOTIFY_USER', status: 'ENABLED', priority: 10,
    executionCount: 0, lastTriggeredAt: null,
}];

const TENANT_CTX = {
    userId: 'user-1', tenantId: 'tenant-1', tenantSlug: 'acme', tenantName: 'Acme',
    role: 'READER' as const,
    permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
} as never;

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }) as Response;
        if (u.endsWith('/automation/rules')) return ok(RULES);
        if (u.includes('/automation/rules/rule-1')) return ok({ ...RULES[0], triggerFilterJson: null, actionConfigJson: {} });
        return ok([]);
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

async function renderRules(canManage: boolean) {
    const cache = new Map();
    const view = render(
        <SWRConfig value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={TENANT_CTX}>
                <KeyboardShortcutProvider>
                    <TooltipProvider><RulesTab tenantSlug="acme" canManage={canManage} /></TooltipProvider>
                </KeyboardShortcutProvider>
            </TenantProvider>
        </SWRConfig>,
    );
    await waitFor(() => expect(view.getByText('Notify owner on overdue task')).toBeTruthy());
    return view;
}

async function openRule(view: Awaited<ReturnType<typeof renderRules>>) {
    // The rules table has row selection, so the single click selects and the
    // DOUBLE click opens the rule's sheet.
    await act(async () => { fireEvent.doubleClick(view.getByText('Notify owner on overdue task')); });
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    return document.querySelector('[role="dialog"]') as HTMLElement;
}

describe('Processes rules — writes follow the server (#4640)', () => {
    it('without the Admin tier the list offers no Rule or Templates, and the sheet is read-only', async () => {
        const view = await renderRules(false);
        expect(view.queryByRole('button', { name: 'Rule' })).toBeNull();
        expect(view.queryByRole('button', { name: 'Templates' })).toBeNull();
        const sheet = await openRule(view);
        expect(sheet.querySelector('[role="switch"]')?.hasAttribute('disabled')).toBe(true);
        const labels = Array.from(sheet.querySelectorAll('button')).map((b) => b.textContent?.trim());
        expect(labels).not.toContain('Archive rule');
        expect(labels).not.toContain('Edit');
    });

    it('with the Admin tier every rule write is offered', async () => {
        const view = await renderRules(true);
        expect(view.getByRole('button', { name: 'Rule' })).toBeTruthy();
        expect(view.getByRole('button', { name: 'Templates' })).toBeTruthy();
        const sheet = await openRule(view);
        expect(sheet.querySelector('[role="switch"]')?.hasAttribute('disabled')).toBe(false);
        const labels = Array.from(sheet.querySelectorAll('button')).map((b) => b.textContent?.trim());
        expect(labels).toEqual(expect.arrayContaining(['Archive rule', 'Edit']));
    });
});
