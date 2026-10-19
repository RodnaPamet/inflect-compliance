/**
 * THE WORKPAPER VIEW KEY (#3749) — `audits.workpaper_view`, and the period
 * read it opens (`list_audit_workpapers`).
 *
 * Every claim below is asserted against the real function that decides it:
 *
 *   1. who holds it: exactly the built-in roles that hold `audits.manage`;
 *   2. a stored custom role saved before the key existed takes it from its
 *      OWN `audits.manage`, never from its base role, and an explicit value in
 *      the blob wins;
 *   3. the scope: `audits:workpaper_view` grants it and nothing else, and no
 *      other scope — `*`, `audits:*`, `audits:read`, `audits:write` — grants
 *      it, so every key already issued resolves exactly as it did;
 *   4. the period read admits either key, refuses a principal with neither
 *      BEFORE the database, and reads one past its bound so a capped read says
 *      so;
 *   5. the view re-validates the stored JSON and carries no person.
 */
const DB_REACHED = 'test: a refused read reached the database';

let mockRows: Array<{ readonly periodLabel: string }> = [];
let mockRefuseDb = false;
const mockFindMany = jest.fn(async (args: { take: number; where: Record<string, unknown> }) =>
    mockRows.filter((r) => r.periodLabel === args.where.periodLabel).slice(0, args.take),
);
jest.mock('@/lib/db-context', () => ({
    ...jest.requireActual('@/lib/db-context'),
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => {
        if (mockRefuseDb) throw new Error(DB_REACHED);
        return fn({ auditWorkpaper: { findMany: mockFindMany } });
    }),
}));

import {
    getPermissionsForRole,
    parsePermissionsJson,
    permissionsExceeding,
    validatePermissionsJson,
    type PermissionSet,
} from '@/lib/permissions';
import {
    VALID_SCOPES,
    WILDCARD_EXCLUDED_ACTIONS,
    enforceApiKeyScope,
    scopesToPermissions,
} from '@/lib/auth/api-key-auth';
import { listAuditWorkpapersForPeriod } from '@/app-layer/usecases/audit-workpaper';
import {
    MAX_EXCEPTIONS_SHOWN,
    MAX_WORKPAPERS_PER_PERIOD_READ,
    toWorkpaperView,
    type StoredWorkpaperRow,
} from '@/lib/agentic/audit-workpaper-view';
import { listAuditWorkpapersTool } from '@/lib/mcp/tools/audit-tools';
import { ForbiddenError, ValidationError } from '@/lib/errors/types';
import { TENANT_ROLES } from '@/lib/roles';
import type { RequestContext } from '@/app-layer/types';

import { makeRequestContext } from '../helpers/make-context';

const KEY = 'audits.workpaper_view';
const SCOPE = 'audits:workpaper_view';

/** Every flag a set holds, as `domain.action`. */
function flagsOf(set: PermissionSet): string[] {
    return Object.entries(set as unknown as Record<string, Record<string, boolean>>)
        .flatMap(([domain, actions]) => Object.entries(actions).filter(([, v]) => v).map(([a]) => `${domain}.${a}`))
        .sort();
}

// ─── 1. who holds it ────────────────────────────────────────────────────────

describe('audits.workpaper_view — who holds it by default', () => {
    it.each([
        ['OWNER', true],
        ['ADMIN', true],
        ['EDITOR', false],
        ['READER', false],
        ['AUDITOR', false],
        ['AI_ADMIN', false],
    ] as const)('%s → %s', (role, expected) => {
        expect(getPermissionsForRole(role).audits.workpaper_view).toBe(expected);
    });

    it('is held by exactly the built-in roles that hold audits.manage', () => {
        for (const role of TENANT_ROLES) {
            const audits = getPermissionsForRole(role).audits;
            expect({ role, view: audits.workpaper_view }).toEqual({ role, view: audits.manage });
        }
    });
});

// ─── 2. a stored custom role ────────────────────────────────────────────────

