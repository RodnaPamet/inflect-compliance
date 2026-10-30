/**
 * Which custom roles only an ADMIN membership may carry (owner decision,
 * 2026-10-30) — THE RULE, as the pure predicate every writer asks.
 *
 *   1. On any membership but ADMIN, a custom role may not grant one of ten
 *      admin keys (`ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS`): six consumed only behind
 *      the admin API, and four refused by decision because such a membership
 *      reached them around the edge's role gate. The other nine admin keys are
 *      left alone.
 *   2. A custom role built on ADMIN may only be carried by an ADMIN
 *      membership: its base sets the coarse tier everywhere but the edge.
 *
 * Only what a change ADDS is refused, so a row written before the rule is
 * never trapped. The writers and their census are
 * `tests/unit/custom-role-carriage-writers.test.ts`; why each key is on the list
 * is held by `tests/guardrails/admin-membership-only-keys-are-dead-elsewhere.test.ts`.
 */
import {
    ADMIN_API_ONLY_KEYS,
    ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS,
    SIDE_DOOR_ADMIN_KEYS,
    CUSTOM_ROLE_ADMIN_BASE_REFUSAL,
    CUSTOM_ROLE_ADMIN_KEYS_REFUSAL,
    TENANT_ROLES,
    adminMembershipOnlyKeysGranted,
    customRoleCarriageDetails,
    customRoleCarriageMessage,
    customRoleCarriageOffence,
    customRoleCarriageRefusal,
    type CustomRoleForCarriage,
} from '@/lib/roles';
import { PERMISSION_SCHEMA, getPermissionsForRole, type PermissionSet } from '@/lib/permissions';

const NON_ADMIN_CARRIERS = ['EDITOR', 'READER', 'AUDITOR'] as const;

/** A full blob: `base`'s defaults with `admin` keys switched as given. */
function role(base: string, admin: Partial<PermissionSet['admin']> = {}): CustomRoleForCarriage {
    const defaults = getPermissionsForRole(base as never);
    return { baseRole: base, permissionsJson: { ...defaults, admin: { ...defaults.admin, ...admin } } };
}

const on = (membershipRole: string, customRole: CustomRoleForCarriage | null) => ({ membershipRole, customRole });

describe('the list', () => {
    it('is exactly the ten keys the owner ruled on, and each is a real admin key', () => {
        // Six because only the admin API reads them…
        expect([...ADMIN_API_ONLY_KEYS]).toEqual([
            'sso',
            'agent_tool_exposure',
            'agent_policy_card',
            'agent_ownership',
            'agent_skill_review',
            'agent_skill_author',
        ]);
        // …and four by decision, although they are live outside it.
        expect([...SIDE_DOOR_ADMIN_KEYS]).toEqual([
            'scim',
            'compliance_dsar_manage',
            'agent_harness_ingest',
            'agent_external_tools',
        ]);
        expect([...ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS]).toEqual([...ADMIN_API_ONLY_KEYS, ...SIDE_DOOR_ADMIN_KEYS]);
        expect(new Set(ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS).size).toBe(10);
        for (const key of ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS) expect(PERMISSION_SCHEMA.admin).toContain(key);
    });

    it('no EDITOR, READER or AUDITOR holds one by default, so a custom role copying its own role breaks nothing', () => {
        for (const carrier of NON_ADMIN_CARRIERS) {
            expect(adminMembershipOnlyKeysGranted(getPermissionsForRole(carrier))).toEqual([]);
            expect(customRoleCarriageRefusal(on(carrier, role(carrier)), null)).toBeNull();
        }
    });
});

