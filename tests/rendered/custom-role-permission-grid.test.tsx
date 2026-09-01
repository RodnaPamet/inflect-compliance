/**
 * The custom-role permission grid must offer EVERY permission the
 * runtime can enforce.
 *
 * `src/lib/permissions.ts` owns `PermissionSet` / `PERMISSION_SCHEMA`.
 * The roles page used to carry two hand-written copies of that list —
 * a full action map, and a shorter `RESOURCE_KEYS` array right beside
 * it that drove the row labels — and both had drifted (#2225):
 *
 *   • `assets` / `personnel` / `incidents` were absent from
 *     `RESOURCE_KEYS`, so their rows rendered with an EMPTY label cell.
 *   • `reports` stopped at `['view','export']`, so
 *     `reports.schedule_external` had no toggle.
 *   • `admin` stopped at `['view','manage','members','sso','scim']`, so
 *     `tenant_lifecycle` and `owner_management` — the two flags that
 *     separate OWNER from ADMIN — plus both DSAR flags had no toggle.
 *     A custom role could not be given or denied them through the UI
 *     at all.
 *
 * These assertions DERIVE their expectations from `PERMISSION_SCHEMA`
 * itself rather than restating the list, so they cannot become a
 * fourth mirror: adding a domain or an action to the type extends what
 * this test demands with no edit here.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme-corp' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme-corp/admin/roles',
    useSearchParams: () => new URLSearchParams(),
}));

import CustomRolesPage from '@/app/t/[tenantSlug]/(app)/admin/roles/page';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
    PERMISSION_SCHEMA,
    getPermissionsForRole,
    type PermissionSet,
} from '@/lib/permissions';

const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme-corp',
    tenantName: 'Acme Corp',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
};

/** Renders the page and opens the create-role form's permission grid. */
async function renderGrid() {
    render(
        <TooltipProvider>
            <TenantProvider value={TENANT_CTX}>
                <CustomRolesPage />
            </TenantProvider>
        </TooltipProvider>,
    );

    // The page fetches its role list on mount; wait for the create
    // trigger rather than for a role row, so the harness does not
    // depend on any seeded data.
    const createBtn = await waitFor(() => {
        const el = document.getElementById('create-role-btn');
        if (!el) throw new Error('create-role-btn never rendered');
        return el;
    });
    fireEvent.click(createBtn);

    const toggle = await waitFor(() => {
        const el = document.getElementById('toggle-permissions-btn');
        if (!el) throw new Error('permission-grid toggle never rendered');
        return el;
    });
    fireEvent.click(toggle);

    await waitFor(() => {
        if (!document.getElementById('perm-controls-view')) {
            throw new Error('permission grid never rendered');
        }
    });
}

beforeEach(() => {
    global.fetch = jest.fn(async () =>
        ({ ok: true, json: async () => [] }) as unknown as Response,
    ) as unknown as typeof fetch;
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('custom-role permission grid — coverage of PERMISSION_SCHEMA', () => {
    const DOMAINS = Object.keys(PERMISSION_SCHEMA) as (keyof PermissionSet)[];

    it('is derived from a schema with more than one domain', () => {
        // Guards the derivation itself: were `PERMISSION_SCHEMA` ever to
        // resolve empty, the loops below would vacuously pass. No render —
        // this one is free.
        expect(DOMAINS.length).toBeGreaterThan(10);
    });

    it('the schema declares every action the runtime actually has — both dimensions', () => {
        // The domain KEYS are type-locked by `Record<keyof PermissionSet, ...>`,
        // so tsc catches a missing domain. The ACTION lists are `string[]` and
        // are checked against nothing: add `admin.break_glass` to PermissionSet
        // and forget it in PERMISSION_SCHEMA, and tsc passes, this file's other
        // assertions pass, and the flag silently has no toggle, is rejected by
        // validatePermissionsJson and is never inspected by permissionsExceeding.
        //
        // Comparing against an OWNER's resolved permissions closes that: OWNER
        // is the only role that holds every flag, so its key set IS the runtime
        // inventory. This became writable the moment PERMISSION_SCHEMA was
        // exported, which is the point of exporting it.
        const owner = getPermissionsForRole('OWNER');
        for (const domain of DOMAINS) {
            const declared = [...PERMISSION_SCHEMA[domain]].sort();
            const actual = Object.keys(owner[domain] as Record<string, boolean>).sort();
            expect({ domain, declared }).toEqual({ domain, declared: actual });
        }
    });

    /**
     * Mounting the whole roles page is the expensive part of this file, so
     * the three grid invariants share ONE render — and they are reported as
     * one object rather than three sequential `expect`s, because Jest stops
     * at the first failing assertion. Aggregating means a single run names
     * EVERY missing toggle, unlabelled row and missing label at once, which
     * is what makes the failure output actionable rather than a game of
     * whack-a-mole.
     */
    it('offers a labelled row and a toggle for every permission the runtime enforces', async () => {
        await renderGrid();

        // 1. Every (domain, action) pair has a toggle.
        const missingToggles: string[] = [];
        for (const domain of DOMAINS) {
            for (const action of PERMISSION_SCHEMA[domain]) {
                if (!document.getElementById(`perm-${domain}-${action}`)) {
                    missingToggles.push(`${domain}.${action}`);
                }
            }
        }

        // 2. Every domain's row carries a non-empty label. The drift's
        //    signature was a row that rendered with an EMPTY first cell,
        //    which no toggle assertion would have caught.
        const unlabelled: string[] = [];
        for (const domain of DOMAINS) {
            const anyToggle = document.getElementById(
                `perm-${domain}-${PERMISSION_SCHEMA[domain][0]}`,
            );
            const labelCell = anyToggle?.closest('tr')?.querySelector('td');
            if (!labelCell || labelCell.textContent?.trim() === '') {
                unlabelled.push(domain);
            }
        }

        // 3. The three domains `RESOURCE_KEYS` had dropped are labelled with
        //    their real English names — not blank, and not the raw-key
        //    fallback that covers a domain whose translation has not landed.
        const grid = document.getElementById('perm-controls-view')?.closest('table') ?? null;
        const gridText = grid?.textContent ?? '';
        const missingLabels = ['Assets', 'Personnel', 'Incidents'].filter(
            (label) => !gridText.includes(label),
        );

        // 4. No column header shows a raw snake_case key. Deriving the grid
        //    from the full schema introduced five multi-word actions —
        //    schedule_external, tenant_lifecycle, owner_management and the two
        //    compliance_dsar_* flags. The deleted mirror held only single-word
        //    actions, so `capitalize` alone was enough until it went; an
        //    underscore reached the user the moment the grid became complete.
        const rawHeaders = Array.from(document.querySelectorAll('th'))
            .map((th) => th.textContent ?? '')
            .filter((h) => h.includes('_'));

        expect({ missingToggles, unlabelled, missingLabels, rawHeaders }).toEqual({
            missingToggles: [],
            unlabelled: [],
            missingLabels: [],
            rawHeaders: [],
        });
    });
});
