/**
 * The custom roles page in the states its help guide describes (#4467):
 *
 *   - a FAILED list load shows an error state with the server's reason,
 *     never the empty state — an empty table under a failed load reads as
 *     "this workspace has no custom roles";
 *   - the empty state names the button that is actually on the page;
 *   - the back link and breadcrumb render once the page has loaded;
 *   - built-in role codes, every grid row and every grid column are shown as
 *     translated labels, and a grid cell's hint is a Tooltip naming the
 *     permission by its labels, never a `title=` carrying the raw key;
 *   - a permission the editor does not hold cannot be turned on, one the role
 *     already grants can be turned off, a role holding one cannot be saved
 *     until it is removed, and the server's refusal is re-said with labels;
 *   - Delete asks through a ConfirmDialog (never `window.confirm`), and its
 *     warning says members go back to the role on their own membership.
 *
 * `next-intl` is the repo's manual mock with ONE `t` per namespace, as the real
 * library returns: the manual mock mints a new function per render, which
 * re-creates the page's fetch callback and refetches on every render.
 */
import * as React from 'react';
import { render, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('next-intl', () => {
    const manual = jest.requireActual('../../__mocks__/next-intl.js');
    const cache = new Map<string, unknown>();
    return {
        ...manual,
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, manual.useTranslations(ns));
            return cache.get(ns);
        },
    };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/roles',
    useSearchParams: () => new URLSearchParams(),
}));

import CustomRolesPage from '@/app/t/[tenantSlug]/(app)/admin/roles/page';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPermissionsForRole, PERMISSION_SCHEMA, type PermissionSet } from '@/lib/permissions';
import type { Role } from '@prisma/client';

const en = require('../../messages/en.json');
const bg = require('../../messages/bg.json');
const R = en.admin.roles;

type Answer = { ok: boolean; status: number; body: unknown };
const ok = (body: unknown): Answer => ({ ok: true, status: 200, body });

const role = (id: string, name: string, baseRole: Role, extra: Partial<Record<string, unknown>> = {}) => ({
    id,
    name,
    description: null,
    baseRole,
    permissionsJson: getPermissionsForRole(baseRole),
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    _count: { memberships: 0 },
    ...extra,
});

interface Mount {
    list?: Answer | 'network-error';
    post?: Answer;
    patch?: Answer;
    del?: Answer;
    viewer?: 'OWNER' | 'ADMIN';
    /** The viewer's resolved permissions, when a custom role sets them. */
    held?: PermissionSet;
}

function mount(answers: Mount = {}) {
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        let a: Answer = ok([]);
        if (method === 'POST') a = answers.post ?? ok({});
        else if (method === 'PATCH') a = answers.patch ?? ok({});
        else if (method === 'DELETE') a = answers.del ?? ok({ membersCleared: 0 });
        else if (String(url).endsWith('/admin/roles')) {
            if (answers.list === 'network-error') throw new TypeError('Failed to fetch');
            a = answers.list ?? ok([]);
        }
        return { ok: a.ok, status: a.status, json: async () => a.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const viewer = answers.viewer ?? 'OWNER';
    // delayDuration 0 so a hovered cell's hint opens at once.
    render(
        <TooltipProvider delayDuration={0}>
            <TenantProvider
                value={{
                    userId: 'viewer',
                    tenantId: 'tenant-1',
                    tenantSlug: 'acme',
                    tenantName: 'Acme',
                    role: viewer,
                    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
                    appPermissions: answers.held ?? getPermissionsForRole(viewer),
                    modules: { processCanvas: false },
                }}
            >
                <CustomRolesPage />
            </TenantProvider>
        </TooltipProvider>,
    );
}

const byId = (id: string) => document.getElementById(id);
/** Waits for an element by id — `waitFor` alone settles on a `null` return. */
const waitForId = (id: string) =>
    waitFor(() => {
        const el = byId(id);
        if (!el) throw new Error(`#${id} never rendered`);
        return el;
    });
const fetchCalls = (method: string) =>
    (global.fetch as jest.Mock).mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === method);

async function loaded() {
    await waitFor(() => expect(byId('create-role-btn')).not.toBeNull());
}