describe('a custom role and audits.workpaper_view', () => {
    /** A blob as one saved before the key existed: `audits` without it. */
    const legacyBlob = (base: 'ADMIN' | 'EDITOR', manage: boolean) => {
        const set = getPermissionsForRole(base);
        const { workpaper_view: _dropped, ...audits } = set.audits;
        return { ...set, audits: { ...audits, manage } };
    };

    it('a blob from before the key takes it from its OWN audits.manage, not the base role', () => {
        // ADMIN's default is `true`: a role that switched `manage` off must not
        // gain the read from its base.
        expect(parsePermissionsJson(legacyBlob('ADMIN', false), 'ADMIN').audits.workpaper_view).toBe(false);
        expect(parsePermissionsJson(legacyBlob('ADMIN', true), 'ADMIN').audits.workpaper_view).toBe(true);
        // EDITOR's default is `false`: a role that switched `manage` on reads
        // workpapers, as it could before through `manage`.
        expect(parsePermissionsJson(legacyBlob('EDITOR', true), 'EDITOR').audits.workpaper_view).toBe(true);
        expect(parsePermissionsJson(legacyBlob('EDITOR', false), 'EDITOR').audits.workpaper_view).toBe(false);
    });

    it('an explicit value in the blob wins over the derivation', () => {
        const admin = getPermissionsForRole('ADMIN');
        const viewOnly = { ...admin, audits: { ...admin.audits, manage: false, workpaper_view: true } };
        expect(validatePermissionsJson(viewOnly)).toEqual([]);
        expect(parsePermissionsJson(viewOnly, 'ADMIN').audits).toMatchObject({ manage: false, workpaper_view: true });
        const manageOnly = { ...admin, audits: { ...admin.audits, manage: true, workpaper_view: false } };
        expect(parsePermissionsJson(manageOnly, 'ADMIN').audits).toMatchObject({ manage: true, workpaper_view: false });
    });

    it('a blob with no audits domain at all keeps the base role default', () => {
        const { audits: _dropped, ...rest } = getPermissionsForRole('EDITOR');
        expect(parsePermissionsJson(rest, 'EDITOR').audits.workpaper_view).toBe(false);
    });

    it('an EDITOR cannot grant it (they do not hold it); an ADMIN can', () => {
        const editor = getPermissionsForRole('EDITOR');
        const granted = parsePermissionsJson(
            { ...editor, audits: { ...editor.audits, workpaper_view: true } },
            'EDITOR',
        );
        expect(permissionsExceeding(granted, editor)).toEqual([KEY]);
        expect(permissionsExceeding(granted, getPermissionsForRole('ADMIN'))).toEqual([]);
    });
});

// ─── 3. the scope ───────────────────────────────────────────────────────────

describe('audits:workpaper_view — the one scope that carries the key', () => {
    it('is a valid scope, and one only its name grants', () => {
        expect(VALID_SCOPES).toContain(SCOPE);
        expect(WILDCARD_EXCLUDED_ACTIONS.audits).toEqual(['workpaper_view']);
    });

    it('grants the view key and nothing else', () => {
        expect(flagsOf(scopesToPermissions([SCOPE]))).toEqual([KEY]);
    });

    it.each([['*'], ['audits:*'], ['audits:read'], ['audits:write'], ['admin:*'], ['mcp:read']])(
        '%s does not carry it',
        (scope) => {
            expect(scopesToPermissions([scope]).audits.workpaper_view).toBe(false);
        },
    );

    it('the wildcards still carry what they did: `*` and `audits:*` manage audits', () => {
        expect(scopesToPermissions(['*']).audits.manage).toBe(true);
        expect(scopesToPermissions(['audits:*']).audits).toMatchObject({ view: true, manage: true, freeze: true, share: true });
    });

    it('the credential check agrees: only the named scope satisfies the named group', () => {
        const keyCtx = (scopes: string[]) => makeRequestContext('OWNER', { apiKeyId: 'key-1', apiKeyScopes: scopes });
        for (const scopes of [['*'], ['audits:*'], ['audits:read'], ['audits:write']]) {
            expect(() => enforceApiKeyScope(keyCtx(scopes), 'audits', 'workpaper_view')).toThrow(ForbiddenError);
        }
        expect(() => enforceApiKeyScope(keyCtx([SCOPE]), 'audits', 'workpaper_view')).not.toThrow();
        // …and the named scope satisfies no other audits action.
        expect(() => enforceApiKeyScope(keyCtx([SCOPE]), 'audits', 'read')).toThrow(ForbiddenError);
        expect(() => enforceApiKeyScope(keyCtx([SCOPE]), 'audits', 'write')).toThrow(ForbiddenError);
    });

    it('the tool names the view key and the named group, never manage', () => {
        expect(listAuditWorkpapersTool.resourceScope).toEqual({ resource: 'audits', action: 'workpaper_view' });
        expect(listAuditWorkpapersTool.authorize).toMatchObject({ keys: [KEY], basis: 'effective' });
    });
});

// ─── 4. the period read ─────────────────────────────────────────────────────

