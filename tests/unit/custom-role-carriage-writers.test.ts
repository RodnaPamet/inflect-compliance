/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles that stand
 * in for a Prisma client; the file-level disable is this repo's standard for
 * the shape. */
/**
 * Who can make a membership carry a custom role only an ADMIN may carry — the
 * CENSUS of the rule (owner decision, 2026-10-30; the rule itself is
 * `tests/unit/custom-role-carriage.test.ts`).
 *
 * A combination is made by whoever writes a membership's built-in ROLE, its
 * CUSTOM ROLE, or what a custom role GRANTS (its base and its blob). Two
 * halves:
 *
 *   STRUCTURE — every file whose code writes `TenantMembership.role`,
 *   `TenantMembership.customRoleId`, `TenantCustomRole.baseRole` or
 *   `TenantCustomRole.permissionsJson` is listed in `WRITERS`, as either
 *   ASKING the rule (its code calls the predicate) or UNABLE to make the
 *   combination, with the reason. A new writer fails here until it is one or
 *   the other.
 *
 *   BEHAVIOUR — each asking writer refuses, with the 409 and its named reason,
 *   and lets every change through that adds nothing: a clear, a narrowing
 *   save, a legacy row moved among EDITOR, READER and AUDITOR. Each unable
 *   writer is verified unable, not assumed.
 *
 * The real-database half (save and assignment, two tenants) is
 * `tests/integration/custom-role-carriage.test.ts`.
 */
import { strictMock } from '../helpers/strict-mock';

jest.mock('@/lib/db-context', () => ({ runInTenantContext: jest.fn() }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
// `strictMock`: `@/lib/audit` is a guarded barrel (see partial-mock-of-a-guarded-barrel).
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntry: jest.fn().mockResolvedValue({ id: 'a', entryHash: 'h', previousHash: null }),
        appendAuditEntryOrQueue: jest.fn().mockResolvedValue({ recorded: 'chain', auditId: 'a' }),
    }),
);
const prismaMock = {
    tenantInvite: { updateMany: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    tenantMembership: { findMany: jest.fn() },
    $transaction: jest.fn(),
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, prisma: prismaMock, default: prismaMock }));

import { readFileSync } from 'fs';

import { repoFiles, repoRelative } from '../helpers/repo-files';
import { allCallExpressionsOf, codeOf, functionBodyOf } from '../helpers/source-blocks';
import { makeRequestContext } from '../helpers/make-context';
import { runInTenantContext } from '@/lib/db-context';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import {
    CUSTOM_ROLE_ADMIN_BASE_REFUSAL,
    CUSTOM_ROLE_ADMIN_KEYS_REFUSAL,
} from '@/lib/roles';
import { SCIM_ASSIGNABLE_ROLES, isScimProtectedRole } from '@/lib/scim/roles';
import { ConflictError } from '@/lib/errors/types';
import { assignCustomRole, updateCustomRole } from '@/app-layer/usecases/custom-roles';
import {
    updateTenantMemberRole,
    updateTenantMemberRoleAndCustomRole,
} from '@/app-layer/usecases/tenant-admin';
import {
    createInviteToken,
    redeemInvite,
    redeemPendingInvitesByEmail,
} from '@/app-layer/usecases/tenant-invites';
import { syncEntraMembershipRole } from '@/lib/auth/entra-group-sync';

const mockRunInTx = runInTenantContext as jest.MockedFunction<any>;

// ─── STRUCTURE ─────────────────────────────────────────────────────

type Writer = { asks: string } | { unable: string };

/**
 * Every file that writes a membership's role or custom role, or what a custom
 * role grants — and how it holds the rule.
 */