/** Open the create form's grid. */
async function openCreateGrid() {
    await loaded();
    fireEvent.click(byId('create-role-btn')!);
    fireEvent.click(await waitForId('toggle-permissions-btn'));
    await waitFor(() => expect(byId('perm-controls-view')).not.toBeNull());
}

const DOMAINS = Object.keys(PERMISSION_SCHEMA) as (keyof PermissionSet)[];
const ACTIONS = Array.from(new Set(Object.values(PERMISSION_SCHEMA).flat()));
const permissionLabel = (domain: string, action: string) =>
    `${en.admin.resourceLabels[domain]}: ${R.actions[action]}`;

describe('custom roles page — a failed list load', () => {
    it("shows an error state with the server's reason, and never the empty state", async () => {
        mount({
            list: {
                ok: false,
                status: 403,
                body: { error: { code: 'FORBIDDEN', message: 'Permission denied.' } },
            },
        });
        const state = await screen.findByTestId('roles-load-error');
        expect(state).toHaveTextContent(R.loadFailed);
        expect(state).toHaveTextContent('Permission denied.');
        expect(screen.queryByText(/No custom roles defined yet/)).toBeNull();
        // No "0 custom roles defined" over a list that did not load.
        expect(screen.queryByText(/custom roles? defined/)).toBeNull();
    });

    it('a network failure shows the same state', async () => {
        mount({ list: 'network-error' });
        const state = await screen.findByTestId('roles-load-error');
        expect(state).toHaveTextContent(R.loadFailed);
        expect(screen.queryByText(/No custom roles defined yet/)).toBeNull();
    });

    it('Try again reloads, and a successful reload shows the table', async () => {
        mount({ list: { ok: false, status: 500, body: { error: { code: 'INTERNAL', message: 'Boom.' } } } });
        const state = await screen.findByTestId('roles-load-error');
        const fetchMock = global.fetch as jest.Mock;
        fetchMock.mockImplementation(async () =>
            ({ ok: true, status: 200, json: async () => [role('cr-1', 'Compliance Lead', 'EDITOR')] }) as unknown as Response,
        );
        fireEvent.click(within(state).getByRole('button', { name: en.common.error.tryAgain }));
        await screen.findByText('Compliance Lead');
        expect(screen.queryByTestId('roles-load-error')).toBeNull();
    });
});

describe('custom roles page — the empty state, back link and breadcrumb', () => {
    it('names the button that is on the page', async () => {
        mount();
        await loaded();
        const button = byId('create-role-btn')!;
        expect(button).toHaveTextContent(R.addRole);
        const empty = await screen.findByText(/No custom roles defined yet/);
        expect(empty).toHaveTextContent(`"${R.addRole}"`);
        expect(empty).not.toHaveTextContent(R.createTitle);
    });

    it('renders the back link and breadcrumb once the page has loaded', async () => {
        mount();
        await loaded();
        expect(screen.getByTestId('page-header-back')).toBeInTheDocument();
        expect(screen.getByRole('navigation', { name: en.common.ui.breadcrumb })).toHaveTextContent(R.crumbSelf);
    });

    it('the table offers no row selection — nothing on the page acts on it', async () => {
        mount({ list: ok([role('cr-1', 'Compliance Lead', 'EDITOR')]) });
        await screen.findByText('Compliance Lead');
        expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    });
});

