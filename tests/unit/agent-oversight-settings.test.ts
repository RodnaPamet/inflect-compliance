/**
 * The agent oversight settings (round 15: #4895, #4900, #4896–#4898).
 *
 * What these hold:
 *   - the defaults the code reads for a tenant with no row equal the column
 *     defaults the schema writes, so "no row" and "a fresh row" agree;
 *   - the ONE read rule for the three assurance surfaces: the register key
 *     reads all three, the inventory view key reads one only while its switch
 *     is on, and nobody else reads any;
 *   - the settings are an OWNER's, in a person's own session.
 */
import { readFileSync } from 'fs';

const mockFindUnique = jest.fn();
const mockUpsert = jest.fn();
const mockLogEvent = jest.fn();
const mockAppend = jest.fn(async (_entry: unknown) => undefined);

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ tenantSecuritySettings: { findUnique: mockFindUnique, upsert: mockUpsert } }),
    ),
}));
jest.mock('@/lib/audit', () => {
    const { strictMock } = jest.requireActual('../helpers/strict-mock');
    return strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntry: (entry: unknown) => mockAppend(entry),
    });
});
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }));
jest.mock('@/lib/observability/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));

import {
    AGENT_OVERSIGHT_COLUMN,
    AGENT_OVERSIGHT_DEFAULTS,
    AGENT_OVERSIGHT_KEYS,
    assertMayReadOversightSurface,
    mayReadOversightSurfaceWith,
    oversightReadsFor,
    oversightSettingsFrom,
    setAgentOversightSettings,
    type AgentOversightSettings,
} from '@/app-layer/usecases/agent-oversight-settings';
import { getPermissionsForRole } from '@/lib/permissions';
import type { Role } from '@prisma/client';

function ctxFor(role: Role, extra: Record<string, unknown> = {}) {
    return {
        requestId: 'req-1',
        userId: `${role.toLowerCase()}-1`,
        tenantId: 'tenant-A',
        role,
        appPermissions: getPermissionsForRole(role),
        ...extra,
    } as never;
}

const ALL_ON: AgentOversightSettings = {
    composeNeedsSecondApprover: true,
    exactParameterEditNeedsSecondApprover: true,
    auditorReadsDecisionLog: true,
    auditorReadsReceipts: true,
    auditorReadsQuarantine: true,
};

beforeEach(() => {
    mockFindUnique.mockReset();
    mockUpsert.mockReset();
    mockLogEvent.mockReset();
    mockAppend.mockClear();
});

describe('defaults', () => {
    it('equal the column defaults in the schema', () => {
        const schema = readFileSync('prisma/schema/auth.prisma', 'utf8');
        for (const key of AGENT_OVERSIGHT_KEYS) {
            const column = AGENT_OVERSIGHT_COLUMN[key];
            const line = schema.split('\n').find((l) => new RegExp(`^\\s*${column}\\s+Boolean\\b`).test(l));
            expect({ key, line: line?.trim() }).toEqual({
                key,
                line: expect.stringContaining(`@default(${AGENT_OVERSIGHT_DEFAULTS[key]})`),
            });
        }
    });

    it('only the composed-request rule is on by default', () => {
        expect(AGENT_OVERSIGHT_DEFAULTS).toEqual({
            composeNeedsSecondApprover: true,
            exactParameterEditNeedsSecondApprover: false,
            auditorReadsDecisionLog: false,
            auditorReadsReceipts: false,
            auditorReadsQuarantine: false,
        });
    });

    it('a tenant with no row reads the defaults, and a stored value wins', () => {
        expect(oversightSettingsFrom(null)).toEqual(AGENT_OVERSIGHT_DEFAULTS);
        expect(oversightSettingsFrom({ auditorReadsAgentReceipts: true }).auditorReadsReceipts).toBe(true);
        expect(oversightSettingsFrom({ agentComposeNeedsSecondApprover: false }).composeNeedsSecondApprover).toBe(false);
    });
});

describe('the read rule for the three surfaces', () => {
    const surfaces = ['decisions', 'receipts', 'quarantine'] as const;

    it('the register key reads all three, whatever the switches say', () => {
        const admin = getPermissionsForRole('ADMIN').admin;
        for (const s of surfaces) expect(mayReadOversightSurfaceWith(admin, AGENT_OVERSIGHT_DEFAULTS, s)).toBe(true);
    });

    it('the view key alone reads a surface only while its switch is on', () => {
        const auditor = getPermissionsForRole('AUDITOR').admin;
        for (const s of surfaces) {
            expect(mayReadOversightSurfaceWith(auditor, AGENT_OVERSIGHT_DEFAULTS, s)).toBe(false);
            expect(mayReadOversightSurfaceWith(auditor, ALL_ON, s)).toBe(true);
        }
        // One switch opens one surface and no other.
        const onlyReceipts = { ...AGENT_OVERSIGHT_DEFAULTS, auditorReadsReceipts: true };
        expect(mayReadOversightSurfaceWith(auditor, onlyReceipts, 'receipts')).toBe(true);
        expect(mayReadOversightSurfaceWith(auditor, onlyReceipts, 'decisions')).toBe(false);
        expect(mayReadOversightSurfaceWith(auditor, onlyReceipts, 'quarantine')).toBe(false);
    });

    it('neither key reads none, even with every switch on', () => {
        for (const role of ['EDITOR', 'READER'] as const) {
            const admin = getPermissionsForRole(role).admin;
            for (const s of surfaces) expect(mayReadOversightSurfaceWith(admin, ALL_ON, s)).toBe(false);
        }
    });

    it('does not read the settings for a caller the switches cannot affect', async () => {
        await oversightReadsFor(ctxFor('OWNER'));
        await oversightReadsFor(ctxFor('READER'));
        expect(mockFindUnique).not.toHaveBeenCalled();
    });

    it('reads the settings for an Auditor and applies them', async () => {
        mockFindUnique.mockResolvedValueOnce({ auditorReadsAiDecisionLog: true });
        expect(await oversightReadsFor(ctxFor('AUDITOR'))).toEqual({
            decisions: true,
            receipts: false,
            quarantine: false,
        });
    });

    it('a refusal writes an AUTHZ_DENIED row and throws a 403', async () => {
        mockFindUnique.mockResolvedValueOnce(null);
        await expect(assertMayReadOversightSurface(ctxFor('AUDITOR'), 'quarantine')).rejects.toMatchObject({
            status: 403,
        });
        expect(mockAppend).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'AUTHZ_DENIED',
                detailsJson: expect.objectContaining({ reason: 'agent_oversight_surface', surface: 'quarantine' }),
            }),
        );
    });
});