function storedRow(i: number, overrides: Partial<StoredWorkpaperRow> = {}): StoredWorkpaperRow {
    return {
        id: `wp_${i}`,
        procedureId: 'iam.leaver_timeliness',
        catalogueVersion: 1,
        periodLabel: '2026-09',
        populationDefinition: 'Employee rows with status TERMINATED and endDate inside the period',
        populationCount: 4,
        populationDigest: 'a'.repeat(64),
        sampleSize: 2,
        parametersJson: { leaverWindowHours: 24 },
        attributesTested: ['L1', 'L2'],
        itemOutcomesJson: [
            { unitId: 'emp_1', outcome: 'PASS', code: null },
            { unitId: 'emp_2', outcome: 'EXCEPTION', code: 'ACCESS_NOT_REMOVED' },
        ],
        exceptionsJson: [{ unitId: 'emp_2', code: 'ACCESS_NOT_REMOVED', proposalId: 'prop_1' }],
        exceptionCount: 1,
        conclusion: 'FAIL',
        conclusionBasis: 'EXCEPTIONS_FOUND',
        auditorAgentId: 'agent_auditor',
        reviewedAt: null,
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
        ...overrides,
    };
}

const ctxWith = (audits: Partial<PermissionSet['audits']>): RequestContext => {
    const reader = getPermissionsForRole('READER');
    return makeRequestContext('READER', {
        tenantId: 'tenant-1',
        userId: 'user-1',
        appPermissions: { ...reader, audits: { ...reader.audits, ...audits } },
    });
};

