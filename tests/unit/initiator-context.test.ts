/**
 * `resolveInitiatorContext` — the context a job builds for the member who
 * started it — resolves a membership exactly as a REQUEST does (#4362).
 *
 * For the same membership row it gives the role, coarse flags and granular set
 * `resolveTenantContext` gives:
 *
 *   - for a CUSTOM role, including a soft-deleted one the membership is still
 *     linked to, which a request applies;
 *   - for every BUILT-IN role, coarse flags included. The jobs used to project
 *     their coarse flags from the granular set, which gave EDITOR, READER and
 *     AI_ADMIN a `canAudit` their own request does not hold; the owner decided
 *     on 2026-10-26 that a job matches the request, and the last block records
 *     that this is the only thing that moved for a built-in role.
 */
const prismaMock = {
    tenant: { findUnique: jest.fn() },
    tenantMembership: { findUnique: jest.fn(), findFirst: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: prismaMock, prisma: prismaMock }));

import type { Role } from '@prisma/client';
import {
    resolveInitiatorContext,
    initiatorAuthority,
    buildDelegatedJobContext,
} from '@/app-layer/context-system';
import { resolveTenantContext, computePermissions } from '@/lib/tenant-context';
import { getPermissionsForRole } from '@/lib/permissions';

const BUILT_IN: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR', 'READER', 'AI_ADMIN'];

const EDITOR = getPermissionsForRole('EDITOR');
const READER = getPermissionsForRole('READER');

/** A full membership row, as the database holds it. */
function row(role: Role, customRole: Record<string, unknown> | null) {
    return {
        id: 'm-1',
        tenantId: 'tenant-A',
        userId: 'user-1',
        role,
        status: 'ACTIVE',
        customRoleId: customRole ? 'cr-1' : null,
        customRole,
    };
}

function customRole(baseRole: Role, permissionsJson: unknown, isActive = true) {
    return { id: 'cr-1', tenantId: 'tenant-A', name: 'Custom', baseRole, permissionsJson, isActive };
}

/** What a request from this membership resolves to. */
async function requestAuthority(membership: ReturnType<typeof row>) {
    prismaMock.tenant.findUnique.mockResolvedValue({ id: 'tenant-A', slug: 'acme', deletedAt: null });
    prismaMock.tenantMembership.findUnique.mockResolvedValue(membership);
    const t = await resolveTenantContext({ tenantId: 'tenant-A' }, 'user-1');
    return { role: t.role, permissions: t.permissions, appPermissions: t.appPermissions };
}

/** What the job's context resolves to, for the same row. */
async function jobAuthority(membership: ReturnType<typeof row>) {
    prismaMock.tenantMembership.findFirst.mockResolvedValue(membership);
    const ctx = await resolveInitiatorContext({ tenantId: 'tenant-A', userId: 'user-1', requestId: 'req-1' });
    if (!ctx) throw new Error('expected a context');
    return { role: ctx.role, permissions: ctx.permissions, appPermissions: ctx.appPermissions };
}

/** The coarse flags evidence-import and sharepoint-delta-sync built before #4362. */
function evidenceJobProjection(role: Role) {
    const p = getPermissionsForRole(role);
    return {
        canRead: p.evidence.view,
        canWrite: p.evidence.upload,
        canAdmin: p.admin.manage,
        canAudit: p.audits.view,
        canExport: p.reports.export,
    };
}

/** The coarse flags a queued workflow run was rebuilt with before #4362. */
function workflowRunProjection(role: Role) {
    const p = getPermissionsForRole(role);
    return {
        canRead: p.risks.view,
        canWrite: p.risks.edit,
        canAdmin: p.admin.manage,
        canAudit: p.audits.view,
        canExport: p.reports.export,
    };
}

beforeEach(() => jest.clearAllMocks());

describe('a custom role resolves as a request resolves it', () => {
    const cases: Array<[string, ReturnType<typeof row>]> = [
        [
            'EDITOR base withholding evidence.upload',
            row('EDITOR', customRole('EDITOR', { evidence: { ...EDITOR.evidence, upload: false } })),
        ],
        [
            'EDITOR base withholding controls.edit',
            row('EDITOR', customRole('EDITOR', { controls: { ...EDITOR.controls, edit: false } })),
        ],
        [
            'READER base granting evidence.upload',
            row('READER', customRole('READER', { evidence: { ...READER.evidence, upload: true } })),
        ],
        [
            'an ADMIN membership carrying a READER-based role',
            row('ADMIN', customRole('READER', {})),
        ],
        [
            'a malformed permissionsJson, which falls back to the base role',
            row('EDITOR', customRole('AUDITOR', 'not-an-object')),
        ],
    ];

    it.each(cases)('%s', async (_label, membership) => {
        const job = await jobAuthority(membership);
        expect(job).toEqual(await requestAuthority(membership));
        // Not the built-in role's set: the custom role is what is read.
        expect(job.appPermissions).not.toEqual(getPermissionsForRole(membership.role));
    });

    it('a soft-deleted custom role still linked to the membership: applied, as a request applies it', async () => {
        // `deleteCustomRole` clears every link to the role it deactivates, so
        // this row needs legacy data or a race to exist. A request reads the
        // link and never `isActive`; the job reads exactly the same.
        const membership = row(
            'EDITOR',
            customRole('EDITOR', { evidence: { ...EDITOR.evidence, upload: false } }, false),
        );
        const job = await jobAuthority(membership);
        expect(job).toEqual(await requestAuthority(membership));
        expect(job.appPermissions.evidence.upload).toBe(false);
    });
});

