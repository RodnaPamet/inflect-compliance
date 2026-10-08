/**
 * Adopting a username convention: versioned, audited, and refused to a non-admin.
 *
 * This is the half of Step 4a that touches a row. The engine half is pure and is
 * tested over a corpus; this one is tested over its effects — what lands in
 * `configJson`, what lands in the audit trail, and what is refused before either.
 */

const fakeDb = {
    integrationConnection: {
        findFirstOrThrow: jest.fn(),
        update: jest.fn(),
    },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn(fakeDb),
}));

const logEvent = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));

import {
    CONVENTION_CONFIG_KEY,
    adoptUsernameConvention,
    getUsernameConvention,
} from '@/app-layer/usecases/legacy-username-convention';
import { makeRequestContext } from '../helpers/make-context';

const admin = makeRequestContext('ADMIN', { userId: 'u-admin' });
const reader = makeRequestContext('READER', { userId: 'u-reader' });

function connectionRow(stored?: Record<string, unknown>, other?: Record<string, unknown>) {
    return {
        id: 'conn-1',
        name: 'Legacy Payroll',
        configJson: {
            ...(other ?? {}),
            ...(stored ? { [CONVENTION_CONFIG_KEY]: stored } : {}),
        },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    fakeDb.integrationConnection.update.mockResolvedValue({});
});

describe('4a — adopting a convention is versioned', () => {
    it('starts at version 1 with no previous template', async () => {
        fakeDb.integrationConnection.findFirstOrThrow.mockResolvedValue(connectionRow());
        const res = await adoptUsernameConvention(admin, {
            connectionId: 'conn-1',
            template: '{f}{last}',
        });
        expect(res).toMatchObject({ template: '{f}{last}', version: 1, previousTemplate: null });
        expect(res.adoptedByUserId).toBe('u-admin');
    });

    it('increments the version and carries the previous template', async () => {
        fakeDb.integrationConnection.findFirstOrThrow.mockResolvedValue(
            connectionRow({ template: '{f}{last}', version: 1, previousTemplate: null })
        );
        const res = await adoptUsernameConvention(admin, {
            connectionId: 'conn-1',
            template: '{first}.{last}',
        });
        expect(res).toMatchObject({
            template: '{first}.{last}',
            version: 2,
            previousTemplate: '{f}{last}',
        });
    });

    it('writes the record under one key and PRESERVES the rest of configJson', async () => {
        // `configJson` is shared with the provider's own settings. A bare write
        // here would delete whatever else the connection was configured with, and
        // nothing about the diff would look like a deletion.
        fakeDb.integrationConnection.findFirstOrThrow.mockResolvedValue(
            connectionRow(undefined, { baseUrl: 'https://legacy.example.test', pageSize: 500 })
        );
        await adoptUsernameConvention(admin, { connectionId: 'conn-1', template: '{f}{last}' });

        const written = fakeDb.integrationConnection.update.mock.calls[0][0].data.configJson;
        expect(written.baseUrl).toBe('https://legacy.example.test');
        expect(written.pageSize).toBe(500);
        expect(written[CONVENTION_CONFIG_KEY]).toMatchObject({ template: '{f}{last}', version: 1 });
    });

    it('re-adopting the identical template changes nothing and writes no audit row', async () => {
        // A version that advances without a change makes the history harder to
        // read, and an audit trail of non-events trains people to skip it.
        fakeDb.integrationConnection.findFirstOrThrow.mockResolvedValue(
            connectionRow({ template: '{f}{last}', version: 3, previousTemplate: '{first}.{last}' })
        );
        const res = await adoptUsernameConvention(admin, {
            connectionId: 'conn-1',
            template: '{f}{last}',
        });
        expect(res.version).toBe(3);
        expect(fakeDb.integrationConnection.update).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });
});