const WRITERS: Readonly<Record<string, Writer>> = {
    'src/app-layer/usecases/custom-roles.ts': {
        asks:
            'updateCustomRole (a save, judged against every carrier’s built-in role) and assignCustomRole. ' +
            'createCustomRole has no carriers, and deleteCustomRole only clears',
    },
    'src/app-layer/usecases/tenant-admin.ts': {
        asks: 'updateTenantMemberRole and updateTenantMemberRoleAndCustomRole — the members page',
    },
    'src/app-layer/usecases/tenant-invites.ts': {
        asks: 'createInviteToken, and both redemptions, which reactivate a membership with its custom role kept',
    },
    'src/lib/auth/entra-group-sync.ts': {
        asks: 'syncEntraMembershipRole — a group mapping at sign-in and on a SCIM Groups push',
    },
    'src/app-layer/usecases/access-review.ts': {
        unable: 'a campaign MODIFY clears the custom role in the same write (#3727), and a REVOKE writes status only',
    },
    'src/app-layer/usecases/tenant-lifecycle.ts': {
        unable:
            'a new tenant’s OWNER row carries none; a transfer makes the new owner OWNER only when they carry none ' +
            '(#3720) and the old one ADMIN, the one role that may carry any custom role',
    },
    'src/app-layer/usecases/scim-users.ts': {
        unable:
            'creates rows with no custom role, and moves a role only among EDITOR, READER and AUDITOR, ' +
            'which the rule treats alike',
    },
    'src/app-layer/usecases/sso.ts': { unable: 'SSO JIT creates a new row, with no custom role' },
    'src/app-layer/usecases/org-provisioning.ts': { unable: 'creates new ADMIN rows, with no custom role' },
    'src/app-layer/usecases/org-tenants.ts': { unable: 'creates a new tenant’s OWNER row, with no custom role' },
    'src/app/api/auth/register/route.ts': { unable: 'creates a new tenant’s OWNER row, with no custom role' },
    'src/app/api/staging/seed/route.ts': {
        unable: 'staging only: creates an ADMIN row, and its update arm writes nothing',
    },
};

const WRITE_VERBS = '(?:update|updateMany|upsert|create|createMany)';

/** `text` with the `{…}` object after each `key:` removed — a `where`, `select` or `include` is not a write. */
function withoutObjects(text: string, keys: readonly string[]): string {
    let out = text;
    for (const key of keys) {
        for (;;) {
            const m = new RegExp(`\\b${key}\\s*:\\s*\\{`).exec(out);
            if (!m) break;
            let depth = 0;
            let end = -1;
            for (let i = m.index + m[0].length - 1; i < out.length; i++) {
                if (out[i] === '{') depth++;
                else if (out[i] === '}' && --depth === 0) {
                    end = i;
                    break;
                }
            }
            if (end < 0) break;
            out = out.slice(0, m.index) + out.slice(end + 1);
        }
    }
    return out;
}

/** Whether `src` writes one of the four columns, in any of the shapes this repo uses. */
function writesTheRule(src: string): boolean {
    const membership = allCallExpressionsOf(src, `tenantMembership\\.${WRITE_VERBS}`).some((call) =>
        /\brole\b\s*[:,}]|\bcustomRoleId\b/.test(withoutObjects(call, ['where', 'select', 'include'])),
    );
    const customRole = allCallExpressionsOf(src, `tenantCustomRole\\.${WRITE_VERBS}`).some((call) =>
        /\bbaseRole\b|\bpermissionsJson\b/.test(withoutObjects(call, ['where', 'select', 'include'])),
    );
    const sql = /UPDATE\s+"TenantMembership"[\s\S]{0,200}"(role|customRoleId)"|UPDATE\s+"TenantCustomRole"/i.test(src);
    return membership || customRole || sql;
}

const srcFiles = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }).map((abs) => ({
    rel: repoRelative(abs),
    raw: readFileSync(abs, 'utf8'),
}));

