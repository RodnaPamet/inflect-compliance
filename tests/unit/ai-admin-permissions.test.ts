/**
 * What the built-in AI_ADMIN role can do (#3699) — every key, classified.
 *
 * AI_ADMIN runs the agent register and can own and receive agents, and holds
 * NONE of the tenant-wide admin keys. The table below names the expected value
 * of every key in `PERMISSION_SCHEMA`, and the first test fails if the schema
 * and the table ever disagree about WHICH keys exist — so a key added to the
 * `PermissionSet` later fails here until somebody decides whether this role
 * holds it. That is the point: a new tenant-wide admin key must not reach
 * AI_ADMIN by a default nobody looked at, and a new agent key must not be
 * silently withheld from the role that administers agents.
 */
import { computePermissions } from '@/lib/tenant-context';
import {
    AGENT_ADMIN_KEYS,
    PERMISSION_SCHEMA,
    getPermissionsForRole,
    parsePermissionsJson,
    permissionsExceeding,
    permissionsForMembership,
    validatePermissionsJson,
    type PermissionSet,
} from '@/lib/permissions';
import { scopesToPermissions } from '@/lib/auth/api-key-auth';
import { TENANT_ROLES } from '@/lib/roles';
import { enumOrderReport } from '../helpers/prisma-enum-order';

/**
 * The expected AI_ADMIN set, written out key by key rather than derived from
 * READER's: a derivation would agree with whatever READER becomes.
 */
const EXPECTED_AI_ADMIN: { [D in keyof PermissionSet]: PermissionSet[D] } = {
    controls: { view: true, create: false, edit: false },
    evidence: { view: true, upload: false, edit: false, download: true },
    policies: { view: true, create: false, edit: false, approve: false },
    tasks: { view: true, create: false, edit: false, assign: false },
    risks: { view: true, create: false, edit: false },
    assets: { view: true, create: false, edit: false },
    vendors: { view: true, create: false, edit: false },
    tests: { view: true, create: false, execute: false },
    incidents: { view: true, manage: false },
    personnel: { view: true, manage: false },
    // `decide` is READER's too: the usecase narrows it to the campaign's
    // assigned reviewer, so an AI admin decides only a review assigned to them.
    access_reviews: { view: true, create: false, decide: true, close: false },
    identity_reconciliation: { view: true, confirm: false },
    continuity: { edit: false },
    processes: { edit: false },
    frameworks: { view: true, install: false },
    audits: { view: true, manage: false, freeze: false, share: false },
    reports: { view: true, export: false, schedule_external: false },
    admin: {
        // ── tenant-wide: NONE ──
        view: false,
        manage: false,
        members: false,
        sso: false,
        scim: false,
        tenant_lifecycle: false,
        owner_management: false,
        compliance_dsar_view: false,
        compliance_dsar_manage: false,
        // ── agent keys: ALL ──
        agent_registry: true,
        agent_registry_view: true,
        agent_tool_exposure: true,
        agent_policy_card: true,
        agent_kill_switch: true,
        agent_external_tools: true,
        agent_harness_ingest: true,
        agent_ownership: true,
    },
};

function flatten(set: Record<string, Record<string, boolean>>): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [domain, actions] of Object.entries(set)) {
        for (const [action, value] of Object.entries(actions)) out[`${domain}.${action}`] = value;
    }
    return out;
}

const schemaKeys = (): string[] =>
    Object.entries(PERMISSION_SCHEMA)
        .flatMap(([domain, actions]) => actions.map((a) => `${domain}.${a}`))
        .sort();

describe('AI_ADMIN — every PermissionSet key, classified', () => {
    it('the expected table names exactly the keys PERMISSION_SCHEMA has (a new key fails here until classified)', () => {
        expect(Object.keys(flatten(EXPECTED_AI_ADMIN)).sort()).toEqual(schemaKeys());
    });

    it('getPermissionsForRole("AI_ADMIN") is the table, key for key', () => {
        expect(flatten(getPermissionsForRole('AI_ADMIN') as never)).toEqual(
            flatten(EXPECTED_AI_ADMIN as never),
        );
    });

    it('holds every agent key, and no admin key that is not one', () => {
        const admin = getPermissionsForRole('AI_ADMIN').admin as Record<string, boolean>;
        const held = Object.keys(admin).filter((k) => admin[k]).sort();
        expect(held).toEqual([...AGENT_ADMIN_KEYS].sort());
    });

    it('AGENT_ADMIN_KEYS names only real admin keys, and every agent_* key in the schema', () => {
        for (const k of AGENT_ADMIN_KEYS) expect(PERMISSION_SCHEMA.admin).toContain(k);
        const agentNamed = PERMISSION_SCHEMA.admin.filter((k) => k.startsWith('agent_')).sort();
        expect(agentNamed).toEqual([...AGENT_ADMIN_KEYS].sort());
    });

    it('outside the admin domain it is exactly a READER', () => {
        const ai = getPermissionsForRole('AI_ADMIN');
        const reader = getPermissionsForRole('READER');
        const { admin: _a, ...aiRest } = ai;
        const { admin: _r, ...readerRest } = reader;
        expect(aiRest).toEqual(readerRest);
    });

    it("sits on READER's rung of the coarse ladder — no canWrite, canAdmin, canAudit or canExport", () => {
        expect(computePermissions('AI_ADMIN')).toEqual({
            canRead: true,
            canWrite: false,
            canAdmin: false,
            canAudit: false,
            canExport: false,
        });
        expect(computePermissions('AI_ADMIN')).toEqual(computePermissions('READER'));
    });
});