describe('custom roles page — labels, not codes', () => {
    it('the Base Role badge shows the translated role', async () => {
        mount({ list: ok([role('cr-1', 'Compliance Lead', 'EDITOR')]) });
        const row = (await screen.findByText('Compliance Lead')).closest('tr')!;
        expect(row).toHaveTextContent(en.roles.EDITOR);
        expect(row).not.toHaveTextContent('EDITOR');
    });

    it('the preset buttons and the base-role options show translated roles', async () => {
        mount();
        await openCreateGrid();
        for (const r of ['ADMIN', 'EDITOR', 'AUDITOR', 'READER']) {
            expect(byId(`preset-${r}`)).toHaveTextContent(new RegExp(`^${en.roles[r]}$`));
        }
        expect(byId('role-base-select')).toHaveTextContent(en.roles.READER);
        expect(byId('role-base-select')).not.toHaveTextContent('READER');
    });

    it('every grid row and every grid column has a catalogue label, in both locales', () => {
        // The grid falls back to the raw key when the catalogue lacks one, so
        // a missing label is caught here rather than by a reader of the page.
        const missing: string[] = [];
        for (const [name, cat] of [['en', en], ['bg', bg]] as const) {
            for (const d of DOMAINS) if (!cat.admin.resourceLabels[d]) missing.push(`${name} resourceLabels.${d}`);
            for (const a of ACTIONS) if (!cat.admin.roles.actions[a]) missing.push(`${name} roles.actions.${a}`);
        }
        expect(missing).toEqual([]);
    });

    it('the grid shows those labels: rows, column headings and each cell\'s accessible name', async () => {
        mount();
        await openCreateGrid();
        const grid = byId('perm-controls-view')!.closest('table')!;
        const headings = Array.from(grid.querySelectorAll('thead th')).slice(1).map((th) => th.textContent);
        expect(headings).toEqual(ACTIONS.map((a) => R.actions[a]));
        for (const d of DOMAINS) {
            const first = byId(`perm-${d}-${PERMISSION_SCHEMA[d][0]}`)!;
            expect(first.closest('tr')!.querySelector('td')).toHaveTextContent(en.admin.resourceLabels[d]);
        }
        const cell = byId('perm-access_reviews-decide')!;
        expect(cell).toHaveAccessibleName(permissionLabel('access_reviews', 'decide'));
        expect(cell).not.toHaveAttribute('title');
    });

    it("a cell's hint is a Tooltip naming the permission by its labels", async () => {
        mount();
        await openCreateGrid();
        const user = userEvent.setup();
        const cell = byId('perm-identity_reconciliation-confirm')!;
        // A new role starts from READER's defaults, which do not grant this.
        expect(cell).toHaveAttribute('aria-pressed', 'false');
        await user.hover(cell);
        const tip = await screen.findByRole('tooltip');
        expect(tip).toHaveTextContent(
            R.cellNotGranted.replace('{permission}', permissionLabel('identity_reconciliation', 'confirm')),
        );
        expect(tip).not.toHaveTextContent('identity_reconciliation');
    });
});

