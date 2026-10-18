/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles that stand
 * in for a Prisma client; the file-level disable is this repo's standard for
 * the shape. */
/**
 * Who writes the AI_ADMIN role (#3699) — exactly two writers, and every other
 * membership-role writer refuses it.
 *
 * `AI_ADMIN` reached `Role` in two deploys so that no running container reads
 * a membership role its Prisma client does not know. Deploy 1 shipped the value
 * read-only. Deploy 2 (the owner's decisions of 2026-10-18) gives it two
 * writers and no more:
 *
 *   1. the members-page role change (`updateTenantMemberRole`) — an OWNER moves
 *      an EXISTING member into or out of it;
 *   2. an Entra group mapping (`syncEntraMembershipRole`) — at sign-in and on a
 *      SCIM Groups push.
 *
 * Every other writer still refuses it: invites (creation and both
 * redemptions), the direct member add, an access review's MODIFY (submission
 * and close), the custom-role base (create and update), SCIM's `roles[]`
 * attribute and SSO JIT. They share `ASSIGNABLE_TENANT_ROLES`, which deploy 2
 * did NOT widen; the role change reads its own `MEMBER_ROLE_CHANGE_ROLES`.
 *
 * Two halves:
 *
 *   STRUCTURE — every file whose CODE (comments stripped) names the value is
 *   listed with its reason; no file outside `WRITERS` writes it in any
 *   spelling; the widened lists have exactly the consumers they were widened
 *   for; and the member/invite routes validate against the right list.
 *
 *   BEHAVIOUR — each writer writes it, and each other writer refuses it.
 *
 * The OWNER-only gate and the no-custom-role rule on the two writers are in
 * `tests/unit/ai-admin-assignment.test.ts`; the real-DB, two-tenant proof is
 * `tests/integration/ai-admin-assignment.test.ts`.
 */
import { strictMock } from '../helpers/strict-mock';

jest.mock('@/lib/db-context', () => ({ runInTenantContext: jest.fn() }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
// `strictMock`: `@/lib/audit` is a guarded barrel (see partial-mock-of-a-guarded-barrel).
const appendAuditEntryMock = jest.fn().mockResolvedValue({ id: 'a', entryHash: 'h', previousHash: null });
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntry: (...a: unknown[]) => appendAuditEntryMock(...a),
        appendAuditEntryOrQueue: jest.fn().mockResolvedValue({ recorded: 'chain', auditId: 'a' }),
    }),
);
const prismaMock = {
    tenantInvite: { updateMany: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, prisma: prismaMock, default: prismaMock }));
// The member/invite routes are driven end to end; their gate resolves the context here.
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { readFileSync } from 'fs';
import { NextRequest } from 'next/server';

import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';
import { makeRequestContext } from '../helpers/make-context';
import {
    ASSIGNABLE_TENANT_ROLES,
    MEMBER_ROLE_CHANGE_ROLES,
    TENANT_ROLES,
    isAssignableTenantRole,
} from '@/lib/roles';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '@/app-layer/events/audit';
import { updateTenantMemberRole } from '@/app-layer/usecases/tenant-admin';
import {
    createInviteToken,
    redeemInvite,
    redeemPendingInvitesByEmail,
} from '@/app-layer/usecases/tenant-invites';
import { SubmitDecisionSchema } from '@/app-layer/schemas/access-review.schemas';
import { closeAccessReview } from '@/app-layer/usecases/access-review';
import { createCustomRole, updateCustomRole } from '@/app-layer/usecases/custom-roles';
import { getPermissionsForRole } from '@/lib/permissions';
import {
    SCIM_ASSIGNABLE_ROLES,
    SCIM_GROUP_ASSIGNABLE_ROLES,
    isScimAssignableRole,
    isScimProtectedRole,
    isScimStatusProtectedRole,
} from '@/lib/scim/roles';
import { resolveScimRole } from '@/app-layer/usecases/scim-users';
import {
    ENTRA_MAPPABLE_ROLES,
    EntraGroupMappingCreateSchema,
    EntraGroupMappingUpdateSchema,
} from '@/app-layer/schemas/entra-group-mapping.schemas';
import { NEVER_GROUP_MAPPED_ROLES } from '@/lib/auth/entra-role-mapping';
import { syncEntraMembershipRole } from '@/lib/auth/entra-group-sync';
import { UpsertSsoConfigInput } from '@/app-layer/schemas/sso-config.schemas';
import { ValidationError } from '@/lib/errors/types';

