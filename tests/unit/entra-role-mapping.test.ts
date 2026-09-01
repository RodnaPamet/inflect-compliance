/**
 * EI-2 — `resolveRoleFromGroups` deterministic role resolution. EI-3 relies on
 * this being stable (same groups + mappings → same role every sign-in), so the
 * tie-break ordering is pinned here.
 */
import { resolveRoleFromGroups } from '@/lib/auth/entra-role-mapping';
import type { Role } from '@prisma/client';

const m = (aadGroupId: string, role: Role, priority = 0) => ({ aadGroupId, role, priority });

describe('resolveRoleFromGroups', () => {
    it('returns null when the user matches no mapped group', () => {
        const r = resolveRoleFromGroups(['g-x'], [m('g-1', 'EDITOR')]);
        expect(r).toEqual({ role: null, matchedGroupIds: [], clampedGroupIds: [] });
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