describe('STRUCTURE — every writer of the combination asks the rule, or cannot make it', () => {
    it('the population is real', () => {
        expect(srcFiles.length).toBeGreaterThan(1000);
    });

    it('exactly the listed files write a membership’s role or custom role, or what a custom role grants', () => {
        const writers = srcFiles.filter((f) => writesTheRule(f.raw)).map((f) => f.rel).sort();
        expect(writers).toEqual(Object.keys(WRITERS).sort());
    });

    it('every asking writer calls the predicate; every unable one does not need to', () => {
        for (const [file, how] of Object.entries(WRITERS)) {
            const code = codeOf(srcFiles.find((f) => f.rel === file)!.raw);
            const asks = /\bassertCustomRoleCarriageInTx\s*\(|\bcustomRoleCarriageRefusal\s*\(/.test(code);
            expect({ file, asks }).toEqual({ file, asks: 'asks' in how });
        }
    });

    it('the write detector is not blind (each shape is caught; a read is not)', () => {
        for (const sample of [
            'db.tenantMembership.update({ where: { id }, data: { role: input.role } })',
            'tx.tenantMembership.upsert({ where: { x }, create: { role }, update: { role, status } })',
            'db.tenantMembership.update({ where: { id }, data: { customRoleId } })',
            'db.tenantMembership.createMany({ data: rows.map((r) => ({ userId: r, role: Role.ADMIN })) })',
            'db.tenantCustomRole.update({ where: { id }, data: { baseRole: x } })',
            'db.tenantCustomRole.create({ data: { name, permissionsJson: p } })',
            `UPDATE "TenantMembership" SET "role" = 'EDITOR'`,
        ]) {
            expect({ sample, caught: writesTheRule(sample) }).toEqual({ sample, caught: true });
        }
        for (const sample of [
            "db.tenantMembership.updateMany({ where: { role: 'OWNER' }, data: { status: 'DEACTIVATED' } })",
            'db.tenantMembership.update({ where: { id }, data: { lineOfDefence }, select: { role: true } })',
        ]) {
            expect({ sample, caught: writesTheRule(sample) }).toEqual({ sample, caught: false });
        }
    });
});

describe('STRUCTURE — the unable writers, verified', () => {
    const code = (file: string) => srcFiles.find((f) => f.rel === file)!.raw;

    it('a campaign MODIFY clears the custom role in the very write that sets the role', () => {
        const close = functionBodyOf(code('src/app-layer/usecases/access-review.ts'), 'closeAccessReview');
        const roleWrites = allCallExpressionsOf(close, 'tenantMembership\\.update').filter((c) =>
            /\brole\s*:/.test(withoutObjects(c, ['where'])),
        );
        expect(roleWrites).toHaveLength(1);
        expect(roleWrites[0]).toMatch(/customRoleId:\s*null/);
    });

    it('an ownership transfer writes OWNER and ADMIN and nothing else, and refuses a new owner carrying a custom role', () => {
        const transfer = functionBodyOf(code('src/app-layer/usecases/tenant-lifecycle.ts'), 'transferTenantOwnership');
        const roles = allCallExpressionsOf(transfer, 'tenantMembership\\.update').map(
            (c) => /role:\s*'(\w+)'/.exec(c)?.[1],
        );
        expect(roles.sort()).toEqual(['ADMIN', 'OWNER']);
        expect(codeOf(transfer)).toMatch(/newMembership\.customRoleId && !mayCarryCustomRole\('OWNER'\)/);
    });

    it('SCIM moves a role only among EDITOR, READER and AUDITOR — the rule treats them alike', () => {
        expect([...SCIM_ASSIGNABLE_ROLES].sort()).toEqual(['AUDITOR', 'EDITOR', 'READER']);
        expect(isScimProtectedRole('ADMIN')).toBe(true);
    });

    it('no unable writer writes a custom role at all', () => {
        for (const [file, how] of Object.entries(WRITERS)) {
            if (!('unable' in how) || file.endsWith('access-review.ts')) continue;
            const calls = allCallExpressionsOf(code(file), `tenantMembership\\.${WRITE_VERBS}`);
            expect({ file, writesCustomRole: calls.some((c) => /\bcustomRoleId\b/.test(c)) }).toEqual({
                file,
                writesCustomRole: false,
            });
        }
    });
});

// ─── BEHAVIOUR ─────────────────────────────────────────────────────

/** A full blob: `base`'s defaults with `admin` keys switched as given. */
function blob(base: string, admin: Partial<PermissionSet['admin']> = {}) {
    const d = getPermissionsForRole(base as never);
    return { ...d, admin: { ...d.admin, ...admin } };
}

/** Custom roles by id: an ADMIN-built one, one granting a listed key, and a harmless one. */
const ROLES: Record<string, { id: string; tenantId: string; baseRole: string; permissionsJson: unknown; isActive: boolean }> = {
    'cr-admin-built': { id: 'cr-admin-built', tenantId: 't-1', baseRole: 'ADMIN', permissionsJson: blob('ADMIN'), isActive: true },
    'cr-card': {
        id: 'cr-card',
        tenantId: 't-1',
        baseRole: 'READER',
        permissionsJson: blob('READER', { agent_policy_card: true }),
        isActive: true,
    },
    'cr-plain': { id: 'cr-plain', tenantId: 't-1', baseRole: 'READER', permissionsJson: blob('READER'), isActive: true },
};

const customRoleTable = () => ({
    findFirst: jest.fn(async (a: any): Promise<(typeof ROLES)[string] | null> => ROLES[a.where.id] ?? null),
    findMany: jest.fn(async (a: any) => (a.where.id.in as string[]).map((id) => ROLES[id]).filter(Boolean)),
    update: jest.fn(async (a: any) => ({ id: a.where.id, name: 'R', ...a.data })),
});

/** An OWNER may grant every key, so the grant check never decides these cases. */
const owner = () => makeRequestContext('OWNER', { tenantId: 't-1', userId: 'owner-1' });

function membershipDb(membership: { role: string; customRoleId: string | null }) {
    const row = {
        id: 'm-1',
        userId: 'u-1',
        tenantId: 't-1',
        status: 'ACTIVE',
        user: { id: 'u-1', name: 'U', email: 'u@example.com' },
        ...membership,
    };
    const db = {
        tenantMembership: {
            findFirst: jest.fn().mockResolvedValue(row),
            count: jest.fn().mockResolvedValue(2),
            update: jest.fn(async (a: any) => ({ ...row, ...a.data, customRole: null })),
        },
        tenantCustomRole: customRoleTable(),
    };
    mockRunInTx.mockImplementation(async (_c: unknown, fn: (tx: unknown) => unknown) => fn(db));
    return db;
}

const refusalOf = async (p: Promise<unknown>) => {
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    return err as ConflictError & { details: Record<string, unknown> };
};

beforeEach(() => {
    jest.clearAllMocks();
    mockRunInTx.mockImplementation(async () => {
        throw new Error('the database was reached');
    });
});

describe('BEHAVIOUR — assignCustomRole', () => {
    it('refuses a role granting a listed key to an EDITOR — 409, the reason and the key, nothing written', async () => {
        const db = membershipDb({ role: 'EDITOR', customRoleId: null });
        const err = await refusalOf(assignCustomRole(owner(), 'm-1', 'cr-card'));
        expect(err.details).toEqual({ reason: CUSTOM_ROLE_ADMIN_KEYS_REFUSAL, keys: ['admin.agent_policy_card'] });
        expect(err.message).toMatch(/can only be carried by an ADMIN membership/);
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('refuses an ADMIN-built role to a READER for its base', async () => {
        const db = membershipDb({ role: 'READER', customRoleId: null });
        const err = await refusalOf(assignCustomRole(owner(), 'm-1', 'cr-admin-built'));
        expect(err.details).toEqual({ reason: CUSTOM_ROLE_ADMIN_BASE_REFUSAL, baseRole: 'ADMIN' });
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('assigns both to an ADMIN', async () => {
        const db = membershipDb({ role: 'ADMIN', customRoleId: null });
        await assignCustomRole(owner(), 'm-1', 'cr-admin-built');
        await assignCustomRole(owner(), 'm-1', 'cr-card');
        expect(db.tenantMembership.update).toHaveBeenCalledTimes(2);
    });

    it('a legacy carrier is not trapped: clearing, replacing with a harmless role and re-saving the same role all pass', async () => {
        const db = membershipDb({ role: 'EDITOR', customRoleId: 'cr-admin-built' });
        await assignCustomRole(owner(), 'm-1', null);
        await assignCustomRole(owner(), 'm-1', 'cr-plain');
        await assignCustomRole(owner(), 'm-1', 'cr-admin-built');
        expect(db.tenantMembership.update.mock.calls.map((c: any[]) => c[0].data)).toEqual([
            { customRoleId: null },
            { customRoleId: 'cr-plain' },
            { customRoleId: 'cr-admin-built' },
        ]);
    });
});

describe('BEHAVIOUR — the members-page role change', () => {
    it('moving an ADMIN who carries an ADMIN-built role to EDITOR is refused until the custom role changes', async () => {
        const db = membershipDb({ role: 'ADMIN', customRoleId: 'cr-admin-built' });
        const err = await refusalOf(updateTenantMemberRole(owner(), { membershipId: 'm-1', role: 'EDITOR' }));
        expect(err.details).toEqual({ reason: CUSTOM_ROLE_ADMIN_BASE_REFUSAL, baseRole: 'ADMIN' });
        expect(err.message).toMatch(/Remove or change this member's custom role first/);
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('…and the same move saved WITH a harmless custom role passes, all at once', async () => {
        const db = membershipDb({ role: 'ADMIN', customRoleId: 'cr-admin-built' });
        await updateTenantMemberRoleAndCustomRole(owner(), { membershipId: 'm-1', role: 'EDITOR', customRoleId: 'cr-plain' });
        expect(db.tenantMembership.update.mock.calls.map((c: any[]) => c[0].data)).toEqual([
            { role: 'EDITOR' },
            { customRoleId: 'cr-plain' },
        ]);
    });

    it('…while saved with a role granting a listed key it is refused, with nothing written', async () => {
        const db = membershipDb({ role: 'ADMIN', customRoleId: null });
        const err = await refusalOf(
            updateTenantMemberRoleAndCustomRole(owner(), { membershipId: 'm-1', role: 'AUDITOR', customRoleId: 'cr-card' }),
        );
        expect(err.details).toEqual({ reason: CUSTOM_ROLE_ADMIN_KEYS_REFUSAL, keys: ['admin.agent_policy_card'] });
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('a legacy EDITOR carrier moves to READER — the offence is not new', async () => {
        const db = membershipDb({ role: 'EDITOR', customRoleId: 'cr-card' });
        await updateTenantMemberRole(owner(), { membershipId: 'm-1', role: 'READER' });
        expect(db.tenantMembership.update).toHaveBeenCalledWith(expect.objectContaining({ data: { role: 'READER' } }));
    });
});

describe('BEHAVIOUR — updateCustomRole, judged against every carrier', () => {
    function saveDb(existing: string, carriers: Array<{ role: string; n: number }>) {
        const db = {
            tenantCustomRole: customRoleTable(),
            tenantMembership: {
                groupBy: jest.fn(async () => carriers.map((c) => ({ role: c.role, _count: { _all: c.n } }))),
            },
        };
        db.tenantCustomRole.findFirst.mockResolvedValueOnce(ROLES[existing]);
        mockRunInTx.mockImplementation(async (_c: unknown, fn: (tx: unknown) => unknown) => fn(db));
        return db;
    }

    it('adding a listed key while non-ADMIN members carry it is refused, counting every one of them', async () => {
        const db = saveDb('cr-plain', [
            { role: 'EDITOR', n: 2 },
            { role: 'AUDITOR', n: 1 },
            { role: 'ADMIN', n: 4 },
        ]);
        const err = await refusalOf(
            updateCustomRole(owner(), 'cr-plain', { permissionsJson: blob('READER', { agent_skill_review: true }) }),
        );
        expect(err.details).toEqual({
            reason: CUSTOM_ROLE_ADMIN_KEYS_REFUSAL,
            keys: ['admin.agent_skill_review'],
            blockingMemberships: 3,
        });
        expect(err.message).toMatch(/3 member\(s\) carrying this role hold another role/);
        expect(db.tenantCustomRole.update).not.toHaveBeenCalled();
        expect(db.tenantMembership.groupBy).toHaveBeenCalledWith(
            expect.objectContaining({ by: ['role'], where: { tenantId: 't-1', customRoleId: 'cr-plain' } }),
        );
    });

    it('raising the base to ADMIN is refused for its base', async () => {
        saveDb('cr-plain', [{ role: 'READER', n: 1 }]);
        const err = await refusalOf(updateCustomRole(owner(), 'cr-plain', { baseRole: 'ADMIN' }));
        expect(err.details).toMatchObject({ reason: CUSTOM_ROLE_ADMIN_BASE_REFUSAL, blockingMemberships: 1 });
    });

    it('the same save carried only by ADMINs passes', async () => {
        const db = saveDb('cr-plain', [{ role: 'ADMIN', n: 4 }]);
        await updateCustomRole(owner(), 'cr-plain', { baseRole: 'ADMIN' });
        expect(db.tenantCustomRole.update).toHaveBeenCalledTimes(1);
    });

    it('a legacy role is not trapped: removing keys, lowering the base and renaming all pass', async () => {
        for (const input of [
            { permissionsJson: blob('ADMIN', { agent_policy_card: false }) },
            { baseRole: 'EDITOR' as const },
            { name: 'Renamed' },
        ]) {
            const db = saveDb('cr-admin-built', [{ role: 'EDITOR', n: 5 }]);
            db.tenantCustomRole.findFirst.mockResolvedValueOnce(null); // the rename's duplicate check
            await updateCustomRole(owner(), 'cr-admin-built', input);
            expect(db.tenantCustomRole.update).toHaveBeenCalledTimes(1);
        }
    });
});

describe('BEHAVIOUR — invites', () => {
    function inviteDb(existing: { status: string; role: string; customRoleId: string | null }) {
        const db = {
            user: { findUnique: jest.fn().mockResolvedValue({ id: 'u-1' }) },
            tenantMembership: { findUnique: jest.fn().mockResolvedValue(existing) },
            tenantCustomRole: customRoleTable(),
            tenantInvite: { upsert: jest.fn(async (a: any) => ({ id: 'inv-1', token: 't', ...a.create })) },
        };
        mockRunInTx.mockImplementation(async (_c: unknown, fn: (tx: unknown) => unknown) => fn(db));
        return db;
    }

    it('createInviteToken refuses to bring back an ADMIN carrying an ADMIN-built role as an EDITOR', async () => {
        const db = inviteDb({ status: 'DEACTIVATED', role: 'ADMIN', customRoleId: 'cr-admin-built' });
        const err = await refusalOf(createInviteToken(owner(), { email: 'x@example.com', role: 'EDITOR' }));
        expect(err.details).toEqual({ reason: CUSTOM_ROLE_ADMIN_BASE_REFUSAL, baseRole: 'ADMIN' });
        expect(err.message).toMatch(/Invite them as ADMIN/);
        expect(db.tenantInvite.upsert).not.toHaveBeenCalled();
    });

    it('…and invites them back as ADMIN', async () => {
        const db = inviteDb({ status: 'DEACTIVATED', role: 'ADMIN', customRoleId: 'cr-admin-built' });
        await createInviteToken(owner(), { email: 'x@example.com', role: 'ADMIN' });
        expect(db.tenantInvite.upsert).toHaveBeenCalledTimes(1);
    });

    function claimed(role: string) {
        prismaMock.tenantInvite.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.tenantInvite.findUnique.mockResolvedValue({
            id: 'inv-1',
            tenantId: 't-1',
            email: 'x@example.com',
            role,
            invitedById: 'owner-1',
            createdAt: new Date(),
        });
    }
    function redemptionTx(existing: { role: string; customRoleId: string | null }) {
        const tx = {
            tenantMembership: {
                findUnique: jest.fn().mockResolvedValue(existing),
                upsert: jest.fn().mockResolvedValue({ id: 'm-1' }),
            },
            tenantCustomRole: customRoleTable(),
            tenant: { findUnique: jest.fn().mockResolvedValue({ slug: 'acme' }) },
        };
        prismaMock.$transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
        return tx;
    }

    it('redeemInvite refuses (the backstop) a role-granting-a-key carrier coming back as a READER — no upsert', async () => {
        claimed('READER');
        const tx = redemptionTx({ role: 'ADMIN', customRoleId: 'cr-card' });
        const err = await refusalOf(redeemInvite({ token: 't', userId: 'u-1', userEmail: 'x@example.com' }));
        expect(err.details).toEqual({ reason: CUSTOM_ROLE_ADMIN_KEYS_REFUSAL, keys: ['admin.agent_policy_card'] });
        expect(tx.tenantMembership.upsert).not.toHaveBeenCalled();
    });

    it('redeemInvite lets a legacy EDITOR carrier back as an AUDITOR — nothing new', async () => {
        claimed('AUDITOR');
        const tx = redemptionTx({ role: 'EDITOR', customRoleId: 'cr-card' });
        await redeemInvite({ token: 't', userId: 'u-1', userEmail: 'x@example.com' });
        expect(tx.tenantMembership.upsert).toHaveBeenCalledTimes(1);
    });

    it('redeemPendingInvitesByEmail skips such an invite WITHOUT claiming it, and redeems the others', async () => {
        prismaMock.tenantInvite.findMany.mockResolvedValue([
            { id: 'inv-editor', tenantId: 't-1', role: 'EDITOR', invitedById: 'o', createdAt: new Date() },
            { id: 'inv-other', tenantId: 't-2', role: 'READER', invitedById: 'o', createdAt: new Date() },
        ]);
        prismaMock.tenantMembership.findMany.mockResolvedValue([
            { tenantId: 't-1', role: 'ADMIN', customRole: { baseRole: 'ADMIN', permissionsJson: blob('ADMIN') } },
        ]);
        prismaMock.tenantInvite.updateMany.mockResolvedValue({ count: 1 });
        redemptionTx({ role: 'READER', customRoleId: null });
        const redeemed = await redeemPendingInvitesByEmail({ userId: 'u-1', userEmail: 'x@example.com' });
        expect(prismaMock.tenantInvite.updateMany).toHaveBeenCalledTimes(1);
        expect(prismaMock.tenantInvite.updateMany.mock.calls[0][0].where.id).toBe('inv-other');
        expect(redeemed.map((r) => r.role)).toEqual(['READER']);
    });
});

describe('BEHAVIOUR — the Entra group sync (sign-in and SCIM Groups push)', () => {
    function entraDb(membership: { role: string; customRoleId: string | null }) {
        const update = jest.fn();
        const cr = membership.customRoleId ? ROLES[membership.customRoleId] : null;
        const db = {
            tenantIdentityProvider: { findFirst: jest.fn().mockResolvedValue(null) },
            tenantEntraGroupMapping: {
                findMany: jest.fn().mockResolvedValue([{ aadGroupId: 'g-1', role: 'EDITOR', priority: 0 }]),
            },
            tenantMembership: {
                findFirst: jest.fn().mockResolvedValue({ id: 'm-1', ...membership, customRole: cr }),
                update,
            },
        };
        return { db, update };
    }

    it('holds a mapping that would move an ADMIN carrying an ADMIN-built role to EDITOR — nothing written', async () => {
        const { db, update } = entraDb({ role: 'ADMIN', customRoleId: 'cr-admin-built' });
        const result = await syncEntraMembershipRole(
            { userId: 'u-1', tenantId: 't-1', aadGroups: ['g-1'] },
            { db: db as never },
        );
        expect(result).toEqual({ effectiveRole: 'ADMIN', changed: false, gateDenied: false });
        expect(update).not.toHaveBeenCalled();
        expect(db.tenantMembership.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                select: expect.objectContaining({ customRole: { select: { baseRole: true, permissionsJson: true } } }),
            }),
        );
    });

    it('syncs a legacy READER carrier to EDITOR — the offence is not new', async () => {
        const { db, update } = entraDb({ role: 'READER', customRoleId: 'cr-card' });
        const result = await syncEntraMembershipRole(
            { userId: 'u-1', tenantId: 't-1', aadGroups: ['g-1'] },
            { db: db as never },
        );
        expect(result.changed).toBe(true);
        expect(update).toHaveBeenCalledWith({ where: { id: 'm-1' }, data: { role: 'EDITOR' } });
    });
});
