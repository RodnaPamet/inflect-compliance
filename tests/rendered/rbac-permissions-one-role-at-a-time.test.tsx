/** @jest-environment jsdom */

/**
 * The permission matrix on a phone: a role is picked from a strip of tabs and
 * that role's permissions are listed in one column, grouped by resource, each
 * saying in words whether the role has it.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { RolePermissionsByRole, type RolePermissionGroup } from '@/app/t/[tenantSlug]/(app)/admin/rbac/RolePermissionsByRole';

const EN = jest.requireActual('../../messages/en.json') as {
    admin: { rbac: { byRole: Record<string, string> } };
};
const T = EN.admin.rbac.byRole;

const ROLES = [
    { value: 'OWNER', label: 'Owner' },
    { value: 'EDITOR', label: 'Editor' },
    { value: 'READER', label: 'Reader' },
];

const GROUPS: RolePermissionGroup[] = [
    {
        resource: 'risks',
        label: 'Risks',
        actions: [
            { action: 'view', label: 'View', grantedTo: ['OWNER', 'EDITOR', 'READER'] },
            { action: 'create', label: 'Create', grantedTo: ['OWNER', 'EDITOR'] },
        ],
    },
    {
        resource: 'admin',
        label: 'Administration',
        actions: [{ action: 'manage', label: 'Manage', grantedTo: ['OWNER'] }],
    },
];

const granted = (key: string) => screen.getByTestId(`rbac-permission-${key}`).getAttribute('data-granted');

describe('permissions, one role at a time', () => {
    it('opens on the viewer\'s own role, grouped by resource as the table is', () => {
        render(<RolePermissionsByRole roles={ROLES} groups={GROUPS} initialRole="EDITOR" />);
        expect(screen.getByRole('tab', { name: 'Editor' })).toHaveAttribute('aria-selected', 'true');
        const panel = screen.getByRole('tabpanel');
        expect(within(panel).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
            'Risks',
            'Administration',
        ]);
        expect(granted('risks.create')).toBe('true');
        expect(granted('admin.manage')).toBe('false');
        expect(screen.getByTestId('rbac-permission-admin.manage')).toHaveTextContent(T.notGranted);
        expect(screen.getByTestId('rbac-permission-risks.create')).toHaveTextContent(T.granted);
    });

    it('switches to another role\'s permissions when its tab is chosen', async () => {
        render(<RolePermissionsByRole roles={ROLES} groups={GROUPS} initialRole="EDITOR" />);
        await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Reader' })); });
        expect(screen.getByRole('tab', { name: 'Reader' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tab', { name: 'Editor' })).toHaveAttribute('aria-selected', 'false');
        expect(granted('risks.view')).toBe('true');
        expect(granted('risks.create')).toBe('false');

        await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Owner' })); });
        expect(granted('admin.manage')).toBe('true');
        expect(screen.getByTestId('rbac-role-summary')).toHaveTextContent('Owner');
    });

    it('moves between roles with the arrow keys, as a tablist should', async () => {
        render(<RolePermissionsByRole roles={ROLES} groups={GROUPS} initialRole="OWNER" />);
        await act(async () => { fireEvent.keyDown(screen.getByRole('tab', { name: 'Owner' }), { key: 'ArrowRight' }); });
        expect(screen.getByRole('tab', { name: 'Editor' })).toHaveAttribute('aria-selected', 'true');
        expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Editor' }));
        await act(async () => { fireEvent.keyDown(screen.getByRole('tab', { name: 'Editor' }), { key: 'End' }); });
        expect(screen.getByRole('tab', { name: 'Reader' })).toHaveAttribute('aria-selected', 'true');
    });

    it('says the strip scrolls: the role tabs sit in the shared cue strip', () => {
        render(<RolePermissionsByRole roles={ROLES} groups={GROUPS} initialRole="AI_ADMIN" />);
        const strip = screen.getByTestId('rbac-role-tabs');
        expect(strip.hasAttribute('data-scroll-cue-strip')).toBe(true);
        expect(within(strip).getByRole('tablist')).toBeInTheDocument();
        // A viewer whose role is not a built-in column starts on the first.
        expect(screen.getByRole('tab', { name: 'Owner' })).toHaveAttribute('aria-selected', 'true');
        // Every tab is a touch-sized target.
        for (const tab of screen.getAllByRole('tab')) expect(tab.className).toContain('min-h-11');
    });
});
