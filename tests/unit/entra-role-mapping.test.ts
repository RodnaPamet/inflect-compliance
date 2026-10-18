/**
 * EI-2 — `resolveRoleFromGroups` deterministic role resolution. EI-3 relies on
 * this being stable (same groups + mappings → same role every sign-in), so the
 * tie-break ordering is pinned here.
 */
import { NEVER_GROUP_MAPPED_ROLES, resolveRoleFromGroups } from '@/lib/auth/entra-role-mapping';
import { ENTRA_MAPPABLE_ROLES } from '@/app-layer/schemas/entra-group-mapping.schemas';
import { SCIM_GROUP_ASSIGNABLE_ROLES } from '@/lib/scim/roles';
import { TENANT_ROLES } from '@/lib/roles';
import { getPermissionsForRole, permissionsExceeding } from '@/lib/permissions';
import type { Role } from '@prisma/client';

const m = (aadGroupId: string, role: Role, priority = 0) => ({ aadGroupId, role, priority });

describe('resolveRoleFromGroups', () => {
    it('returns null when the user matches no mapped group', () => {
        const r = resolveRoleFromGroups(['g-x'], [m('g-1', 'EDITOR')]);
        expect(r).toEqual({ role: null, matchedGroupIds: [], clampedGroupIds: [], ambiguousGroupIds: [] });
    });

    it('returns the single matching mapping', () => {
        const r = resolveRoleFromGroups(['g-1'], [m('g-1', 'EDITOR'), m('g-2', 'ADMIN')]);
        expect(r.role).toBe('EDITOR');
        expect(r.matchedGroupIds).toEqual(['g-1']);
    });

    it('highest priority wins regardless of role seniority', () => {
        const r = resolveRoleFromGroups(
            ['g-low', 'g-high'],
            [m('g-low', 'ADMIN', 1), m('g-high', 'READER', 9)],
        );
        // READER@9 beats ADMIN@1 — admin-set priority is the primary signal.
        expect(r.role).toBe('READER');
        expect(r.matchedGroupIds.sort()).toEqual(['g-high', 'g-low']);
    });

    it('breaks a priority tie by role seniority (more senior wins)', () => {
        const r = resolveRoleFromGroups(
            ['g-a', 'g-b'],
            [m('g-a', 'READER', 5), m('g-b', 'ADMIN', 5)],
        );
        expect(r.role).toBe('ADMIN');
    });

    it('breaks a priority+seniority tie deterministically by aadGroupId', () => {
        const r1 = resolveRoleFromGroups(
            ['g-2', 'g-1'],
            [m('g-2', 'EDITOR', 0), m('g-1', 'EDITOR', 0)],
        );
        const r2 = resolveRoleFromGroups(
            ['g-1', 'g-2'],
            [m('g-1', 'EDITOR', 0), m('g-2', 'EDITOR', 0)],
        );
        // Same inputs in any order → same winner (lowest aadGroupId).
        expect(r1.role).toBe('EDITOR');
        expect(r2.role).toBe('EDITOR');
    });

    it('reports every matched group, not just the winner (for audit + the gate)', () => {
        const r = resolveRoleFromGroups(
            ['g-1', 'g-2', 'g-3'],
            [m('g-1', 'READER', 1), m('g-2', 'EDITOR', 2)],
        );
        expect(r.matchedGroupIds.sort()).toEqual(['g-1', 'g-2']);
    });
});

/**
 * The ceiling a restricted caller (SCIM Groups push) supplies. It filters the
 * CANDIDATE POOL, not the winner — see `ResolveRoleOptions`.
 */
describe('resolveRoleFromGroups — assignableRoles ceiling', () => {
    const CEILING = ['READER', 'EDITOR', 'AUDITOR'] as const;

    it('drops an out-of-ceiling mapping instead of returning it', () => {
        const r = resolveRoleFromGroups(['g-1'], [m('g-1', 'ADMIN', 10)], {
            assignableRoles: CEILING,
        });
        expect(r.role).toBeNull();
        expect(r.clampedGroupIds).toEqual(['g-1']);
        // The gate + audit still see the group the user is genuinely in.
        expect(r.matchedGroupIds).toEqual(['g-1']);
    });

    it('promotes the next eligible mapping — a clamp, not a refusal', () => {
        // ADMIN outranks on priority AND seniority, so it wins unclamped.
        const mappings = [m('g-admin', 'ADMIN', 10), m('g-editor', 'EDITOR', 1)];
        expect(resolveRoleFromGroups(['g-admin', 'g-editor'], mappings).role).toBe('ADMIN');
        expect(
            resolveRoleFromGroups(['g-admin', 'g-editor'], mappings, {
                assignableRoles: CEILING,
            }).role,
        ).toBe('EDITOR');
    });

    it('is inert when every matched mapping is already inside the ceiling', () => {
        const r = resolveRoleFromGroups(['g-1'], [m('g-1', 'EDITOR', 1)], {
            assignableRoles: CEILING,
        });
        expect(r.role).toBe('EDITOR');
        expect(r.clampedGroupIds).toEqual([]);
    });

    it('omitting the option leaves the sign-in path unclamped', () => {
        expect(resolveRoleFromGroups(['g-1'], [m('g-1', 'ADMIN', 1)]).role).toBe('ADMIN');
    });
});

/**
 * AI_ADMIN is mappable since deploy 2 of #3699, on the sign-in path (no
 * ceiling) and the SCIM Groups path (`SCIM_GROUP_ASSIGNABLE_ROLES`).
 */