describe('changing the settings', () => {
    it('is an owner’s, and an Admin is refused before anything is read', async () => {
        await expect(setAgentOversightSettings(ctxFor('ADMIN'), { auditorReadsReceipts: true })).rejects.toMatchObject({
            status: 403,
        });
        expect(mockFindUnique).not.toHaveBeenCalled();
    });

    it('refuses an owner’s API key and an agent', async () => {
        for (const extra of [{ apiKeyId: 'key-1' }, { agentId: 'agent-1' }]) {
            await expect(
                setAgentOversightSettings(ctxFor('OWNER', extra), { auditorReadsReceipts: true }),
            ).rejects.toMatchObject({ status: 403 });
        }
        expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('writes and audits only the switches that move', async () => {
        mockFindUnique.mockResolvedValueOnce(null);
        mockUpsert.mockResolvedValueOnce({ auditorReadsAgentReceipts: true });
        const result = await setAgentOversightSettings(ctxFor('OWNER'), {
            auditorReadsReceipts: true,
            composeNeedsSecondApprover: true, // already the default: not a change
        });
        expect(result.changed).toEqual(['auditorReadsReceipts']);
        expect(mockUpsert).toHaveBeenCalledWith(
            expect.objectContaining({ update: { auditorReadsAgentReceipts: true } }),
        );
        expect(mockLogEvent).toHaveBeenCalledTimes(1);
        expect(mockLogEvent.mock.calls[0][2]).toMatchObject({ action: 'AGENT_OVERSIGHT_SETTINGS_CHANGED' });
    });

    it('a patch that changes nothing writes nothing', async () => {
        mockFindUnique.mockResolvedValueOnce(null);
        const result = await setAgentOversightSettings(ctxFor('OWNER'), { auditorReadsReceipts: false });
        expect(result.changed).toEqual([]);
        expect(mockUpsert).not.toHaveBeenCalled();
        expect(mockLogEvent).not.toHaveBeenCalled();
    });
});