describe('admin.agent_ownership — who holds it by default', () => {
    it.each([
        ['OWNER', true],
        ['ADMIN', false],
        ['EDITOR', false],
        ['READER', false],
        ['AUDITOR', false],
        ['AI_ADMIN', true],
    ] as const)('%s → %s', (role, expected) => {
        expect(getPermissionsForRole(role).admin.agent_ownership).toBe(expected);
    });

    it('the table above covers every built-in role', () => {
        // TENANT_ROLES is compile-time exhaustive over `Role`.
        expect([...TENANT_ROLES].sort()).toEqual(
            ['ADMIN', 'AI_ADMIN', 'AUDITOR', 'EDITOR', 'OWNER', 'READER'].sort(),
        );
    });

    it('no bearer token carries it — not `*`, not `admin:*`', () => {
        expect(scopesToPermissions(['*']).admin.agent_ownership).toBe(false);
        expect(scopesToPermissions(['admin:*']).admin.agent_ownership).toBe(false);
    });
});

describe('a custom role can express admin.agent_ownership', () => {
    const blob = (overrides: Partial<PermissionSet['admin']>) => {
        const base = getPermissionsForRole('ADMIN');
        return { ...base, admin: { ...base.admin, ...overrides } };
    };

    it('a blob carrying it validates, and parses over an ADMIN base with it on', () => {
        const json = blob({ agent_ownership: true });
        expect(validatePermissionsJson(json)).toEqual([]);
        expect(parsePermissionsJson(json, 'ADMIN').admin.agent_ownership).toBe(true);
        expect(
            permissionsForMembership({
                role: 'ADMIN',
                customRole: { permissionsJson: json, baseRole: 'ADMIN' },
            }).admin.agent_ownership,
        ).toBe(true);
    });

    it('an ADMIN cannot grant it (they do not hold it); an OWNER can', () => {
        const granted = parsePermissionsJson(blob({ agent_ownership: true }), 'ADMIN');
        expect(permissionsExceeding(granted, getPermissionsForRole('ADMIN'))).toEqual([
            'admin.agent_ownership',
        ]);
        expect(permissionsExceeding(granted, getPermissionsForRole('OWNER'))).toEqual([]);
    });

    it('an AI_ADMIN could not mint an ADMIN-shaped role: everything tenant-wide exceeds it', () => {
        const granted = parsePermissionsJson(blob({ agent_ownership: true }), 'ADMIN');
        const exceeded = permissionsExceeding(granted, getPermissionsForRole('AI_ADMIN'));
        expect(exceeded).toEqual(expect.arrayContaining(['admin.manage', 'admin.members', 'admin.view']));
        expect(exceeded).not.toContain('admin.agent_ownership');
    });
});

describe('AI_ADMIN sorts LAST — never as more senior than ADMIN', () => {
    // Three job actor pickers order `TenantMembership.role` ascending to find
    // the most senior member (`resolveEmissionActor`, `resolveDrillActor`,
    // the posture-summary cron). Postgres sorts an enum by ordinal, so the
    // value's position is the seniority those pickers see.
    it('is the last Role member in prisma/schema AND in a freshly-migrated database', () => {
        const r = enumOrderReport();
        const declared = r.declared.find((e) => e.prismaName === 'Role');
        expect(declared?.members).toEqual(['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR', 'AI_ADMIN']);
        expect(r.reconstructed.get(declared?.physicalName ?? 'Role')).toEqual(declared?.members);
    });

    it('TENANT_ROLES is in that same declaration order', () => {
        expect([...TENANT_ROLES]).toEqual(['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR', 'AI_ADMIN']);
    });
});
