/**
 * The joiner entitlement map's WRITE path (#2839).
 *
 * What these assert, beyond "the queries run": the three constraints the
 * READER imposes on this writer, each of which is a decision recorded in the
 * schema or an owner decision, and each of which a plausible implementation
 * gets wrong.
 */
import {
    listDepartmentGroupRules,
    setDepartmentGroupRule,
    removeDepartmentGroupRule,
    setDefaultJoinerGroup,
} from '@/app-layer/usecases/identity-entitlement-map';

const mockDb = {
    identityDepartmentGroupRule: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
    },
    tenantSecuritySettings: { findUnique: jest.fn(), upsert: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
}));

const logged: Array<Record<string, unknown>> = [];
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async (_db: unknown, _ctx: unknown, payload: Record<string, unknown>) => {
        logged.push(payload);
    }),
}));

const CTX = { tenantId: 't-1', userId: 'u-7' } as never;

beforeEach(() => {
    jest.clearAllMocks();
    logged.length = 0;
    mockDb.identityDepartmentGroupRule.findUnique.mockResolvedValue(null);
    mockDb.identityDepartmentGroupRule.upsert.mockResolvedValue({
        department: 'Engineering',
        groupId: 'g-1',
        groupName: 'Engineering Staff',
        updatedAt: new Date('2026-09-25T00:00:00Z'),
    });
    mockDb.identityDepartmentGroupRule.count.mockResolvedValue(2);
    mockDb.tenantSecuritySettings.findUnique.mockResolvedValue(null);
});

describe('the department is stored EXACTLY as typed', () => {
    it('does not normalise case, spacing or punctuation', async () => {
        // The schema says the planner matches the HRIS value exactly, and that
        // "a rule that silently matched a department the operator did not type
        // is the same failure decision 5 guards against on the fallback side".
        // A writer that trimmed or lower-cased would make the map match things
        // the operator never configured.
        await setDepartmentGroupRule(CTX, { department: '  R&D / Platform  ', groupId: 'g-9' });
        const call = mockDb.identityDepartmentGroupRule.upsert.mock.calls[0][0];
        expect(call.create.department).toBe('  R&D / Platform  ');
        expect(call.where.tenantId_department.department).toBe('  R&D / Platform  ');
    });

    it('refuses a blank department — unfireable, not merely untidy', async () => {
        // NOT normalisation: no HRIS department is whitespace, so such a rule
        // can never match, and storing it produces a map that reads as
        // configured and matches nothing.
        await expect(setDepartmentGroupRule(CTX, { department: '   ', groupId: 'g-1' })).rejects.toThrow(
            /never fire|cannot be empty/i,
        );
        expect(mockDb.identityDepartmentGroupRule.upsert).not.toHaveBeenCalled();
    });

    it('refuses a rule with no group', async () => {
        await expect(
            setDepartmentGroupRule(CTX, { department: 'Engineering', groupId: '  ' }),
        ).rejects.toThrow(/Group is required/i);
        expect(mockDb.identityDepartmentGroupRule.upsert).not.toHaveBeenCalled();
    });
});

describe('editing a department is an upsert, not a delete-then-create', () => {
    it('replaces the group in place', async () => {
        // Two rules for one department is a contradiction the schema forbids
        // with @@unique. Making an operator delete first would open a window
        // where the department falls through to the default group without
        // anybody asking for it.
        mockDb.identityDepartmentGroupRule.findUnique.mockResolvedValue({ groupId: 'g-old' });
        await setDepartmentGroupRule(CTX, { department: 'Engineering', groupId: 'g-new' });
        const call = mockDb.identityDepartmentGroupRule.upsert.mock.calls[0][0];
        expect(call.update).toMatchObject({ groupId: 'g-new' });
        expect(mockDb.identityDepartmentGroupRule.delete).not.toHaveBeenCalled();
    });

    it('records the previous group in the audit trail', async () => {
        mockDb.identityDepartmentGroupRule.findUnique.mockResolvedValue({ groupId: 'g-old' });
        await setDepartmentGroupRule(CTX, { department: 'Engineering', groupId: 'g-new' });
        expect(logged[0]).toMatchObject({ action: 'IDENTITY_ENTITLEMENT_RULE_SET' });
        expect(logged[0].detailsJson).toMatchObject({
            category: 'access',
            previousGroupId: 'g-old',
            groupId: 'g-new',
        });
    });

    it("audits as 'access', not 'configuration'", async () => {
        // The audience is an access-review reader: this decides what a future
        // joiner is granted. `setIdentityWriteMode` classifies its own writes
        // the same way, for the same reason.
        await setDepartmentGroupRule(CTX, { department: 'Engineering', groupId: 'g-1' });
        expect((logged[0].detailsJson as { category: string }).category).toBe('access');
    });
});

