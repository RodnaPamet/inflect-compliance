/**
 * The Entra group-mappings section and the AI_ADMIN role (#3699 deploy 2).
 *
 * A tenant may map a group to AI_ADMIN, but a mapping that yields it is an
 * OWNER's change, as on the members page: the role picker offers "AI admin" to
 * an OWNER only, every row reads its role's label, and an ADMIN cannot remove
 * an AI_ADMIN mapping. Choosing it shows the tie rule beside the priority — an
 * equal-priority tie against Admin, Editor or Auditor decides nothing.
 *
 * Each "not offered" is paired with an "offered" on the same render path.
 */
import type { Role } from '@prisma/client';
import * as React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';

import { GroupMappingsSection } from '@/app/t/[tenantSlug]/(app)/admin/entra/GroupMappingsSection';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPermissionsForRole } from '@/lib/permissions';

const MAPPINGS = [
    { id: 'map-ai', aadGroupId: 'g-ai', aadGroupName: 'AI_Admin', role: 'AI_ADMIN', priority: 10 },
    { id: 'map-ed', aadGroupId: 'g-ed', aadGroupName: 'Editors', role: 'EDITOR', priority: 0 },
];

function renderAs(role: Extract<Role, 'OWNER' | 'ADMIN'>) {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => MAPPINGS }) as unknown as Response) as unknown as typeof fetch;
    render(
        <TooltipProvider>
            <TenantProvider
                value={{
                    userId: 'viewer',
                    tenantId: 'tenant-1',
                    tenantSlug: 'acme',
                    tenantName: 'Acme',
                    role,
                    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
                    appPermissions: getPermissionsForRole(role),
                    modules: { processCanvas: false },
                }}
            >
                <GroupMappingsSection apiUrl={(p) => `/api/t/acme${p}`} />
            </TenantProvider>
        </TooltipProvider>,
    );
}

const optionLabels = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map((o) => o.textContent?.trim() ?? '');

async function roleOptions(): Promise<string[]> {
    return waitFor(() => {
        if (optionLabels().length === 0) fireEvent.click(document.getElementById('entra-mapping-role')!);
        const labels = optionLabels();
        if (labels.length === 0) throw new Error('no options rendered');
        return labels;
    });
}

const removeButton = (name: string) =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="Remove mapping for ${name}"]`);

describe('Entra group mappings — AI_ADMIN', () => {
    it('an OWNER is offered "AI admin", labelled', async () => {
        renderAs('OWNER');
        expect((await roleOptions()).sort()).toEqual(['AI admin', 'Admin', 'Auditor', 'Editor', 'Reader']);
    });

    it('an ADMIN is offered the same list without it', async () => {
        renderAs('ADMIN');
        expect((await roleOptions()).sort()).toEqual(['Admin', 'Auditor', 'Editor', 'Reader']);
    });

    it('rows read their role labels, not enum values', async () => {
        renderAs('ADMIN');
        await waitFor(() => expect(removeButton('AI_Admin')).not.toBeNull());
        const text = document.body.textContent ?? '';
        expect(text).toContain('AI admin');
        expect(text).not.toContain('AI_ADMIN');
    });

    it('an ADMIN cannot remove an AI_ADMIN mapping, and can remove any other', async () => {
        renderAs('ADMIN');
        await waitFor(() => expect(removeButton('AI_Admin')).not.toBeNull());
        expect(removeButton('AI_Admin')).toBeDisabled();
        expect(removeButton('Editors')).not.toBeDisabled();
    });

    it('an OWNER can remove it', async () => {
        renderAs('OWNER');
        await waitFor(() => expect(removeButton('AI_Admin')).not.toBeNull());
        expect(removeButton('AI_Admin')).not.toBeDisabled();
    });

    it('choosing AI admin shows the tie rule where the priority is set', async () => {
        renderAs('OWNER');
        const hintText = 'AI admin never wins a priority tie';
        expect(document.body.textContent).not.toContain(hintText);
        await roleOptions();
        fireEvent.click(
            Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
                (o) => o.textContent?.trim() === 'AI admin',
            )!,
        );
        await waitFor(() => expect(document.body.textContent).toContain(hintText));
    });
});
