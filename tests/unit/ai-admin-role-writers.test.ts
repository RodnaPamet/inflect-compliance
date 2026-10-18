/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles that stand
 * in for a Prisma client; the file-level disable is this repo's standard for
 * the shape. */
/**
 * Nothing writes the AI_ADMIN role yet (#3699, deploy 1 of 2).
 *
 * `AI_ADMIN` reaches `Role` in two deploys so that no running container reads
 * a membership role its Prisma client does not know — an old client reading
 * such a row fails with "Value 'AI_ADMIN' not found in enum 'Role'", for every
 * request that touches the membership. In THIS deploy the value exists and
 * every reader handles it, and nothing may write it. Deploy 2 lets an OWNER
 * assign it on the members page, and that change is `ASSIGNABLE_TENANT_ROLES`
 * gaining the value — which turns the first test here red, on purpose.
 *
 * Two halves:
 *
 *   STRUCTURE — every file whose CODE (comments stripped) names the value is a
 *   listed reader with its reason; no file writes the value to a membership in
 *   any spelling; every writer's role list excludes it; no Zod schema is built
 *   from the generated `Role` enum (which carries it) except one listed reader;
 *   and the three member/invite routes validate against the writers' list.
 *
 *   BEHAVIOUR — each writer refuses it: the role-change usecase, invite
 *   creation, both invite redemptions, an access review's MODIFY (submission
 *   and close), custom-role bases, SCIM (Users and Groups), Entra group
 *   mappings (schema, resolver and the sign-in sync) and SSO JIT.
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
    $transaction: jest.fn(),
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, prisma: prismaMock, default: prismaMock }));

import { readFileSync } from 'fs';

import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';
import { makeRequestContext } from '../helpers/make-context';
import { ASSIGNABLE_TENANT_ROLES, TENANT_ROLES, isAssignableTenantRole } from '@/lib/roles';
import { runInTenantContext } from '@/lib/db-context';
import { updateTenantMemberRole } from '@/app-layer/usecases/tenant-admin';
import {
    createInviteToken,
    redeemInvite,
    redeemPendingInvitesByEmail,
} from '@/app-layer/usecases/tenant-invites';
import { SubmitDecisionSchema } from '@/app-layer/schemas/access-review.schemas';
import { closeAccessReview } from '@/app-layer/usecases/access-review';
import { createCustomRole } from '@/app-layer/usecases/custom-roles';
import { getPermissionsForRole } from '@/lib/permissions';
import {
    SCIM_ASSIGNABLE_ROLES,
    isScimAssignableRole,
    isScimProtectedRole,
} from '@/lib/scim/roles';
import { resolveScimRole } from '@/app-layer/usecases/scim-users';
import {
    ENTRA_MAPPABLE_ROLES,
    EntraGroupMappingCreateSchema,
    EntraGroupMappingUpdateSchema,
} from '@/app-layer/schemas/entra-group-mapping.schemas';
import { NEVER_GROUP_MAPPED_ROLES, resolveRoleFromGroups } from '@/lib/auth/entra-role-mapping';
import { syncEntraMembershipRole } from '@/lib/auth/entra-group-sync';
import { UpsertSsoConfigInput } from '@/app-layer/schemas/sso-config.schemas';
import { ValidationError } from '@/lib/errors/types';

const mockRunInTx = runInTenantContext as jest.MockedFunction<any>;

// ─── STRUCTURE ─────────────────────────────────────────────────────

/** Files whose code names AI_ADMIN to READ it, and why. A writer is not one. */
const READERS: Readonly<Record<string, string>> = {
    'src/lib/roles.ts': 'TENANT_ROLES, the exhaustive list for readers; the writers’ list excludes it',
    'src/lib/permissions.ts': 'getPermissionsForRole: READER’s set plus the agent keys',
    'src/lib/tenant-context.ts': 'ROLE_ORDER: READER’s rung of the coarse ladder',
    'src/lib/agentic/agent-authority.ts': 'ROLE_RANK: READER’s rung, a label only',
    'src/lib/auth.ts': 'ROLE_HIERARCHY and canRead: READER’s rung',
    'src/lib/auth/entra-role-mapping.ts': 'NEVER_GROUP_MAPPED_ROLES: a group mapping can never yield it',
    'src/lib/auth/guard.ts': 'checkAdminAccess: admits it to the agent admin paths only',
    'src/lib/agentic/ownership-transfer.ts': 'TRANSFER_RECIPIENT_MEMBERSHIP_ROLES: it can receive an agent',
    'src/app-layer/policies/audit-readiness.policies.ts': 'assertCanViewPack: views packs like a READER',
    'src/app-layer/policies/issue.policies.ts': 'assertCanComment: refuses it like a READER',
    'src/app/t/[tenantSlug]/(app)/tasks/[taskId]/page.tsx': 'hides the comment form, like a READER',
    'src/app/t/[tenantSlug]/(app)/admin/rbac/page.tsx': 'a column in the permission matrix',
    'src/app/t/[tenantSlug]/(app)/admin/members/page.tsx': 'a badge tone; the picker does not offer it',
};