describe('custom roles page — permissions the editor does not hold', () => {
    const OWNER_ONLY = ['tenant_lifecycle', 'owner_management', 'agent_ownership'];

    it('an Admin cannot turn on an Owner-only permission, and can turn on one they hold', async () => {
        mount({ viewer: 'ADMIN' });
        await openCreateGrid();
        expect(byId('roles-not-held-hint')).toHaveTextContent(R.notHeldHint);
        for (const action of OWNER_ONLY) {
            const cell = byId(`perm-admin-${action}`)!;
            expect(cell).toHaveAttribute('aria-disabled', 'true');
            fireEvent.click(cell);
            expect(cell).toHaveAttribute('aria-pressed', 'false');
        }
        const held = byId('perm-admin-members')!;
        expect(held).not.toHaveAttribute('aria-disabled');
        const before = held.getAttribute('aria-pressed');
        fireEvent.click(held);
        expect(held.getAttribute('aria-pressed')).not.toBe(before);
    });

    it('an Owner sees no permission greyed out for want of holding it', async () => {
        mount({ viewer: 'OWNER' });
        await openCreateGrid();
        expect(byId('roles-not-held-hint')).toBeNull();
        // The one greyed cell on the default Reader base is the base role's
        // rule, not the Owner's: Personnel / manage needs an Admin base (#4536).
        const greyed = Array.from(document.querySelectorAll('[id^="perm-"][aria-disabled="true"]')).map((el) => el.id);
        expect(greyed).toEqual(['perm-personnel-manage']);
    });

    it('a preset never grants what the editor does not hold', async () => {
        // An Admin membership whose custom role holds Admin's set less SSO
        // and evidence downloads: the Admin preset would grant both.
        const admin = getPermissionsForRole('ADMIN');
        const held: PermissionSet = {
            ...admin,
            admin: { ...admin.admin, sso: false },
            evidence: { ...admin.evidence, download: false },
        };
        mount({ viewer: 'ADMIN', held });
        await openCreateGrid();
        fireEvent.click(byId('preset-ADMIN')!);
        expect(byId('perm-admin-sso')).toHaveAttribute('aria-pressed', 'false');
        expect(byId('perm-evidence-download')).toHaveAttribute('aria-pressed', 'false');
        expect(byId('perm-admin-manage')).toHaveAttribute('aria-pressed', 'true');
        expect(byId('perm-evidence-upload')).toHaveAttribute('aria-pressed', 'true');
        expect(byId('role-exceeds-held')).toBeNull();
    });

    it('an Admin editing a role that holds one is told, cannot save, and can remove it to save', async () => {
        const ownerBuilt = role('cr-owner', 'Owner built', 'ADMIN', {
            permissionsJson: getPermissionsForRole('OWNER'),
        });
        mount({ viewer: 'ADMIN', list: ok([ownerBuilt]) });
        await screen.findByText('Owner built');
        fireEvent.click(byId('edit-role-cr-owner')!);

        const notice = await waitForId('role-exceeds-held');
        expect(notice).toHaveTextContent(permissionLabel('admin', 'tenant_lifecycle'));
        expect(notice).not.toHaveTextContent('admin.tenant_lifecycle');
        expect(byId('role-submit-btn')).toBeDisabled();

        // Granted but not held: the toggle turns it OFF (the server accepts a
        // narrowed role), and once off it cannot come back on.
        for (const action of OWNER_ONLY) {
            const cell = byId(`perm-admin-${action}`)!;
            expect(cell).not.toHaveAttribute('aria-disabled');
            fireEvent.click(cell);
            expect(cell).toHaveAttribute('aria-pressed', 'false');
            expect(cell).toHaveAttribute('aria-disabled', 'true');
        }
        expect(byId('role-exceeds-held')).toBeNull();
        expect(byId('role-submit-btn')).not.toBeDisabled();
    });

    it("the server's refusal is re-said with labels, not keys", async () => {
        mount({
            viewer: 'ADMIN',
            post: {
                ok: false,
                status: 403,
                body: {
                    error: {
                        code: 'FORBIDDEN',
                        message: 'Cannot grant permissions you do not hold: admin.tenant_lifecycle.',
                        details: { reason: 'CUSTOM_ROLE_GRANT_EXCEEDS_HOLDER', exceeded: ['admin.tenant_lifecycle'] },
                    },
                },
            },
        });
        await loaded();
        fireEvent.click(byId('create-role-btn')!);
        fireEvent.change(await waitForId('role-name-input'), { target: { value: 'Raced' } });
        fireEvent.click(byId('role-submit-btn')!);
        const notice = await waitForId('roles-error');
        expect(notice).toHaveTextContent(
            R.grantRefused.replace('{permissions}', permissionLabel('admin', 'tenant_lifecycle')),
        );
        expect(notice).not.toHaveTextContent('admin.tenant_lifecycle');
    });

    it('any other refusal is the server\'s own sentence', async () => {
        mount({
            post: {
                ok: false,
                status: 400,
                body: { error: { code: 'BAD_REQUEST', message: 'A custom role named "X" already exists in this tenant.' } },
            },
        });
        await loaded();
        fireEvent.click(byId('create-role-btn')!);
        fireEvent.change(await waitForId('role-name-input'), { target: { value: 'X' } });
        fireEvent.click(byId('role-submit-btn')!);
        const notice = await waitForId('roles-error');
        expect(notice).toHaveTextContent('A custom role named "X" already exists in this tenant.');
    });
});