describe('4a — adopting a convention is audited', () => {
    it('records both templates and the version', async () => {
        fakeDb.integrationConnection.findFirstOrThrow.mockResolvedValue(
            connectionRow({ template: '{f}{last}', version: 1, previousTemplate: null })
        );
        await adoptUsernameConvention(admin, { connectionId: 'conn-1', template: '{last}{f}' });

        expect(logEvent).toHaveBeenCalledTimes(1);
        const entry = logEvent.mock.calls[0][2];
        expect(entry.action).toBe('LEGACY_USERNAME_CONVENTION_ADOPTED');
        expect(entry.entityType).toBe('IntegrationConnection');
        expect(entry.entityId).toBe('conn-1');
        // What CHANGED is the question an auditor asks.
        expect(entry.detailsJson).toMatchObject({
            template: '{last}{f}',
            previousTemplate: '{f}{last}',
            version: 2,
            adoptedByUserId: 'u-admin',
        });
    });

    it('carries nothing from the legacy system', async () => {
        // The template is operator-authored configuration and is safe here. An
        // account name or an employee name is not: `AuditLog.detailsJson` is
        // plaintext, hash-chained and never deleted.
        fakeDb.integrationConnection.findFirstOrThrow.mockResolvedValue(connectionRow());
        await adoptUsernameConvention(admin, { connectionId: 'conn-1', template: '{f}{last}' });

        const serialised = JSON.stringify(logEvent.mock.calls[0][2]);
        for (const forbidden of ['accountKey', 'displayName', 'workEmail', 'employeeNumber']) {
            expect(serialised).not.toContain(forbidden);
        }
        // Positive control: the thing it SHOULD carry is there, so the sweep above
        // is not passing over an empty payload.
        expect(serialised).toContain('{f}{last}');
    });
});

describe('4a — adoption is refused before anything is read', () => {
    it('refuses a malformed template with a 400, touching no row', async () => {
        fakeDb.integrationConnection.findFirstOrThrow.mockResolvedValue(connectionRow());
        await expect(
            adoptUsernameConvention(admin, { connectionId: 'conn-1', template: '{dept}{last}' })
        ).rejects.toThrow(/unknown token/);
        // Validation runs FIRST. A stored template that cannot be parsed would
        // make every later pull throw far from the request that caused it.
        expect(fakeDb.integrationConnection.findFirstOrThrow).not.toHaveBeenCalled();
        expect(fakeDb.integrationConnection.update).not.toHaveBeenCalled();
    });

    it.each(['', '{n?}', '{f}@{last}', '{n?}{last}'])('refuses %s', async (template) => {
        await expect(
            adoptUsernameConvention(admin, { connectionId: 'conn-1', template })
        ).rejects.toThrow();
        expect(fakeDb.integrationConnection.update).not.toHaveBeenCalled();
    });

    it('refuses a non-admin', async () => {
        fakeDb.integrationConnection.findFirstOrThrow.mockResolvedValue(connectionRow());
        await expect(
            adoptUsernameConvention(reader, { connectionId: 'conn-1', template: '{f}{last}' })
        ).rejects.toThrow();
        expect(fakeDb.integrationConnection.update).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });
});

describe('4a — reading the convention in force', () => {
    it('is readable by a READER, who sees the rule behind a suggestion', async () => {
        fakeDb.integrationConnection.findFirstOrThrow.mockResolvedValue(
            connectionRow({ template: '{f}{last}', version: 2, previousTemplate: '{first}.{last}' })
        );
        const res = await getUsernameConvention(reader, 'conn-1');
        expect(res).toMatchObject({ template: '{f}{last}', version: 2 });
    });

    it('returns null when none is adopted', async () => {
        fakeDb.integrationConnection.findFirstOrThrow.mockResolvedValue(connectionRow());
        expect(await getUsernameConvention(reader, 'conn-1')).toBeNull();
    });

    it('returns null for a malformed stored record rather than throwing', async () => {
        // A row written by an older shape must not break a reviewer's page.
        fakeDb.integrationConnection.findFirstOrThrow.mockResolvedValue(
            connectionRow({ template: 42, version: 'two' } as unknown as Record<string, unknown>)
        );
        expect(await getUsernameConvention(reader, 'conn-1')).toBeNull();
    });
});