describe('rule 1 — the admin-membership-only keys', () => {
    it.each(ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS)('admin.%s on an EDITOR, READER or AUDITOR membership is refused, by name', (key) => {
        for (const carrier of NON_ADMIN_CARRIERS) {
            const refusal = customRoleCarriageRefusal(on(carrier, role('READER', { [key]: true })), null);
            expect(refusal).toEqual({ reason: CUSTOM_ROLE_ADMIN_KEYS_REFUSAL, keys: [key] });
        }
    });

    it('the same role on an ADMIN membership is allowed — every key at once', () => {
        const all = Object.fromEntries(ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS.map((k) => [k, true]));
        expect(customRoleCarriageRefusal(on('ADMIN', role('READER', all)), null)).toBeNull();
    });

    it('the AUDITOR inventory case: the view key, the DSAR read and every other non-listed admin key stay allowed', () => {
        const others = PERMISSION_SCHEMA.admin.filter(
            (k) => !(ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS as readonly string[]).includes(k),
        );
        // tenant_lifecycle and owner_management are OWNER-only grants, but the
        // carriage rule does not judge them: `permissionsExceeding` decides who
        // may hand them out.
        expect(others).toHaveLength(9);
        const grantsEveryOther = role('READER', Object.fromEntries(others.map((k) => [k, true])));
        for (const carrier of NON_ADMIN_CARRIERS) {
            expect(customRoleCarriageRefusal(on(carrier, grantsEveryOther), null)).toBeNull();
        }
        expect(
            customRoleCarriageRefusal(on('AUDITOR', role('AUDITOR', { agent_registry_view: true, compliance_dsar_view: true })), null),
        ).toBeNull();
    });

    it('names every key granted, in list order, and only those', () => {
        const refusal = customRoleCarriageRefusal(
            on('AUDITOR', role('AUDITOR', { agent_skill_author: true, sso: true, view: true })),
            null,
        );
        expect(refusal).toEqual({ reason: CUSTOM_ROLE_ADMIN_KEYS_REFUSAL, keys: ['sso', 'agent_skill_author'] });
    });

    it('reads the EFFECTIVE grant: a legacy blob missing a key takes its base’s default for it', () => {
        // A blob saved before the agent keys existed, on an ADMIN base, grants
        // the agent keys ADMIN grants by default — as a request resolves it.
        const legacy: CustomRoleForCarriage = { baseRole: 'ADMIN', permissionsJson: { controls: { view: true } } };
        expect(customRoleCarriageOffence(on('READER', legacy)).adminKeys).toEqual([
            'sso',
            'agent_tool_exposure',
            'agent_policy_card',
            'agent_skill_review',
            'agent_skill_author',
            'scim',
            'compliance_dsar_manage',
            'agent_harness_ingest',
            'agent_external_tools',
        ]);
        // ...and on a READER base, it grants none.
        expect(customRoleCarriageOffence(on('READER', { baseRole: 'READER', permissionsJson: {} })).adminKeys).toEqual([]);
    });
});

describe('rule 2 — an ADMIN base', () => {
    it.each(NON_ADMIN_CARRIERS)('a custom role built on ADMIN on a %s membership is refused — even with every listed key off', (carrier) => {
        const off = Object.fromEntries(ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS.map((k) => [k, false]));
        expect(customRoleCarriageRefusal(on(carrier, role('ADMIN', off)), null)).toEqual({
            reason: CUSTOM_ROLE_ADMIN_BASE_REFUSAL,
            baseRole: 'ADMIN',
        });
    });

    it('is asked before the keys: an ADMIN-built role granting keys is refused for its base', () => {
        expect(customRoleCarriageRefusal(on('EDITOR', role('ADMIN')), null)?.reason).toBe(CUSTOM_ROLE_ADMIN_BASE_REFUSAL);
    });

    it('a legacy OWNER base is judged by its tier, as ADMIN is', () => {
        expect(customRoleCarriageOffence(on('EDITOR', { baseRole: 'OWNER', permissionsJson: {} })).adminBase).toBe('OWNER');
    });

    it('allowed on an ADMIN membership, and an EDITOR, AUDITOR or READER base is allowed on any', () => {
        expect(customRoleCarriageRefusal(on('ADMIN', role('ADMIN')), null)).toBeNull();
        for (const base of NON_ADMIN_CARRIERS) {
            for (const carrier of NON_ADMIN_CARRIERS) {
                expect(customRoleCarriageRefusal(on(carrier, role(base)), null)).toBeNull();
            }
        }
    });
});