describe('custom roles page — Delete', () => {
    it('asks through a ConfirmDialog, never window.confirm, and Cancel sends nothing', async () => {
        const confirmSpy = jest.spyOn(window, 'confirm').mockImplementation(() => true);
        mount({ list: ok([role('cr-1', 'Compliance Lead', 'EDITOR', { _count: { memberships: 3 } })]) });
        await screen.findByText('Compliance Lead');
        fireEvent.click(byId('delete-role-cr-1')!);

        const dialog = await screen.findByRole('dialog');
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(dialog).toHaveTextContent(R.deleteTitle.replace('{name}', 'Compliance Lead'));
        expect(dialog).toHaveTextContent(R.deleteDesc);
        fireEvent.click(within(dialog).getByRole('button', { name: R.cancel }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(fetchCalls('DELETE')).toHaveLength(0);
        confirmSpy.mockRestore();
    });

    it('Delete role sends the DELETE and reports how many members went back', async () => {
        mount({
            list: ok([role('cr-1', 'Compliance Lead', 'EDITOR', { _count: { memberships: 2 } })]),
            del: ok({ membersCleared: 2 }),
        });
        await screen.findByText('Compliance Lead');
        fireEvent.click(byId('delete-role-cr-1')!);
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: R.deleteConfirmLabel }));
        await waitFor(() => expect(fetchCalls('DELETE')).toHaveLength(1));
        expect(String(fetchCalls('DELETE')[0][0])).toMatch(/\/admin\/roles\/cr-1$/);
        await waitForId('roles-success');
    });

    it('the member warning says members go back to their own membership role, not the base role', () => {
        // The delete clears `customRoleId`; a membership then resolves to its
        // OWN role (`resolveTenantContext`), not the custom role's base.
        expect(R.deleteMemberWarning).toMatch(/role on their own membership/);
        expect(R.deleteMemberWarning).not.toMatch(/base role/i);
        expect(bg.admin.roles.deleteMemberWarning).toMatch(/ролята на собственото си членство/);
        expect(bg.admin.roles.deleteMemberWarning).not.toMatch(/базов/i);
    });
});

describe('custom roles page — Personnel / manage needs an Admin base (#4536)', () => {
    const legacyBlob = () => {
        const p = getPermissionsForRole('READER');
        return { ...p, personnel: { view: false, manage: true } };
    };

    it('on a Reader base the cell is locked, and an Admin preset does not turn it on', async () => {
        mount();
        await openCreateGrid();
        const cell = byId('perm-personnel-manage')!;
        expect(cell).toHaveAttribute('aria-disabled', 'true');
        fireEvent.click(cell);
        expect(cell).toHaveAttribute('aria-pressed', 'false');
        fireEvent.click(byId('preset-ADMIN')!);
        expect(byId('perm-personnel-manage')).toHaveAttribute('aria-pressed', 'false');
        // The read is not this rule's: the Admin preset still grants it.
        expect(byId('perm-personnel-view')).toHaveAttribute('aria-pressed', 'true');
    });

    it('a legacy Reader-based role holding it is told, cannot save, and can switch it off to save', async () => {
        mount({ list: ok([role('cr-legacy', 'Legacy roster', 'READER', { permissionsJson: legacyBlob() })]) });
        await screen.findByText('Legacy roster');
        fireEvent.click(byId('edit-role-cr-legacy')!);
        const notice = await waitForId('role-manage-needs-admin-base');
        expect(notice).toHaveTextContent(permissionLabel('personnel', 'manage'));
        expect(byId('role-submit-btn')).toBeDisabled();

        const cell = byId('perm-personnel-manage')!;
        expect(cell).not.toHaveAttribute('aria-disabled');
        fireEvent.click(cell);
        expect(cell).toHaveAttribute('aria-pressed', 'false');
        // Once off it cannot come back on this base.
        expect(cell).toHaveAttribute('aria-disabled', 'true');
        expect(byId('role-manage-needs-admin-base')).toBeNull();
        expect(byId('role-submit-btn')).not.toBeDisabled();
    });

    it("the server's refusal is said in the page's own words", async () => {
        mount({
            post: {
                ok: false,
                status: 400,
                body: {
                    error: {
                        code: 'VALIDATION_ERROR',
                        message: 'Only a custom role based on Admin can manage the personnel roster.',
                        details: { reason: 'PERSONNEL_MANAGE_NEEDS_ADMIN_BASE' },
                    },
                },
            },
        });
        await loaded();
        fireEvent.click(byId('create-role-btn')!);
        fireEvent.change(await waitForId('role-name-input'), { target: { value: 'Raced' } });
        fireEvent.click(byId('role-submit-btn')!);
        const notice = await waitForId('roles-error');
        expect(notice).toHaveTextContent(
            R.manageNeedsAdminBaseNotice.replace('{permission}', permissionLabel('personnel', 'manage')),
        );
    });

    it('both locales name the rule', () => {
        for (const cat of [en, bg]) {
            expect(typeof cat.admin.roles.cellNeedsAdminBase).toBe('string');
            expect(typeof cat.admin.roles.manageNeedsAdminBaseNotice).toBe('string');
        }
    });
});