describe('removing the LAST rule restores the refusal, and says so', () => {
    it('names the consequence in the audit line', async () => {
        // The reader turns zero rows into `null`, so deleting the last rule
        // brings back NO_DEPARTMENT_MAP for the whole tenant. That effect
        // should be readable at the moment it happens, not inferred from a
        // joiner report days later.
        mockDb.identityDepartmentGroupRule.findUnique.mockResolvedValue({ groupId: 'g-1' });
        mockDb.identityDepartmentGroupRule.count.mockResolvedValue(0);
        await removeDepartmentGroupRule(CTX, 'Engineering');
        expect(logged[0].details as string).toMatch(/LAST rule/);
        expect(logged[0].details as string).toMatch(/NO_DEPARTMENT_MAP/);
    });

    it('does not say that when other rules remain', async () => {
        // The positive control: a message that always warned would be ignored.
        mockDb.identityDepartmentGroupRule.findUnique.mockResolvedValue({ groupId: 'g-1' });
        mockDb.identityDepartmentGroupRule.count.mockResolvedValue(3);
        await removeDepartmentGroupRule(CTX, 'Engineering');
        expect(logged[0].details as string).not.toMatch(/LAST rule/);
    });

    it('refuses to remove a rule that is not configured', async () => {
        mockDb.identityDepartmentGroupRule.findUnique.mockResolvedValue(null);
        await expect(removeDepartmentGroupRule(CTX, 'Nope')).rejects.toThrow(/No joiner entitlement rule/i);
        expect(mockDb.identityDepartmentGroupRule.delete).not.toHaveBeenCalled();
    });
});

describe('the fallback takes BOTH id and name — owner decision 5', () => {
    it('refuses an id without a name', async () => {
        // The name is what lets a plan that fell back be read as "Contractors,
        // deliberately" rather than "Enginering, misspelt", and it is STORED
        // rather than resolved because a directory lookup is unavailable
        // exactly when the directory call failed.
        await expect(
            setDefaultJoinerGroup(CTX, { groupId: 'g-1', groupName: '   ' }),
        ).rejects.toThrow(/display name/i);
        expect(mockDb.tenantSecuritySettings.upsert).not.toHaveBeenCalled();
    });

    it('stores both when both are given', async () => {
        await setDefaultJoinerGroup(CTX, { groupId: 'g-1', groupName: 'Contractors' });
        const call = mockDb.tenantSecuritySettings.upsert.mock.calls[0][0];
        expect(call.update).toMatchObject({
            identityDefaultGroupId: 'g-1',
            identityDefaultGroupName: 'Contractors',
        });
    });

    it('clears BOTH columns, so a half-cleared fallback cannot exist', async () => {
        // `Both null = no fallback configured` is what the planner reads. A
        // clear that left the name behind would leave a row claiming a
        // fallback that resolves to nothing.
        await setDefaultJoinerGroup(CTX, null);
        const call = mockDb.tenantSecuritySettings.upsert.mock.calls[0][0];
        expect(call.update).toEqual({
            identityDefaultGroupId: null,
            identityDefaultGroupName: null,
        });
        expect(logged[0].details as string).toMatch(/NO_DEFAULT_GROUP/);
    });
});

describe('listing', () => {
    it('returns rules ordered by department for a stable admin surface', async () => {
        mockDb.identityDepartmentGroupRule.findMany.mockResolvedValue([
            { department: 'Engineering', groupId: 'g-1', groupName: null, updatedAt: new Date(0) },
        ]);
        const rules = await listDepartmentGroupRules(CTX);
        expect(rules).toHaveLength(1);
        expect(mockDb.identityDepartmentGroupRule.findMany.mock.calls[0][0].orderBy).toEqual({
            department: 'asc',
        });
    });
});