describe('a built-in role resolves as a request resolves it, coarse flags included', () => {
    it.each(BUILT_IN)('%s', async (role) => {
        const membership = row(role, null);
        const job = await jobAuthority(membership);
        expect(job).toEqual(await requestAuthority(membership));
        expect(job).toEqual({
            role,
            permissions: computePermissions(role),
            appPermissions: getPermissionsForRole(role),
        });
    });
});

describe('what moved for a built-in role, against the context these jobs built before', () => {
    it('only canAudit, for EDITOR, READER and AI_ADMIN, from true to a request\'s false', () => {
        // Both old projections — the evidence jobs' and the queued run's — land
        // on the same five flags for every built-in role.
        const moved = BUILT_IN.flatMap((role) => {
            const now = initiatorAuthority({ role, customRole: null }).permissions;
            const before = evidenceJobProjection(role);
            expect(workflowRunProjection(role)).toEqual(before);
            return (Object.keys(before) as Array<keyof typeof before>)
                .filter((flag) => now[flag] !== before[flag])
                .map((flag) => `${role}.${flag}:${before[flag]}->${now[flag]}`);
        });
        expect(moved).toEqual([
            'EDITOR.canAudit:true->false',
            'READER.canAudit:true->false',
            'AI_ADMIN.canAudit:true->false',
        ]);
    });
});

describe('the refusal and the request id', () => {
    it('returns null — a refusal — for a member with no ACTIVE membership', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue(null);
        await expect(
            resolveInitiatorContext({ tenantId: 'tenant-A', userId: 'user-1', requestId: 'req-1' }),
        ).resolves.toBeNull();
        expect(prismaMock.tenantMembership.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'user-1', tenantId: 'tenant-A', status: 'ACTIVE' } }),
        );
    });

    it('carries the caller’s request id, user and tenant', async () => {
        prismaMock.tenantMembership.findFirst.mockResolvedValue(row('EDITOR', null));
        const ctx = await resolveInitiatorContext({ tenantId: 'tenant-A', userId: 'user-1', requestId: 'req-9' });
        expect(ctx).toMatchObject({ requestId: 'req-9', userId: 'user-1', tenantId: 'tenant-A' });
    });
});

/**
 * The granular half of a delegated job context (#4388).
 *
 * `buildDelegatedJobContext` took a `permissions` override and hardcoded
 * `appPermissions` to ADMIN's set, so a caller that narrowed the coarse flags
 * got a context that still passed every purely-granular assert --
 * `assertCanUploadEvidence` reads `appPermissions.evidence.upload` and nothing
 * else. The two halves are narrowed together or the narrowing is decorative.
 */
describe('a delegated job context can narrow its granular set, not just the coarse flags', () => {
    const base = { tenantId: 'tenant-A', job: 'j', onBehalfOf: 'user-1' };

    it("defaults to ADMIN's granular set, so no existing caller moves", () => {
        expect(buildDelegatedJobContext(base).appPermissions).toEqual(getPermissionsForRole('ADMIN'));
    });

    it('honours a narrower granular set when one is passed', () => {
        const ctx = buildDelegatedJobContext({ ...base, appPermissions: getPermissionsForRole('EDITOR') });
        expect(ctx.appPermissions).toEqual(getPermissionsForRole('EDITOR'));
        // The key the coarse flags cannot speak for.
        expect(ctx.appPermissions.admin.manage).toBe(false);
    });

    it('does not infer the granular set from the coarse flags — they are set independently', () => {
        // Narrowing only the coarse half is what the old signature forced, and
        // this is what it produced: canAdmin false beside admin.manage true.
        const coarseOnly = buildDelegatedJobContext({
            ...base,
            permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: false },
        });
        expect(coarseOnly.permissions.canAdmin).toBe(false);
        expect(coarseOnly.appPermissions.admin.manage).toBe(true);
    });
});