describe('only what a change ADDS is refused — existing rows are not trapped', () => {
    const legacy = role('ADMIN', { agent_ownership: true }); // base + all ten keys

    it('clearing the custom role, or replacing it with one that offends less, passes', () => {
        expect(customRoleCarriageRefusal(on('EDITOR', null), on('EDITOR', legacy))).toBeNull();
        expect(customRoleCarriageRefusal(on('EDITOR', role('READER', { sso: true })), on('EDITOR', legacy))).toBeNull();
    });

    it('removing keys and lowering the base pass; keeping the offence passes (a rename)', () => {
        const narrowed = role('EDITOR', { sso: true });
        expect(customRoleCarriageRefusal(on('READER', narrowed), on('READER', legacy))).toBeNull();
        expect(customRoleCarriageRefusal(on('READER', legacy), on('READER', legacy))).toBeNull();
    });

    it('adding a key to a legacy role is refused for that key alone', () => {
        const before = role('READER', { sso: true });
        const after = role('READER', { sso: true, agent_policy_card: true });
        expect(customRoleCarriageRefusal(on('READER', after), on('READER', before))).toEqual({
            reason: CUSTOM_ROLE_ADMIN_KEYS_REFUSAL,
            keys: ['agent_policy_card'],
        });
    });

    it('raising the base to ADMIN is refused even when the keys were already there', () => {
        const before = role('EDITOR', Object.fromEntries(ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS.map((k) => [k, true])));
        expect(customRoleCarriageRefusal(on('EDITOR', role('ADMIN')), on('EDITOR', before))?.reason).toBe(
            CUSTOM_ROLE_ADMIN_BASE_REFUSAL,
        );
    });

    it('moving an ADMIN who carries one off ADMIN is refused; moving them back is allowed', () => {
        const adminBuilt = role('ADMIN');
        expect(customRoleCarriageRefusal(on('EDITOR', adminBuilt), on('ADMIN', adminBuilt))?.reason).toBe(
            CUSTOM_ROLE_ADMIN_BASE_REFUSAL,
        );
        expect(customRoleCarriageRefusal(on('ADMIN', adminBuilt), on('EDITOR', adminBuilt))).toBeNull();
    });
});

/**
 * A writer that moves a membership only among EDITOR, READER and AUDITOR (SCIM's
 * role attribute) cannot ADD an offence. That holds because the rule treats the
 * three alike — asked here over every subset of the listed keys on every base
 * a custom role may have.
 */
describe('the rule treats EDITOR, READER and AUDITOR alike', () => {
    it('the same offence on each, for every subset of the keys on every base', () => {
        const keys = ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS;
        for (const base of ['ADMIN', 'EDITOR', 'AUDITOR', 'READER']) {
            for (let mask = 0; mask < 1 << keys.length; mask += 1) {
                const r = role(base, Object.fromEntries(keys.map((k, i) => [k, (mask & (1 << i)) !== 0])));
                const [e, ...rest] = NON_ADMIN_CARRIERS.map((c) => customRoleCarriageOffence(on(c, r)));
                for (const o of rest) expect(o).toEqual(e);
                for (const from of NON_ADMIN_CARRIERS) {
                    for (const to of NON_ADMIN_CARRIERS) {
                        expect(customRoleCarriageRefusal(on(to, r), on(from, r))).toBeNull();
                    }
                }
            }
        }
    });

    it('and only ADMIN is exempt among the roles that may carry a custom role at all', () => {
        const exempt = TENANT_ROLES.filter(
            (r) => customRoleCarriageRefusal(on(r, role('ADMIN')), null) === null,
        );
        expect(exempt).toEqual(['ADMIN']);
    });
});

describe('the refusal as the API carries it', () => {
    it('details name the reason and the keys as permission keys, or the base, and a save’s count', () => {
        expect(
            customRoleCarriageDetails({ reason: CUSTOM_ROLE_ADMIN_KEYS_REFUSAL, keys: ['sso', 'agent_ownership'] }),
        ).toEqual({ reason: CUSTOM_ROLE_ADMIN_KEYS_REFUSAL, keys: ['admin.sso', 'admin.agent_ownership'] });
        expect(
            customRoleCarriageDetails({ reason: CUSTOM_ROLE_ADMIN_BASE_REFUSAL, baseRole: 'ADMIN' }, { blockingMemberships: 3 }),
        ).toEqual({ reason: CUSTOM_ROLE_ADMIN_BASE_REFUSAL, baseRole: 'ADMIN', blockingMemberships: 3 });
    });

    it('each message says only ADMIN may carry it, and the save message counts the members', () => {
        const keys = { reason: CUSTOM_ROLE_ADMIN_KEYS_REFUSAL, keys: ['agent_policy_card'] } as const;
        for (const asked of ['assign-custom-role', 'change-role', 'invite'] as const) {
            expect(customRoleCarriageMessage({ ...keys, keys: [...keys.keys] }, asked)).toMatch(
                /^A custom role granting admin\.agent_policy_card can only be carried by an ADMIN membership\./,
            );
        }
        expect(
            customRoleCarriageMessage({ reason: CUSTOM_ROLE_ADMIN_BASE_REFUSAL, baseRole: 'ADMIN' }, 'save-custom-role', 2),
        ).toBe(
            'A custom role built on ADMIN can only be carried by an ADMIN membership. 2 member(s) carrying this role ' +
                'hold another role. Change their role to ADMIN or give them another custom role first.',
        );
    });
});