describe('listAuditWorkpapersForPeriod', () => {
    beforeEach(() => {
        mockRows = [];
        mockRefuseDb = false;
        mockFindMany.mockClear();
    });

    it.each([
        ['audits.workpaper_view alone', { workpaper_view: true }],
        ['audits.manage alone', { manage: true }],
    ])('admits %s', async (_label, audits) => {
        mockRows = [storedRow(1)];
        const view = await listAuditWorkpapersForPeriod(ctxWith(audits), '2026-09');
        expect(view.workpapers.map((w) => w.workpaperId)).toEqual(['wp_1']);
    });

    it.each([
        ['audits.view, every role’s', 'READER'],
        ['an EDITOR', 'EDITOR'],
        ['an AUDITOR, who holds share but not the view key', 'AUDITOR'],
        ['an AI_ADMIN', 'AI_ADMIN'],
    ] as const)('refuses %s before the database', async (_label, role) => {
        mockRefuseDb = true;
        await expect(
            listAuditWorkpapersForPeriod(makeRequestContext(role, { tenantId: 'tenant-1' }), '2026-09'),
        ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('refuses a malformed period and an out-of-range limit before the database', async () => {
        mockRefuseDb = true;
        const ctx = ctxWith({ workpaper_view: true });
        for (const period of ['2026-13', '2026-Q5', '26-09', '2026-09 ']) {
            await expect(listAuditWorkpapersForPeriod(ctx, period)).rejects.toBeInstanceOf(ValidationError);
        }
        for (const limit of [0, MAX_WORKPAPERS_PER_PERIOD_READ + 1, 1.5]) {
            await expect(listAuditWorkpapersForPeriod(ctx, '2026-09', limit)).rejects.toBeInstanceOf(ValidationError);
        }
    });

    it('reads one past the bound, so "exactly N" and "the first N of more" are told apart', async () => {
        const ctx = ctxWith({ workpaper_view: true });
        mockRows = [1, 2, 3].map((i) => storedRow(i));

        const capped = await listAuditWorkpapersForPeriod(ctx, '2026-09', 2);
        expect(mockFindMany.mock.calls[0][0]).toMatchObject({ take: 3, where: { tenantId: 'tenant-1', periodLabel: '2026-09' } });
        expect(capped).toMatchObject({ periodLabel: '2026-09', truncated: true });
        expect(capped.workpapers.map((w) => w.workpaperId)).toEqual(['wp_1', 'wp_2']);

        const exact = await listAuditWorkpapersForPeriod(ctx, '2026-09', 3);
        expect(exact.truncated).toBe(false);
        expect(exact.workpapers).toHaveLength(3);

        const byDefault = await listAuditWorkpapersForPeriod(ctx, '2026-09');
        expect(mockFindMany.mock.calls[2][0].take).toBe(MAX_WORKPAPERS_PER_PERIOD_READ + 1);
        expect(byDefault.truncated).toBe(false);
    });

    it('a period with no workpapers is an empty list, not truncated', async () => {
        mockRows = [storedRow(1)];
        await expect(listAuditWorkpapersForPeriod(ctxWith({ workpaper_view: true }), '2026-Q3')).resolves.toEqual({
            periodLabel: '2026-Q3',
            workpapers: [],
            truncated: false,
        });
    });

    it('the tool passes its arguments through, and its schema refuses what the usecase would', async () => {
        mockRows = [1, 2].map((i) => storedRow(i));
        const args = listAuditWorkpapersTool.argsSchema.parse({ periodLabel: '2026-09', limit: 1 });
        const view = await listAuditWorkpapersTool.run(ctxWith({ workpaper_view: true }), args);
        expect(view).toMatchObject({ truncated: true, workpapers: [{ workpaperId: 'wp_1' }] });
        for (const bad of [
            { periodLabel: '2026-13' },
            { periodLabel: '2026-09', limit: 0 },
            { periodLabel: '2026-09', limit: MAX_WORKPAPERS_PER_PERIOD_READ + 1 },
            { periodLabel: '2026-09', extra: true },
        ]) {
            expect(listAuditWorkpapersTool.argsSchema.safeParse(bad).success).toBe(false);
        }
    });
});

// ─── 5. the view ────────────────────────────────────────────────────────────

describe('toWorkpaperView', () => {
    it('reports outcomes and exceptions as counts, codes most frequent first', () => {
        const view = toWorkpaperView(
            storedRow(1, {
                itemOutcomesJson: [
                    { unitId: 'emp_1', outcome: 'PASS', code: null },
                    { unitId: 'emp_2', outcome: 'EXCEPTION', code: 'ACCESS_NOT_REMOVED' },
                    { unitId: 'emp_3', outcome: 'EXCEPTION', code: 'LATE_REMOVAL' },
                    { unitId: 'emp_4', outcome: 'UNTESTABLE', code: 'NO_EVIDENCE' },
                ],
                exceptionsJson: [
                    { unitId: 'emp_2', code: 'ACCESS_NOT_REMOVED' },
                    { unitId: 'emp_3', code: 'LATE_REMOVAL' },
                    { unitId: 'emp_5', code: 'LATE_REMOVAL' },
                ],
                exceptionCount: 3,
            }),
        );
        expect(view.outcomes).toEqual({ PASS: 1, EXCEPTION: 2, UNTESTABLE: 1 });
        expect(view.exceptionCodes).toEqual([
            { code: 'LATE_REMOVAL', count: 2 },
            { code: 'ACCESS_NOT_REMOVED', count: 1 },
        ]);
        expect(view.exceptions).toEqual([
            { unitId: 'emp_2', code: 'ACCESS_NOT_REMOVED' },
            { unitId: 'emp_3', code: 'LATE_REMOVAL' },
            { unitId: 'emp_5', code: 'LATE_REMOVAL' },
        ]);
        expect(view.unreadable).toEqual([]);
    });

    it(`shows the first ${MAX_EXCEPTIONS_SHOWN} exceptions in full and counts every one`, () => {
        const many = Array.from({ length: MAX_EXCEPTIONS_SHOWN + 7 }, (_, i) => ({ unitId: `emp_${i}`, code: 'LATE_REMOVAL' }));
        const view = toWorkpaperView(storedRow(1, { exceptionsJson: many, exceptionCount: many.length }));
        expect(view.exceptions).toHaveLength(MAX_EXCEPTIONS_SHOWN);
        expect(view.exceptions?.[0]).toEqual({ unitId: 'emp_0', code: 'LATE_REMOVAL' });
        expect(view.exceptionCodes).toEqual([{ code: 'LATE_REMOVAL', count: many.length }]);
        expect(view.exceptionCount).toBe(many.length);
    });

    it('a stored value that no longer re-validates reads null and is named, never as "no exceptions"', () => {
        const view = toWorkpaperView(
            storedRow(1, {
                exceptionsJson: [{ unitId: 'emp_2', code: 'not a code' }],
                itemOutcomesJson: 'not an array',
                parametersJson: { 'bad key!': 1 },
            }),
        );
        expect(view.exceptions).toBeNull();
        expect(view.exceptionCodes).toBeNull();
        expect(view.outcomes).toBeNull();
        expect(view.parameters).toBeNull();
        expect([...view.unreadable].sort()).toEqual(['exceptionCodes', 'exceptions', 'outcomes', 'parameters'].sort());
        // The count stays, from its own column, so an unreadable list still
        // says how many exceptions there were.
        expect(view.exceptionCount).toBe(1);
    });

    it('absent parameters are null and not unreadable', () => {
        const view = toWorkpaperView(storedRow(1, { parametersJson: null }));
        expect(view.parameters).toBeNull();
        expect(view.unreadable).toEqual([]);
    });

    it('carries no person: the review stamp is a boolean, and no proposal id crosses', () => {
        const reviewed = toWorkpaperView(
            Object.assign(storedRow(1, { reviewedAt: new Date() }), { reviewedByUserId: 'user_reviewer_marker' }),
        );
        expect(reviewed.reviewed).toBe(true);
        const text = JSON.stringify(reviewed);
        expect(text).not.toContain('user_reviewer_marker');
        expect(text).not.toContain('prop_1');
        expect(Object.keys(reviewed)).not.toContain('reviewedByUserId');
        expect(toWorkpaperView(storedRow(2)).reviewed).toBe(false);
    });
});