describe('resolveRoleFromGroups — AI_ADMIN (#3699 deploy 2)', () => {
    it.each([
        ['the sign-in path (no ceiling)', undefined],
        ['the SCIM Groups path', SCIM_GROUP_ASSIGNABLE_ROLES],
    ] as const)('yields AI_ADMIN on %s', (_label, ceiling) => {
        const r = resolveRoleFromGroups(['g-ai'], [m('g-ai', 'AI_ADMIN', 0)], { assignableRoles: ceiling });
        expect(r).toEqual({
            role: 'AI_ADMIN',
            matchedGroupIds: ['g-ai'],
            clampedGroupIds: [],
            ambiguousGroupIds: [],
        });
    });

    it('the SCIM Groups ceiling still clamps ADMIN while it admits AI_ADMIN', () => {
        const mappings = [m('g-admin', 'ADMIN', 10), m('g-ai', 'AI_ADMIN', 1)];
        const r = resolveRoleFromGroups(['g-admin', 'g-ai'], mappings, {
            assignableRoles: SCIM_GROUP_ASSIGNABLE_ROLES,
        });
        expect({ role: r.role, clamped: r.clampedGroupIds }).toEqual({ role: 'AI_ADMIN', clamped: ['g-admin'] });
    });

    it('a tie with READER goes to AI_ADMIN — it holds everything READER does', () => {
        const r = resolveRoleFromGroups(['g-all', 'g-ai'], [m('g-all', 'READER', 0), m('g-ai', 'AI_ADMIN', 0)]);
        expect(r.role).toBe('AI_ADMIN');
        expect(r.ambiguousGroupIds).toEqual([]);
    });

    it.each(['ADMIN', 'EDITOR', 'AUDITOR'] as const)(
        'a tie with %s decides nothing — neither role silently replaces the other',
        (other) => {
            const r = resolveRoleFromGroups(['g-other', 'g-ai'], [m('g-other', other, 5), m('g-ai', 'AI_ADMIN', 5)]);
            expect(r).toEqual({
                role: null,
                matchedGroupIds: ['g-other', 'g-ai'],
                clampedGroupIds: [],
                ambiguousGroupIds: ['g-ai', 'g-other'],
            });
        },
    );

    it('a three-way top tie that includes an incomparable role is ambiguous too', () => {
        const r = resolveRoleFromGroups(
            ['g-r', 'g-e', 'g-ai'],
            [m('g-r', 'READER', 3), m('g-e', 'EDITOR', 3), m('g-ai', 'AI_ADMIN', 3)],
        );
        expect(r.role).toBeNull();
        expect(r.ambiguousGroupIds).toEqual(['g-ai', 'g-e', 'g-r']);
    });

    it.each(['ADMIN', 'EDITOR', 'AUDITOR'] as const)(
        'priority still decides outright against %s, in both directions',
        (other) => {
            const groups = ['g-other', 'g-ai'];
            expect(resolveRoleFromGroups(groups, [m('g-other', other, 1), m('g-ai', 'AI_ADMIN', 2)]).role).toBe(
                'AI_ADMIN',
            );
            expect(resolveRoleFromGroups(groups, [m('g-other', other, 2), m('g-ai', 'AI_ADMIN', 1)]).role).toBe(other);
        },
    );

    it('a lower-priority tie is never consulted: the top tier alone decides', () => {
        const r = resolveRoleFromGroups(
            ['g-e', 'g-ai', 'g-r'],
            [m('g-e', 'EDITOR', 1), m('g-ai', 'AI_ADMIN', 1), m('g-r', 'READER', 9)],
        );
        expect(r).toMatchObject({ role: 'READER', ambiguousGroupIds: [] });
    });

    it('a tie between two ladder roles is unchanged — the more senior wins', () => {
        const r = resolveRoleFromGroups(['g-e', 'g-a'], [m('g-e', 'EDITOR', 0), m('g-a', 'AUDITOR', 0)]);
        expect(r).toMatchObject({ role: 'EDITOR', ambiguousGroupIds: [] });
    });

    /**
     * The premise the tie rule stands on, computed from the real permission
     * sets rather than restated: AI_ADMIN holds everything READER holds, and
     * against each role the rule calls undecidable, each side holds a grant
     * the other lacks.
     */
    it('the premise: AI_ADMIN contains READER, and is incomparable with ADMIN, EDITOR and AUDITOR', () => {
        const ai = getPermissionsForRole('AI_ADMIN');
        const exceeds = (a: Role, b: Role) => permissionsExceeding(getPermissionsForRole(a), getPermissionsForRole(b));
        expect(permissionsExceeding(getPermissionsForRole('READER'), ai)).toEqual([]);
        for (const other of ['ADMIN', 'EDITOR', 'AUDITOR'] as const) {
            expect({
                other,
                aiLacks: exceeds(other, 'AI_ADMIN').length > 0,
                otherLacks: exceeds('AI_ADMIN', other).length > 0,
            }).toEqual({ other, aiLacks: true, otherLacks: true });
        }
    });
});

describe('NEVER_GROUP_MAPPED_ROLES — the read-side half of the schema', () => {
    it('is exactly the roles the mapping schema refuses (OWNER), so a stored row cannot do what the API cannot', () => {
        const refusedBySchema = TENANT_ROLES.filter((r) => !(ENTRA_MAPPABLE_ROLES as readonly string[]).includes(r));
        expect([...NEVER_GROUP_MAPPED_ROLES].sort()).toEqual([...refusedBySchema].sort());
        expect(NEVER_GROUP_MAPPED_ROLES).toEqual(['OWNER']);
    });

    it('a STORED OWNER mapping never wins, even at the top priority and with no ceiling', () => {
        const r = resolveRoleFromGroups(['g-own', 'g-r'], [m('g-own', 'OWNER', 1000), m('g-r', 'READER', 0)]);
        expect({ role: r.role, clamped: r.clampedGroupIds }).toEqual({ role: 'READER', clamped: ['g-own'] });
    });
});