const mockRunInTx = runInTenantContext as jest.MockedFunction<any>;

// ─── STRUCTURE ─────────────────────────────────────────────────────

/** Files whose code names AI_ADMIN, and why. A writer that does not name it is not listed here. */
const NAMING_FILES: Readonly<Record<string, string>> = {
    'src/lib/roles.ts':
        'TENANT_ROLES (readers), MEMBER_ROLE_CHANGE_ROLES (the role change), OWNER_MANAGED_ROLES, BUILT_IN_SCOPE_ROLES',
    'src/lib/permissions.ts': 'getPermissionsForRole: READER’s set plus the agent keys',
    'src/lib/tenant-context.ts': 'ROLE_ORDER: READER’s rung of the coarse ladder',
    'src/lib/agentic/agent-authority.ts': 'ROLE_RANK: READER’s rung, a label only',
    'src/lib/auth.ts': 'ROLE_HIERARCHY and canRead: READER’s rung',
    'src/lib/auth/entra-role-mapping.ts': 'ROLE_SENIORITY and TIE_DECIDABLE_AGAINST: ranked against READER only',
    'src/lib/auth/guard.ts': 'checkAdminAccess: admits it to the agent admin paths only',
    'src/lib/agentic/ownership-transfer.ts': 'TRANSFER_RECIPIENT_MEMBERSHIP_ROLES: it can receive an agent',
    'src/lib/scim/roles.ts': 'SCIM_GROUP_ASSIGNABLE_ROLES: a Groups push may write it; the Users ceiling may not',
    'src/app-layer/schemas/entra-group-mapping.schemas.ts': 'ENTRA_MAPPABLE_ROLES: a group may map to it',
    'src/app-layer/policies/audit-readiness.policies.ts': 'assertCanViewPack: views packs like a READER',
    'src/app-layer/policies/issue.policies.ts': 'assertCanComment: refuses it like a READER',
    'src/app/t/[tenantSlug]/(app)/tasks/[taskId]/page.tsx': 'hides the comment form, like a READER',
    'src/app/t/[tenantSlug]/(app)/admin/rbac/page.tsx': 'a column in the permission matrix',
    'src/app/t/[tenantSlug]/(app)/admin/members/page.tsx':
        'a badge tone; the role-change picker offers it to an OWNER only, never the invite picker',
    'src/app/t/[tenantSlug]/(app)/admin/entra/GroupMappingsSection.tsx': 'shows its tie rule while a mapping to it is being added',
};

/** Files that WRITE AI_ADMIN to a membership — the two the owner decided on, and no third. */
const WRITERS: Readonly<Record<string, string>> = {
    'src/app-layer/usecases/tenant-admin.ts':
        'updateTenantMemberRole — the members-page role change, an OWNER moving an existing member in or out',
    'src/lib/auth/entra-group-sync.ts':
        'syncEntraMembershipRole — an Entra group mapping, at sign-in and on a SCIM Groups push',
};

/** Files that may build a Zod schema from the generated `Role` enum, and why. */
const ROLE_ENUM_SCHEMA_READERS: Readonly<Record<string, string>> = {
    'src/app-layer/usecases/policy-attestation.ts':
        'an acknowledgement AUDIENCE selector: it filters memberships by role and writes none',
};