/** Files that may WRITE AI_ADMIN to a membership. Empty in deploy 1; deploy 2 adds the members-page path. */
const WRITERS: readonly string[] = [];

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

describe('STRUCTURE — nothing writes AI_ADMIN in deploy 1', () => {
    it('the population is real', () => {
        expect(srcFiles.length).toBeGreaterThan(1000);
    });

    it('the writers’ list excludes AI_ADMIN, and readers’ list names it (deploy 2 flips the first)', () => {
        expect(isAssignableTenantRole('AI_ADMIN')).toBe(false);
        expect([...ASSIGNABLE_TENANT_ROLES].sort()).toEqual(['ADMIN', 'AUDITOR', 'EDITOR', 'OWNER', 'READER']);
        expect(TENANT_ROLES).toContain('AI_ADMIN');
        expect(WRITERS).toEqual([]);
    });

    it('every file whose code names AI_ADMIN is a listed reader — and every listed reader still does', () => {
        const naming = srcFiles.filter((f) => namesAiAdmin(f.code)).map((f) => f.rel).sort();
        expect(naming).toEqual(Object.keys(READERS).sort());
    });

    it('no file writes AI_ADMIN to a membership, in any spelling', () => {
        const writes = srcFiles
            .filter((f) => !WRITERS.includes(f.rel))
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

    it('no Zod schema is built from the generated Role enum except a listed reader', () => {
        const fromEnum = srcFiles
            .filter((f) => /z\.(?:nativeEnum|enum)\(\s*(?:\$Enums\.)?Role\s*\)/.test(f.code))
            .map((f) => f.rel)
            .sort();
        expect(fromEnum).toEqual(Object.keys(ROLE_ENUM_SCHEMA_READERS).sort());
    });

    it.each([
        'src/app/api/t/[tenantSlug]/admin/members/route.ts',
        'src/app/api/t/[tenantSlug]/admin/members/[membershipId]/route.ts',
        'src/app/api/t/[tenantSlug]/admin/invites/route.ts',
    ])('%s validates `role` against the writers’ list, not a literal list of its own', (rel) => {
        const code = srcFiles.find((f) => f.rel === rel)?.code ?? '';
        expect({
            fromWritersList: (code.match(/role:\s*z\.enum\(ASSIGNABLE_TENANT_ROLES\)/g) ?? []).length,
            literalRoleEnum: /z\.enum\(\s*\[\s*'OWNER'/.test(code),
        }).toEqual({ fromWritersList: 1, literalRoleEnum: false });
    });

    it('every narrower writer list excludes it too', () => {
        expect(SCIM_ASSIGNABLE_ROLES as readonly string[]).not.toContain('AI_ADMIN');
        expect(ENTRA_MAPPABLE_ROLES as readonly string[]).not.toContain('AI_ADMIN');
        expect(NEVER_GROUP_MAPPED_ROLES).toContain('AI_ADMIN');
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

describe('BEHAVIOUR — every membership-role writer refuses AI_ADMIN', () => {
    it('updateTenantMemberRole refuses it before touching the database', async () => {
        await expect(
            updateTenantMemberRole(owner(), { membershipId: 'm-1', role: 'AI_ADMIN' as never }),
        ).rejects.toThrow(/AI_ADMIN role cannot be assigned yet/);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('updateTenantMemberRole still reaches the database for an assignable role', async () => {
        await expect(
            updateTenantMemberRole(owner(), { membershipId: 'm-1', role: 'EDITOR' }),
        ).rejects.toThrow('the database was reached');
    });

    it('createInviteToken refuses it before touching the database', async () => {
        await expect(
            createInviteToken(owner(), { email: 'x@example.com', role: 'AI_ADMIN' as never }),
        ).rejects.toBeInstanceOf(ValidationError);
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
        ).rejects.toThrow(/AI_ADMIN role cannot be assigned yet/);
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
        await expect(closeAccessReview(owner(), 'ar-1')).rejects.toThrow(/AI_ADMIN role cannot be assigned yet/);
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
    });

    it('a custom role cannot be built on it', async () => {
        await expect(
            createCustomRole(owner(), {
                name: 'Agents',
                baseRole: 'AI_ADMIN' as never,
                permissionsJson: getPermissionsForRole('READER'),
            }),
        ).rejects.toThrow(/Invalid base role: AI_ADMIN/);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('SCIM Users: an IdP asking for it gets the default role, flagged blocked; an AI_ADMIN membership is protected', () => {
        for (const v of ['AI_ADMIN', 'ai_admin', 'Ai_Admin']) {
            expect(resolveScimRole(v)).toEqual({ role: 'READER', blocked: true, requestedRole: v });
        }
        expect(isScimAssignableRole('AI_ADMIN')).toBe(false);
        expect(isScimProtectedRole('AI_ADMIN')).toBe(true);
    });

    it('Entra group mappings: the schema refuses it on create and on update', () => {
        const aadGroupId = '00000000-0000-4000-8000-000000000001';
        expect(EntraGroupMappingCreateSchema.safeParse({ aadGroupId, role: 'AI_ADMIN' }).success).toBe(false);
        expect(EntraGroupMappingUpdateSchema.safeParse({ role: 'AI_ADMIN' }).success).toBe(false);
        expect(EntraGroupMappingCreateSchema.safeParse({ aadGroupId, role: 'EDITOR' }).success).toBe(true);
    });

    it('Entra group mappings: a STORED AI_ADMIN mapping never wins, with or without a ceiling', () => {
        const mappings = [
            { aadGroupId: 'g-ai', role: 'AI_ADMIN' as never, priority: 1000 },
            { aadGroupId: 'g-reader', role: 'READER' as const, priority: 1 },
        ];
        expect(resolveRoleFromGroups(['g-ai'], mappings)).toEqual({
            role: null,
            matchedGroupIds: ['g-ai'],
            clampedGroupIds: ['g-ai'],
        });
        expect(resolveRoleFromGroups(['g-ai', 'g-reader'], mappings).role).toBe('READER');
        expect(
            resolveRoleFromGroups(['g-ai', 'g-reader'], mappings, { assignableRoles: SCIM_ASSIGNABLE_ROLES }).role,
        ).toBe('READER');
    });

    it('Entra sign-in sync: a stored AI_ADMIN mapping writes nothing', async () => {
        const db = {
            tenantIdentityProvider: { findFirst: jest.fn().mockResolvedValue(null) },
            tenantEntraGroupMapping: {
                findMany: jest.fn().mockResolvedValue([{ aadGroupId: 'g-ai', role: 'AI_ADMIN', priority: 1000 }]),
            },
            tenantMembership: {
                findFirst: jest.fn().mockResolvedValue({ id: 'm-1', role: 'READER' }),
                update: jest.fn(),
            },
        };
        const result = await syncEntraMembershipRole(
            { userId: 'u-1', tenantId: 'tenant-1', aadGroups: ['g-ai'] },
            { db: db as never },
        );
        expect(result).toEqual({ effectiveRole: null, changed: false, gateDenied: false });
        expect(db.tenantMembership.update).not.toHaveBeenCalled();
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
