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
import { ADMIN_BASE_ONLY_PERMISSIONS } from '@/lib/custom-role-admin-base-rule';

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
    /**
     * The membership's own role (#4587), which the edge reads. Defaults to
     * `viewer`; `null` leaves it out, which is not admitted.
     */
    membershipRole?: Role | null;
    /** The coarse admin tier — a custom role's BASE decides it. */
    canAdmin?: boolean;
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
                    permissions: {
                        canRead: true,
                        canWrite: true,
                        canAdmin: answers.canAdmin ?? true,
                        canAudit: true,
                        canExport: true,
                    },
                    appPermissions: answers.held ?? getPermissionsForRole(viewer),
                    ...(answers.membershipRole === null ? {} : { membershipRole: answers.membershipRole ?? viewer }),
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
        // A key the Admin holds that the default Reader base may carry too
        // (`admin.members` needs an Admin base, #4581 A).
        const held = byId('perm-admin-view')!;
        expect(held).not.toHaveAttribute('aria-disabled');
        const before = held.getAttribute('aria-pressed');
        fireEvent.click(held);
        expect(held.getAttribute('aria-pressed')).not.toBe(before);
    });

    it('an Owner sees no permission greyed out for want of holding it', async () => {
        mount({ viewer: 'OWNER' });
        await openCreateGrid();
        expect(byId('roles-not-held-hint')).toBeNull();
        // The greyed cells on the default Reader base are the base role's
        // rule, not the Owner's: the Admin-base-only permissions (#4536, #4581 A).
        const greyed = Array.from(document.querySelectorAll('[id^="perm-"][aria-disabled="true"]')).map((el) => el.id);
        expect(greyed.sort()).toEqual(ADMIN_BASE_ONLY_PERMISSIONS.map((k) => `perm-${k.replace('.', '-')}`).sort());
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
        // Granted from the preset (the default Reader base may carry them; the
        // Admin-base-only ones are this rule's, tested below).
        expect(byId('perm-admin-view')).toHaveAttribute('aria-pressed', 'true');
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

/**
 * #4467 findings 6 and 9 — create, change and delete are offered only where
 * every gate would let the request through: the edge (an Owner or Admin
 * MEMBERSHIP), the routes' `admin.manage`, and the usecases' coarse admin tier
 * (a custom role's base).
 */
describe('custom roles page — writes offered only where the server takes them', () => {
    const listed = () => ok([role('cr-1', 'Compliance Lead', 'EDITOR')]);

    it('an Owner is offered create, edit and delete, and sees no notice', async () => {
        mount({ list: listed() });
        await screen.findByText('Compliance Lead');
        expect(byId('create-role-btn')).not.toBeNull();
        expect(byId('edit-role-cr-1')).not.toBeNull();
        expect(byId('delete-role-cr-1')).not.toBeNull();
        expect(byId('roles-manage-refused')).toBeNull();
    });

    it('an Editor membership whose custom role grants admin.manage — the edge refuses it — is offered none', async () => {
        mount({ list: listed(), membershipRole: 'EDITOR', held: getPermissionsForRole('ADMIN') });
        await screen.findByText('Compliance Lead');
        expect(byId('create-role-btn')).toBeNull();
        expect(byId('edit-role-cr-1')).toBeNull();
        expect(byId('delete-role-cr-1')).toBeNull();
        expect(byId('roles-manage-refused')).toHaveTextContent(R.manageRefusedNotice);
    });

    it('an Admin membership on a Reader-based custom role granting admin.manage — the usecase refuses it — is offered none', async () => {
        mount({ list: listed(), membershipRole: 'ADMIN', held: getPermissionsForRole('ADMIN'), canAdmin: false });
        await screen.findByText('Compliance Lead');
        expect(byId('create-role-btn')).toBeNull();
        expect(byId('delete-role-cr-1')).toBeNull();
        expect(byId('roles-manage-refused')).not.toBeNull();
    });

    it('a viewer without admin.manage — the route refuses it — is offered none', async () => {
        const admin = getPermissionsForRole('ADMIN');
        mount({ list: listed(), membershipRole: 'ADMIN', held: { ...admin, admin: { ...admin.admin, manage: false } } });
        await screen.findByText('Compliance Lead');
        expect(byId('create-role-btn')).toBeNull();
        expect(byId('roles-manage-refused')).not.toBeNull();
    });

    it('a context with no membership role is offered none: absent is not admitted (#4587)', async () => {
        mount({ list: listed(), membershipRole: null });
        await screen.findByText('Compliance Lead');
        expect(byId('create-role-btn')).toBeNull();
        expect(byId('edit-role-cr-1')).toBeNull();
        expect(byId('roles-manage-refused')).not.toBeNull();
    });
});

/**
 * Owner decision, 2026-10-30 — while members who are not Admins carry a role, it
 * may not be built on Admin or grant an admin key only an Admin membership may
 * carry. The form locks what a save would be refused for, as the server judges
 * it: against the role as stored.
 */
describe('custom roles page — a role carried by members who are not Admins', () => {
    // All ten (owner decisions, 2026-10-30): the six only the admin API reads,
    // and the four refused by decision although they are live elsewhere.
    const ADMIN_ONLY = [
        'sso',
        'agent_tool_exposure',
        'agent_policy_card',
        'agent_ownership',
        'agent_skill_review',
        'agent_skill_author',
        'scim',
        'compliance_dsar_manage',
        'agent_harness_ingest',
        'agent_external_tools',
    ];

    async function editRole(extra: Partial<Record<string, unknown>>, base: Role = 'READER') {
        mount({ list: ok([role('cr-1', 'Carried', base, extra)]) });
        await screen.findByText('Carried');
        fireEvent.click(byId('edit-role-cr-1')!);
        await waitForId('perm-admin-sso');
    }

    it('says why, naming the permissions by their labels, and locks each one', async () => {
        await editRole({ nonAdminCarriers: 2 });
        const notice = byId('role-admin-membership-only')!;
        for (const key of ADMIN_ONLY) expect(notice).toHaveTextContent(permissionLabel('admin', key));
        expect(notice).not.toHaveTextContent('admin.agent');
        for (const key of ADMIN_ONLY) {
            const cell = byId(`perm-admin-${key}`)!;
            expect(cell).toHaveAttribute('aria-disabled', 'true');
            fireEvent.click(cell);
            expect(cell).toHaveAttribute('aria-pressed', 'false');
        }
        // An admin key not on the list stays switchable.
        const view = byId('perm-admin-agent_registry_view')!;
        expect(view).not.toHaveAttribute('aria-disabled');
        fireEvent.click(view);
        expect(view).toHaveAttribute('aria-pressed', 'true');
        expect(byId('role-submit-btn')).not.toBeDisabled();
    });

    it("a locked cell's hint says only an Admin member can carry a role that grants it", async () => {
        await editRole({ nonAdminCarriers: 1 });
        const user = userEvent.setup();
        await user.hover(byId('perm-admin-agent_policy_card')!);
        const tip = await screen.findByRole('tooltip');
        expect(tip).toHaveTextContent(
            R.cellAdminMembershipOnly.replace('{permission}', permissionLabel('admin', 'agent_policy_card')),
        );
    });

    /**
     * The two role rules lock different cells — the Admin-base-only permissions
     * need an Admin base (#4536, #4581 A), the admin-membership-only keys need
     * Admin carriers — but on a role non-Admins carry they meet: the base that
     * would free an Admin-base-only cell is locked too. Its hint says both,
     * rather than send the editor to a base they cannot pick.
     */
    /**
     * Hovers `id` and waits for an open hint saying `expected`. Each hint names
     * its own permission, so a hint left open by an earlier hover cannot
     * satisfy a later one.
     */
    async function expectHint(id: string, expected: string): Promise<void> {
        const user = userEvent.setup();
        await user.hover(byId(id)!);
        await waitFor(() =>
            expect({ id, hints: screen.queryAllByRole('tooltip').map((t) => t.textContent ?? '') }).toEqual({
                id,
                hints: expect.arrayContaining([expect.stringContaining(expected)]),
            }),
        );
    }

    it('every Admin-base-only cell on a carried role names both rules in its hint', async () => {
        await editRole({ nonAdminCarriers: 1 });
        for (const key of ADMIN_BASE_ONLY_PERMISSIONS) {
            const [domain, action] = key.split('.');
            const id = `perm-${domain}-${action}`;
            expect({ id, disabled: byId(id)!.getAttribute('aria-disabled') }).toEqual({ id, disabled: 'true' });
            await expectHint(id, R.cellNeedsAdminBaseCarried.replace('{permission}', permissionLabel(domain, action)));
        }
    });

    it('on a role only Admins carry the same cells name the base rule alone', async () => {
        await editRole({ nonAdminCarriers: 0 });
        await expectHint('perm-personnel-manage', R.cellNeedsAdminBase.replace('{permission}', permissionLabel('personnel', 'manage')));
        await expectHint('perm-admin-manage', R.cellNeedsAdminBase.replace('{permission}', permissionLabel('admin', 'manage')));
    });

    it('a permission the editor does not hold says so first, whatever else locks it', async () => {
        const admin = getPermissionsForRole('ADMIN');
        mount({
            list: ok([role('cr-1', 'Carried', 'READER', { nonAdminCarriers: 1 })]),
            held: {
                ...admin,
                personnel: { ...admin.personnel, manage: false },
                admin: { ...admin.admin, agent_policy_card: false },
            },
        });
        await screen.findByText('Carried');
        fireEvent.click(byId('edit-role-cr-1')!);
        await waitForId('perm-admin-sso');
        await expectHint('perm-personnel-manage', R.cellNotHeld.replace('{permission}', permissionLabel('personnel', 'manage')));
    });

    it('…for an admin-membership-only key too', async () => {
        const admin = getPermissionsForRole('ADMIN');
        mount({
            list: ok([role('cr-1', 'Carried', 'READER', { nonAdminCarriers: 1 })]),
            held: { ...admin, admin: { ...admin.admin, agent_policy_card: false } },
        });
        await screen.findByText('Carried');
        fireEvent.click(byId('edit-role-cr-1')!);
        await waitForId('perm-admin-sso');
        await expectHint('perm-admin-agent_policy_card', R.cellNotHeld.replace('{permission}', permissionLabel('admin', 'agent_policy_card')));
    });

    it('the Admin base is not choosable, with its reason; the others are', async () => {
        await editRole({ nonAdminCarriers: 1 });
        const picks = await waitFor(() => {
            if (document.querySelectorAll('[role="option"]').length === 0) fireEvent.click(byId('role-base-select')!);
            const shown = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
            if (shown.length === 0) throw new Error('no options');
            return Object.fromEntries(shown.map((o) => [o.textContent?.trim(), o.getAttribute('aria-disabled') !== 'true']));
        });
        expect(picks).toMatchObject({
            [en.roles.ADMIN]: false,
            [en.roles.EDITOR]: true,
            [en.roles.AUDITOR]: true,
            [en.roles.READER]: true,
        });
    });

    it('the Admin preset leaves the locked permissions off', async () => {
        await editRole({ nonAdminCarriers: 1 });
        fireEvent.click(byId('preset-ADMIN')!);
        for (const key of ADMIN_ONLY) expect(byId(`perm-admin-${key}`)).toHaveAttribute('aria-pressed', 'false');
        // An admin key neither rule keeps from a Reader base still lands.
        expect(byId('perm-admin-view')).toHaveAttribute('aria-pressed', 'true');
    });

    it('a role that already grants one (from before the rule) can switch it off — and back on, which adds nothing', async () => {
        const legacy = getPermissionsForRole('READER');
        await editRole({
            nonAdminCarriers: 1,
            permissionsJson: { ...legacy, admin: { ...legacy.admin, agent_policy_card: true } },
        });
        const cell = byId('perm-admin-agent_policy_card')!;
        expect(cell).toHaveAttribute('aria-pressed', 'true');
        expect(cell).not.toHaveAttribute('aria-disabled');
        fireEvent.click(cell);
        expect(cell).toHaveAttribute('aria-pressed', 'false');
        fireEvent.click(cell);
        expect(cell).toHaveAttribute('aria-pressed', 'true');
        expect(byId('perm-admin-sso')).toHaveAttribute('aria-disabled', 'true');
    });

    it('nothing is locked for a role only Admins carry', async () => {
        await editRole({ nonAdminCarriers: 0 });
        expect(byId('role-admin-membership-only')).toBeNull();
        for (const key of ADMIN_ONLY) expect(byId(`perm-admin-${key}`)).not.toHaveAttribute('aria-disabled');
    });

    it('nothing is locked for a new role, which nobody carries yet', async () => {
        mount();
        await openCreateGrid();
        expect(byId('role-admin-membership-only')).toBeNull();
        for (const key of ADMIN_ONLY) expect(byId(`perm-admin-${key}`)).not.toHaveAttribute('aria-disabled');
    });

    it("the server's refusal is re-said with labels and the count, not keys", async () => {
        mount({
            list: ok([role('cr-1', 'Carried', 'READER')]),
            patch: {
                ok: false,
                status: 409,
                body: {
                    error: {
                        code: 'CONFLICT',
                        message: 'A custom role granting admin.agent_skill_author can only be carried by an ADMIN membership.',
                        details: {
                            reason: 'CUSTOM_ROLE_ADMIN_KEYS_NEED_ADMIN_MEMBERSHIP',
                            keys: ['admin.agent_skill_author'],
                            blockingMemberships: 3,
                        },
                    },
                },
            },
        });
        await screen.findByText('Carried');
        fireEvent.click(byId('edit-role-cr-1')!);
        fireEvent.click(await waitForId('role-submit-btn'));
        const notice = await waitForId('roles-error');
        expect(notice).toHaveTextContent(permissionLabel('admin', 'agent_skill_author'));
        expect(notice).toHaveTextContent(R.carriageRefusedKeys.split('{permissions}')[0].trim());
        expect(notice).not.toHaveTextContent('admin.agent_skill_author');
    });
});

describe('custom roles page — the Admin-base-only permissions (#4536, #4581 A)', () => {
    const CELLS = ADMIN_BASE_ONLY_PERMISSIONS.map((k) => `perm-${k.replace('.', '-')}`);
    const labelOf = (key: string) => permissionLabel(key.split('.')[0], key.split('.')[1]);
    /** A Reader preset that also grants every Admin-base-only permission, as a role stored before the rule could. */
    const legacyBlob = () => {
        const p = getPermissionsForRole('READER') as unknown as Record<string, Record<string, boolean>>;
        const out = { ...p };
        for (const key of ADMIN_BASE_ONLY_PERMISSIONS) {
            const [domain, action] = key.split('.');
            out[domain] = { ...out[domain], [action]: true };
        }
        return out;
    };

    it('on a Reader base every one is locked, and an Admin preset turns none of them on', async () => {
        mount({ viewer: 'OWNER' });
        await openCreateGrid();
        for (const id of CELLS) {
            const cell = byId(id)!;
            expect({ id, disabled: cell.getAttribute('aria-disabled') }).toEqual({ id, disabled: 'true' });
            fireEvent.click(cell);
            expect({ id, pressed: cell.getAttribute('aria-pressed') }).toEqual({ id, pressed: 'false' });
        }
        fireEvent.click(byId('preset-ADMIN')!);
        for (const id of CELLS) expect({ id, pressed: byId(id)!.getAttribute('aria-pressed') }).toEqual({ id, pressed: 'false' });
        // The rest of the preset still lands: these keys are not this rule's.
        expect(byId('perm-personnel-view')).toHaveAttribute('aria-pressed', 'true');
        expect(byId('perm-admin-view')).toHaveAttribute('aria-pressed', 'true');
    });

    it('on an Admin base none is locked by this rule', async () => {
        mount({ viewer: 'OWNER' });
        await openCreateGrid();
        const combobox = byId('role-base-select')!;
        fireEvent.click(combobox);
        fireEvent.click(await screen.findByRole('option', { name: en.roles.ADMIN }));
        for (const id of CELLS) expect({ id, disabled: byId(id)!.getAttribute('aria-disabled') }).toEqual({ id, disabled: null });
    });

    it('a legacy Reader-based role holding them is told which, cannot save, and can switch them off to save', async () => {
        mount({ viewer: 'OWNER', list: ok([role('cr-legacy', 'Legacy admin', 'READER', { permissionsJson: legacyBlob() })]) });
        await screen.findByText('Legacy admin');
        fireEvent.click(byId('edit-role-cr-legacy')!);
        const notice = await waitForId('role-needs-admin-base');
        for (const key of ADMIN_BASE_ONLY_PERMISSIONS) expect(notice).toHaveTextContent(labelOf(key));
        expect(notice).not.toHaveTextContent('admin.manage');
        expect(byId('role-submit-btn')).toBeDisabled();

        for (const id of CELLS) {
            const cell = byId(id)!;
            expect(cell).not.toHaveAttribute('aria-disabled');
            fireEvent.click(cell);
            expect(cell).toHaveAttribute('aria-pressed', 'false');
            // Once off it cannot come back on this base.
            expect(cell).toHaveAttribute('aria-disabled', 'true');
        }
        expect(byId('role-needs-admin-base')).toBeNull();
        expect(byId('role-submit-btn')).not.toBeDisabled();
    });

    it("the server's refusal is said in the page's own words, with labels", async () => {
        mount({
            post: {
                ok: false,
                status: 400,
                body: {
                    error: {
                        code: 'VALIDATION_ERROR',
                        message: 'Only a custom role based on Admin can hold: admin.manage, personnel.manage.',
                        details: { reason: 'PERMISSION_NEEDS_ADMIN_BASE', permissions: ['admin.manage', 'personnel.manage'] },
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
            R.needsAdminBaseNotice.replace('{permissions}', `${labelOf('admin.manage')}, ${labelOf('personnel.manage')}`),
        );
        expect(notice).not.toHaveTextContent('admin.manage');
    });

    it('both locales name the rule', () => {
        for (const cat of [en, bg]) {
            expect(typeof cat.admin.roles.cellNeedsAdminBase).toBe('string');
            expect(cat.admin.roles.needsAdminBaseNotice).toContain('{permissions}');
        }
    });
});

describe('custom roles page — the form fields are labelled (#4581)', () => {
    it('each label names its control, and the name is marked required', async () => {
        mount();
        await loaded();
        fireEvent.click(byId('create-role-btn')!);
        await waitForId('role-name-input');
        const nameInput = screen.getByLabelText(new RegExp(`^${R.nameLabel}`));
        expect(nameInput).toBe(byId('role-name-input'));
        expect(nameInput).toHaveAttribute('aria-required', 'true');
        expect(screen.getByLabelText(R.descriptionLabel)).toBe(byId('role-description-input'));
        // The base role's help says what it does, in words a reader uses.
        expect(screen.getByText(R.baseRoleHint)).toBeInTheDocument();
        expect(R.baseRoleLabel).not.toMatch(/fallback/i);
        expect(R.baseRoleHint).not.toMatch(/coarse|authori[sz]ation/i);
    });
});