const namesAiAdmin = (code: string) => /(['"`])AI_ADMIN\1|\.AI_ADMIN\b|(?<![\w.$])AI_ADMIN\s*:/.test(code);

/** A membership-role write of the value, in any spelling this repo uses. */
const WRITES_AI_ADMIN: readonly RegExp[] = [
    /\brole\s*:\s*(?:Role\.AI_ADMIN|\$Enums\.Role\.AI_ADMIN|(['"`])AI_ADMIN\1)/,
    /\bmodifiedToRole\s*:\s*(?:Role\.AI_ADMIN|(['"`])AI_ADMIN\1)/,
    /"role"\s*=\s*'AI_ADMIN'/i,
    /'AI_ADMIN'\s*::\s*"Role"/,
];

const srcFiles = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }).map((abs) => ({
    rel: repoRelative(abs),
    code: codeOf(readFileSync(abs, 'utf8')),
}));

/** Files whose CODE references any of `identifiers`, as whole words. */
const consumersOf = (...identifiers: string[]) =>
    srcFiles
        .filter((f) => identifiers.some((id) => new RegExp(`\\b${id}\\b`).test(f.code)))
        .map((f) => f.rel)
        .sort();

describe('STRUCTURE — two writers of AI_ADMIN, and no third', () => {
    it('the population is real', () => {
        expect(srcFiles.length).toBeGreaterThan(1000);
    });

    it('the writers’ list still excludes it; the role change’s list is that list plus AI_ADMIN exactly', () => {
        expect(isAssignableTenantRole('AI_ADMIN')).toBe(false);
        expect([...ASSIGNABLE_TENANT_ROLES].sort()).toEqual(['ADMIN', 'AUDITOR', 'EDITOR', 'OWNER', 'READER']);
        expect([...MEMBER_ROLE_CHANGE_ROLES].sort()).toEqual([...ASSIGNABLE_TENANT_ROLES, 'AI_ADMIN'].sort());
        expect(TENANT_ROLES).toContain('AI_ADMIN');
        expect(Object.keys(WRITERS).sort()).toEqual([
            'src/app-layer/usecases/tenant-admin.ts',
            'src/lib/auth/entra-group-sync.ts',
        ]);
    });

    it('every file whose code names AI_ADMIN is listed — and every listed file still does', () => {
        const naming = srcFiles.filter((f) => namesAiAdmin(f.code)).map((f) => f.rel).sort();
        expect(naming).toEqual(Object.keys(NAMING_FILES).sort());
    });

    it('no file outside WRITERS writes AI_ADMIN to a membership, in any spelling', () => {
        const writes = srcFiles
            .filter((f) => !(f.rel in WRITERS))
            .filter((f) => WRITES_AI_ADMIN.some((re) => re.test(f.code)))
            .map((f) => f.rel);
        expect(writes).toEqual([]);
    });

    it('the write detector is not blind (each spelling is caught)', () => {
        for (const sample of [
            "data: { role: 'AI_ADMIN' }",
            'data: { role: Role.AI_ADMIN }',
            "modifiedToRole: 'AI_ADMIN'",
            `UPDATE "TenantMembership" SET "role" = 'AI_ADMIN'`,
            `VALUES ('AI_ADMIN'::"Role")`,
        ]) {
            expect({ sample, caught: WRITES_AI_ADMIN.some((re) => re.test(sample)) }).toEqual({
                sample,
                caught: true,
            });
        }
    });

    /**
     * The widened lists reach exactly the writers they were widened for. A
     * third consumer of any of them is a third writer, and fails here first.
     */
    it.each([
        [
            'the members-page role change list',
            ['MEMBER_ROLE_CHANGE_ROLES', 'isMemberRoleChangeRole', 'MemberRoleChangeRole'],
            [
                'src/app-layer/usecases/tenant-admin.ts',
                'src/app/api/t/[tenantSlug]/admin/members/[membershipId]/route.ts',
                'src/lib/roles.ts',
            ],
        ],
        [
            'the SCIM Groups ceiling',
            ['SCIM_GROUP_ASSIGNABLE_ROLES'],
            ['src/app-layer/usecases/scim-groups.ts', 'src/lib/scim/roles.ts'],
        ],
        [
            'the Entra mapping list',
            ['ENTRA_MAPPABLE_ROLES', 'EntraMappableRole'],
            [
                'src/app-layer/schemas/entra-group-mapping.schemas.ts',
                'src/app/t/[tenantSlug]/(app)/admin/entra/GroupMappingsSection.tsx',
            ],
        ],
    ] as const)('%s has exactly its intended consumers', (_label, identifiers, expected) => {
        expect(consumersOf(...identifiers)).toEqual([...expected].sort());
    });

    it('no Zod schema is built from the generated Role enum except a listed reader', () => {
        const fromEnum = srcFiles
            .filter((f) => /z\.(?:nativeEnum|enum)\(\s*(?:\$Enums\.)?Role\s*\)/.test(f.code))
            .map((f) => f.rel)
            .sort();
        expect(fromEnum).toEqual(Object.keys(ROLE_ENUM_SCHEMA_READERS).sort());
    });

    it.each([
        ['src/app/api/t/[tenantSlug]/admin/members/route.ts', 'ASSIGNABLE_TENANT_ROLES'],
        ['src/app/api/t/[tenantSlug]/admin/invites/route.ts', 'ASSIGNABLE_TENANT_ROLES'],
        ['src/app/api/t/[tenantSlug]/admin/members/[membershipId]/route.ts', 'MEMBER_ROLE_CHANGE_ROLES'],
    ])('%s validates `role` against %s, not a literal list of its own', (rel, list) => {
        const code = srcFiles.find((f) => f.rel === rel)?.code ?? '';
        expect({
            fromSharedList: (code.match(new RegExp(`role:\\s*z\\.enum\\(${list}\\)`, 'g')) ?? []).length,
            literalRoleEnum: /z\.enum\(\s*\[\s*'OWNER'/.test(code),
        }).toEqual({ fromSharedList: 1, literalRoleEnum: false });
    });

    it('the narrower lists: SCIM’s Users ceiling excludes it, the Groups ceiling and Entra mappings carry it', () => {
        expect(SCIM_ASSIGNABLE_ROLES as readonly string[]).not.toContain('AI_ADMIN');
        expect(SCIM_GROUP_ASSIGNABLE_ROLES as readonly string[]).toContain('AI_ADMIN');
        expect(ENTRA_MAPPABLE_ROLES as readonly string[]).toContain('AI_ADMIN');
        expect(NEVER_GROUP_MAPPED_ROLES).not.toContain('AI_ADMIN');
    });
});

// ─── BEHAVIOUR ─────────────────────────────────────────────────────

const owner = () => makeRequestContext('OWNER', { tenantId: 'tenant-1', userId: 'owner-1' });

beforeEach(() => {
    jest.clearAllMocks();
    mockRunInTx.mockImplementation(async () => {
        throw new Error('the database was reached');
    });
});

describe('BEHAVIOUR — the two writers write it', () => {
    it('updateTenantMemberRole: an OWNER moves an existing member into AI_ADMIN, audited', async () => {
        const update = jest.fn().mockResolvedValue({ id: 'm-1', role: 'AI_ADMIN', user: { email: 'u@x' } });
        const db = {
            tenantMembership: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'm-1',
                    userId: 'u-1',
                    role: 'READER',
                    customRoleId: null,
                    user: { id: 'u-1', email: 'u@x' },
                }),
                update,
            },
        };
        mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db));
        await updateTenantMemberRole(owner(), { membershipId: 'm-1', role: 'AI_ADMIN' });
        expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { role: 'AI_ADMIN' } }));
        expect((logEvent as jest.Mock).mock.calls[0][2]).toMatchObject({
            action: 'MEMBER_ROLE_CHANGED',
            detailsJson: expect.objectContaining({ fromStatus: 'READER', toStatus: 'AI_ADMIN' }),
        });
    });

    it.each([
        ['the sign-in path', undefined],
        ['the SCIM Groups path', SCIM_GROUP_ASSIGNABLE_ROLES],
    ] as const)('syncEntraMembershipRole writes it through a mapping on %s', async (_label, ceiling) => {
        const update = jest.fn();
        const db = {
            tenantIdentityProvider: { findFirst: jest.fn().mockResolvedValue(null) },
            tenantEntraGroupMapping: {
                findMany: jest.fn().mockResolvedValue([{ aadGroupId: 'g-ai', role: 'AI_ADMIN', priority: 0 }]),
            },
            tenantMembership: {
                findFirst: jest.fn().mockResolvedValue({ id: 'm-1', role: 'READER', customRoleId: null }),
                update,
            },
        };
        const result = await syncEntraMembershipRole(
            { userId: 'u-1', tenantId: 'tenant-1', aadGroups: ['g-ai'], assignableRoles: ceiling },
            { db: db as never },
        );
        expect(result).toEqual({ effectiveRole: 'AI_ADMIN', changed: true, gateDenied: false });
        expect(update).toHaveBeenCalledWith({ where: { id: 'm-1' }, data: { role: 'AI_ADMIN' } });
        expect(appendAuditEntryMock.mock.calls[0][0]).toMatchObject({ action: 'MEMBER_ROLE_CHANGED' });
    });
});

describe('BEHAVIOUR — every other membership-role writer refuses it', () => {
    const REFUSAL = /AI_ADMIN role cannot be assigned here/;
    const routeArgs = (extra: Record<string, string> = {}) => ({
        params: Promise.resolve({ tenantSlug: 'acme', ...extra }),
    });
    const post = (body: unknown) =>
        new NextRequest('http://localhost/api/t/acme/admin/x', {
            method: 'POST',
            headers: new Headers({ 'content-type': 'application/json' }),
            body: JSON.stringify(body),
        });

    it.each([
        ['the direct member add', '@/app/api/t/[tenantSlug]/admin/members/route'],
        ['the invites route', '@/app/api/t/[tenantSlug]/admin/invites/route'],
    ])('%s refuses it with a 400, for an OWNER, before any write', async (_label, mod) => {
        getTenantCtxMock.mockResolvedValue(owner());
        const { POST } = (await import(mod)) as { POST: (r: NextRequest, a: unknown) => Promise<Response> };
        const res = await POST(post({ email: 'x@example.com', role: 'AI_ADMIN' }), routeArgs());
        expect(res.status).toBe(400);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('createInviteToken refuses it before touching the database', async () => {
        await expect(
            createInviteToken(owner(), { email: 'x@example.com', role: 'AI_ADMIN' as never }),
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(
            createInviteToken(owner(), { email: 'x@example.com', role: 'AI_ADMIN' as never }),
        ).rejects.toThrow(REFUSAL);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('redeemInvite materialises no membership from an AI_ADMIN invite row (it stays burnt)', async () => {
        prismaMock.tenantInvite.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.tenantInvite.findUnique.mockResolvedValue({
            id: 'inv-1',
            tenantId: 'tenant-1',
            email: 'x@example.com',
            role: 'AI_ADMIN',
            invitedById: 'owner-1',
            createdAt: new Date(),
        });
        await expect(
            redeemInvite({ token: 't', userId: 'u-1', userEmail: 'x@example.com' }),
        ).rejects.toThrow(REFUSAL);
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('redeemPendingInvitesByEmail skips an AI_ADMIN invite without claiming it', async () => {
        prismaMock.tenantInvite.findMany.mockResolvedValue([
            { id: 'inv-1', tenantId: 'tenant-1', role: 'AI_ADMIN', invitedById: 'o', createdAt: new Date() },
        ]);
        await expect(
            redeemPendingInvitesByEmail({ userId: 'u-1', userEmail: 'x@example.com' }),
        ).resolves.toEqual([]);
        expect(prismaMock.tenantInvite.updateMany).not.toHaveBeenCalled();
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('an access review MODIFY decision cannot target it (submission)', () => {
        expect(SubmitDecisionSchema.safeParse({ decision: 'MODIFY', modifiedToRole: 'AI_ADMIN' }).success).toBe(false);
        expect(SubmitDecisionSchema.safeParse({ decision: 'MODIFY', modifiedToRole: 'EDITOR' }).success).toBe(true);
    });

    it('closing a review whose stored MODIFY targets it refuses the whole close before any row executes', async () => {
        const db = {
            accessReview: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'ar-1',
                    tenantId: 'tenant-1',
                    // A member campaign: the close refuses any other scope
                    // before it reads a decision (3a, #3674).
                    scope: 'ALL_USERS',
                    status: 'IN_REVIEW',
                    deletedAt: null,
                    reviewer: { email: 'r@x' },
                    createdBy: { email: 'c@x' },
                }),
            },
            accessReviewDecision: {
                findMany: jest.fn().mockResolvedValue([
                    {
                        id: 'd-1',
                        membershipId: 'm-1',
                        subjectUserId: 'u-1',
                        snapshotRole: 'READER',
                        snapshotMembershipStatus: 'ACTIVE',
                        decision: 'MODIFY',
                        modifiedToRole: 'AI_ADMIN',
                        modifiedToCustomRoleId: null,
                        executedAt: null,
                        membership: { id: 'm-1', userId: 'u-1', role: 'READER', status: 'ACTIVE' },
                        subjectUser: { id: 'u-1', email: 'u@x', name: null },
                    },
                ]),
            },
            tenantMembership: { findMany: jest.fn(), update: jest.fn() },
        };
        mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db));
        await expect(closeAccessReview(owner(), 'ar-1')).rejects.toThrow(REFUSAL);
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('a custom role cannot be built on it — on create or on update', async () => {
        await expect(
            createCustomRole(owner(), {
                name: 'Agents',
                baseRole: 'AI_ADMIN' as never,
                permissionsJson: getPermissionsForRole('READER'),
            }),
        ).rejects.toThrow(/Invalid base role: AI_ADMIN/);
        const db = {
            tenantCustomRole: {
                findFirst: jest.fn().mockResolvedValue({ id: 'cr-1', tenantId: 'tenant-1', baseRole: 'READER' }),
                update: jest.fn(),
            },
        };
        mockRunInTx.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(db));
        await expect(updateCustomRole(owner(), 'cr-1', { baseRole: 'AI_ADMIN' as never })).rejects.toThrow(
            /Invalid base role: AI_ADMIN/,
        );
        expect(db.tenantCustomRole.update).not.toHaveBeenCalled();
    });

    it('SCIM Users: an IdP asking for it gets the default role, flagged blocked; an AI_ADMIN role is never rewritten', () => {
        for (const v of ['AI_ADMIN', 'ai_admin', 'Ai_Admin']) {
            expect(resolveScimRole(v)).toEqual({ role: 'READER', blocked: true, requestedRole: v });
        }
        expect(isScimAssignableRole('AI_ADMIN')).toBe(false);
        expect(isScimProtectedRole('AI_ADMIN')).toBe(true);
    });

    it('SCIM Users: a deprovision may switch an AI_ADMIN membership off, and never an ADMIN or OWNER one (owner decision, 2026-10-18)', () => {
        expect(isScimStatusProtectedRole('AI_ADMIN')).toBe(false);
        for (const role of SCIM_ASSIGNABLE_ROLES) expect(isScimStatusProtectedRole(role)).toBe(false);
        expect(isScimStatusProtectedRole('ADMIN')).toBe(true);
        expect(isScimStatusProtectedRole('OWNER')).toBe(true);
        // A role nobody has classified yet is protected by default.
        expect(isScimStatusProtectedRole('SOME_FUTURE_ROLE')).toBe(true);
    });

    it('Entra group mappings: the schema now accepts it, and still refuses OWNER', () => {
        const aadGroupId = '00000000-0000-4000-8000-000000000001';
        expect(EntraGroupMappingCreateSchema.safeParse({ aadGroupId, role: 'AI_ADMIN' }).success).toBe(true);
        expect(EntraGroupMappingUpdateSchema.safeParse({ role: 'AI_ADMIN' }).success).toBe(true);
        expect(EntraGroupMappingCreateSchema.safeParse({ aadGroupId, role: 'OWNER' }).success).toBe(false);
    });

    it('SSO JIT: the default role cannot be it', () => {
        const base = { name: 'IdP', type: 'OIDC', config: {}, allowJitProvisioning: true };
        const parsed = UpsertSsoConfigInput.safeParse({ ...base, jitDefaultRole: 'AI_ADMIN' });
        expect(parsed.success).toBe(false);
        expect(
            parsed.success ? [] : parsed.error.issues.filter((i) => i.path[0] === 'jitDefaultRole').length,
        ).toBe(1);
    });
});
