/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks and Prisma
 * delegate shims mirror runtime contracts; the file-level disable is this
 * repo's standard pattern for mock-heavy usecase tests (see
 * tests/unit/usecases/integrations.test.ts). */
/**
 * Branch coverage for src/app-layer/usecases/integrations.ts — the paths the
 * existing suites leave untaken: the security-flag audit projection, the
 * "update without touching config" seam, secret decryption failure, the
 * run-check failure classification, the evidence-creation gate, the webhook
 * error arm, provider-category defaulting, and the freshness arithmetic in
 * getConnectionsHealth.
 *
 * Every assertion here names an OBSERVABLE difference between the two arms of
 * a branch: a value written to the DB, a value handed to the provider, the
 * shape of the returned object, or a field in the audit entry. Fixtures are
 * built so the two arms cannot coincide — the validated config is a DIFFERENT
 * object from the submitted one, the reported duration is a number the clock
 * cannot produce, and the decrypted secret shadows a config key with a
 * DIFFERENT value.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/integrations/registry', () => ({
    registry: {
        getProvider: jest.fn(),
        resolveByAutomationKey: jest.fn(),
        getWebhookProvider: jest.fn(),
        listProviders: jest.fn().mockReturnValue([]),
        listAllAutomationKeys: jest.fn().mockReturnValue([]),
    },
}));
// The usecase imports the provider-bootstrap side-effect module; the real one
// would call registry.register(...) on the mock above, which has no such method.
jest.mock('@/app-layer/integrations/bootstrap', () => ({}));

jest.mock('@/app-layer/integrations/types', () => ({
    parseAutomationKey: jest.fn(),
    isScheduledCheckProvider: jest.fn(() => true),
}));

jest.mock('@/lib/security/encryption', () => ({
    encryptField: jest.fn(() => 'ENCRYPTED_BLOB_OPAQUE'),
    decryptField: jest.fn(() => '{}'),
}));

// Validation is mocked so the VALIDATED config can be a distinguishable object
// from the SUBMITTED one. If both were the same value no assertion could tell
// whether the usecase stores the checked config or the raw input.
jest.mock('@/app-layer/integrations/config-schema', () => ({
    validateProviderConfig: jest.fn(),
}));

jest.mock('@/lib/prisma', () => ({
    prisma: {
        integrationWebhookEvent: { create: jest.fn(), update: jest.fn() },
    },
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
    upsertIntegrationConnection,
    runAutomationForControl,
    handleIncomingWebhook,
    listAvailableProviders,
    listExecutionsForConnection,
    getConnectionsHealth,
} from '@/app-layer/usecases/integrations';
import { runInTenantContext } from '@/lib/db-context';
import { registry } from '@/app-layer/integrations/registry';
import { isScheduledCheckProvider } from '@/app-layer/integrations/types';
import { validateProviderConfig } from '@/app-layer/integrations/config-schema';
import { decryptField } from '@/lib/security/encryption';
import { logEvent } from '@/app-layer/events/audit';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import { makeRequestContext } from '../../helpers/make-context';
import type { CheckResult, EvidencePayload } from '@/app-layer/integrations/types';
import { ValidationError } from '@/lib/errors/types';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockGetProvider = registry.getProvider as jest.MockedFunction<typeof registry.getProvider>;
const mockResolveKey = registry.resolveByAutomationKey as jest.MockedFunction<typeof registry.resolveByAutomationKey>;
const mockListProviders = registry.listProviders as jest.MockedFunction<typeof registry.listProviders>;
const mockGetWebhookProvider = registry.getWebhookProvider as jest.MockedFunction<typeof registry.getWebhookProvider>;
const mockIsScheduled = isScheduledCheckProvider as unknown as jest.MockedFunction<(p: unknown) => boolean>;
const mockValidate = validateProviderConfig as jest.MockedFunction<typeof validateProviderConfig>;
const mockDecrypt = decryptField as jest.MockedFunction<typeof decryptField>;
const mockLogEvent = logEvent as jest.MockedFunction<typeof logEvent>;
const mockLoggerError = logger.error as jest.MockedFunction<typeof logger.error>;
const mockWebhookCreate = prisma.integrationWebhookEvent.create as jest.MockedFunction<typeof prisma.integrationWebhookEvent.create>;
const mockWebhookUpdate = prisma.integrationWebhookEvent.update as jest.MockedFunction<typeof prisma.integrationWebhookEvent.update>;

beforeEach(() => {
    jest.clearAllMocks();
    mockIsScheduled.mockReturnValue(true);
    mockGetProvider.mockReturnValue({ id: 'datadog' } as never);
    mockValidate.mockReturnValue({});
    mockDecrypt.mockReturnValue('{}');
});

/** Read the detailsJson of the n-th logEvent call. */
function auditDetails(call = 0): Record<string, unknown> {
    return (mockLogEvent.mock.calls[call][2] as any).detailsJson as Record<string, unknown>;
}

// ─── enabledSecurityFlags — the audit projection ─────────────────────

describe('upsertIntegrationConnection — security-weakening flags in the audit entry', () => {
    function stubCreate() {
        const create = jest.fn().mockResolvedValue({ id: 'conn-new' });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ integrationConnection: { create } } as never),
        );
        return create;
    }

    it('names each ENABLED weakening flag and omits the ones left off', async () => {
        stubCreate();
        mockValidate.mockReturnValue({ validated: true });

        await upsertIntegrationConnection(makeRequestContext('ADMIN'), {
            provider: 'active-directory',
            name: 'AD',
            configJson: {
                // boolean true and the string 'true' are both "on"
                allowSelfSignedTls: true,
                insecureSkipVerify: 'true',
                // explicitly OFF — must not appear
                disableCertValidation: false,
                // not a weakening flag at all — must not appear
                host: 'ldaps://dc.example.com',
            },
        });

        // toStrictEqual, and the exact membership: a projection that returned
        // every key, or that treated `false` as on, would differ here.
        expect(auditDetails().securityFlagsEnabled).toStrictEqual([
            'allowSelfSignedTls',
            'insecureSkipVerify',
        ]);
    });

    it('records an EMPTY list when no config was submitted at all', async () => {
        stubCreate();

        await upsertIntegrationConnection(makeRequestContext('ADMIN'), {
            provider: 'datadog',
            name: 'DD',
        });

        expect(auditDetails().securityFlagsEnabled).toStrictEqual([]);
    });

    it('records an EMPTY list for a non-object config rather than throwing', async () => {
        stubCreate();

        await upsertIntegrationConnection(makeRequestContext('ADMIN'), {
            provider: 'datadog',
            name: 'DD',
            configJson: 'allowSelfSignedTls' as never,
        });

        expect(auditDetails().securityFlagsEnabled).toStrictEqual([]);
    });
});

// ─── upsert — what actually reaches the write ────────────────────────

describe('upsertIntegrationConnection — the value written is the VALIDATED config', () => {
    it('stores the validator output, not the submitted object', async () => {
        const create = jest.fn().mockResolvedValue({ id: 'conn-new' });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ integrationConnection: { create } } as never),
        );
        const submitted = { host: 'ldaps://dc.example.com', extra: 'dropped-by-validator' };
        const validated = { host: 'ldaps://dc.example.com' };
        mockValidate.mockReturnValue(validated);

        await upsertIntegrationConnection(makeRequestContext('ADMIN'), {
            provider: 'active-directory',
            name: 'AD',
            configJson: submitted,
        });

        expect(mockValidate).toHaveBeenCalledWith('active-directory', submitted);
        expect(create.mock.calls[0][0].data.configJson).toStrictEqual(validated);
    });

    it('leaves configJson UNTOUCHED on an update that did not submit one', async () => {
        const update = jest.fn().mockResolvedValue({ id: 'conn-1' });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    findFirst: jest.fn().mockResolvedValue({ id: 'conn-1', provider: 'datadog' }),
                    update,
                },
            } as never),
        );
        // The validator still returns {} for an absent config; storing THAT
        // would silently wipe the connection's stored settings.
        mockValidate.mockReturnValue({});

        await upsertIntegrationConnection(makeRequestContext('ADMIN'), {
            id: 'conn-1',
            provider: 'datadog',
            name: 'Renamed',
        });

        const data = update.mock.calls[0][0].data;
        expect(data.configJson).toBeUndefined();
        expect(data.name).toBe('Renamed');
    });

    it('writes the validated config on an update that DID submit one', async () => {
        const update = jest.fn().mockResolvedValue({ id: 'conn-1' });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    findFirst: jest.fn().mockResolvedValue({ id: 'conn-1', provider: 'datadog' }),
                    update,
                },
            } as never),
        );
        mockValidate.mockReturnValue({ site: 'eu1' });

        await upsertIntegrationConnection(makeRequestContext('ADMIN'), {
            id: 'conn-1',
            provider: 'datadog',
            name: 'DD',
            configJson: { site: 'eu1', junk: 1 },
        });

        expect(update.mock.calls[0][0].data.configJson).toStrictEqual({ site: 'eu1' });
    });

    it('honours an explicit isEnabled=false instead of defaulting it back on', async () => {
        const create = jest.fn().mockResolvedValue({ id: 'conn-new' });
        mockRunInTx.mockImplementation(async (_ctx, fn) =>
            fn({ integrationConnection: { create } } as never),
        );

        await upsertIntegrationConnection(makeRequestContext('ADMIN'), {
            provider: 'datadog', name: 'off', isEnabled: false,
        });
        expect(create.mock.calls[0][0].data.isEnabled).toBe(false);

        await upsertIntegrationConnection(makeRequestContext('ADMIN'), {
            provider: 'datadog', name: 'default',
        });
        expect(create.mock.calls[1][0].data.isEnabled).toBe(true);
    });

    it('omits secretEncrypted from an update when the caller sent an EMPTY secrets object', async () => {
        const update = jest.fn().mockResolvedValue({ id: 'conn-1' });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: {
                    findFirst: jest.fn().mockResolvedValue({ id: 'conn-1', provider: 'datadog' }),
                    update,
                },
            } as never),
        );

        await upsertIntegrationConnection(makeRequestContext('ADMIN'), {
            id: 'conn-1', provider: 'datadog', name: 'DD', secrets: {},
        });

        // Not merely undefined — the key must be ABSENT, because Prisma treats
        // an explicit `secretEncrypted: undefined` and a missing key the same
        // way only by accident of the spread; the spread is what is under test.
        expect(Object.prototype.hasOwnProperty.call(update.mock.calls[0][0].data, 'secretEncrypted')).toBe(false);
    });
});

// ─── runAutomationForControl — dispatch + failure classification ─────

const CONTROL = { id: 'ctl-1', automationKey: 'datadog.monitors', tenantId: 'tenant-1', name: 'Monitors' };

type RunHarness = {
    execCreate: jest.Mock;
    execUpdate: jest.Mock;
    evidenceCreate: jest.Mock;
    linkCreate: jest.Mock;
};

function harness(connection: Record<string, unknown>): RunHarness {
    const execCreate = jest.fn().mockResolvedValue({ id: 'exec-1', status: 'RUNNING' });
    const execUpdate = jest.fn().mockResolvedValue({});
    const evidenceCreate = jest.fn().mockResolvedValue({ id: 'ev-1' });
    const linkCreate = jest.fn().mockResolvedValue({});
    mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
        fn({
            control: { findFirst: jest.fn().mockResolvedValue(CONTROL) },
            integrationConnection: { findFirst: jest.fn().mockResolvedValue(connection) },
            integrationExecution: { create: execCreate, update: execUpdate },
            evidence: { create: evidenceCreate },
            evidenceControlLink: { create: linkCreate },
        } as never),
    );
    return { execCreate, execUpdate, evidenceCreate, linkCreate };
}

function resolveTo(runCheck: jest.Mock, mapResultToEvidence: jest.Mock) {
    mockResolveKey.mockReturnValue({
        provider: { runCheck, mapResultToEvidence } as never,
        parsed: { provider: 'datadog', check: 'monitors' } as never,
    } as never);
}

describe('runAutomationForControl — provider capability gate', () => {
    it('refuses a resolved provider that cannot run scheduled checks', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({ control: { findFirst: jest.fn().mockResolvedValue(CONTROL) } } as never),
        );
        const runCheck = jest.fn();
        resolveTo(runCheck, jest.fn());
        mockIsScheduled.mockReturnValue(false);

        // The TYPE is the contract — a 400 tells the caller the wiring is
        // wrong, a 404 or a 500 would send them looking somewhere else.
        const err = await runAutomationForControl(makeRequestContext('EDITOR'), 'ctl-1')
            .then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).status).toBe(400);
        expect((err as ValidationError).message).toMatch(/does not support scheduled checks/);
        // The refusal is BEFORE any work: no execution row, no provider call.
        expect(runCheck).not.toHaveBeenCalled();
    });
});

describe('runAutomationForControl — secrets handed to the provider', () => {
    it('merges decrypted secrets OVER the stored config', async () => {
        const runCheck = jest.fn().mockResolvedValue({
            status: 'PASSED', summary: 'ok', details: {}, durationMs: 5,
        } as CheckResult);
        harness({ id: 'conn-1', configJson: { site: 'CONFIG_SITE', region: 'eu' }, secretEncrypted: 'blob' });
        resolveTo(runCheck, jest.fn().mockReturnValue(null));
        mockDecrypt.mockReturnValue(JSON.stringify({ site: 'SECRET_SITE', apiKey: 'k' }));

        await runAutomationForControl(makeRequestContext('EDITOR'), 'ctl-1');

        // The two sources disagree on `site` on purpose: only the documented
        // precedence (secrets last) produces SECRET_SITE.
        expect(runCheck.mock.calls[0][0].connectionConfig).toStrictEqual({
            site: 'SECRET_SITE', region: 'eu', apiKey: 'k',
        });
    });

    it('passes config ALONE when the connection stores no secret', async () => {
        const runCheck = jest.fn().mockResolvedValue({
            status: 'PASSED', summary: 'ok', details: {},
        } as CheckResult);
        harness({ id: 'conn-1', configJson: { site: 'eu' }, secretEncrypted: null });
        resolveTo(runCheck, jest.fn().mockReturnValue(null));

        await runAutomationForControl(makeRequestContext('EDITOR'), 'ctl-1');

        expect(runCheck.mock.calls[0][0].connectionConfig).toStrictEqual({ site: 'eu' });
        expect(mockDecrypt).not.toHaveBeenCalled();
    });

    it('degrades to config-only and logs when the stored secret will not decrypt', async () => {
        const runCheck = jest.fn().mockResolvedValue({
            status: 'PASSED', summary: 'ok', details: {},
        } as CheckResult);
        harness({ id: 'conn-1', configJson: { site: 'eu' }, secretEncrypted: 'corrupt' });
        resolveTo(runCheck, jest.fn().mockReturnValue(null));
        mockDecrypt.mockImplementation(() => { throw new Error('bad auth tag'); });

        await runAutomationForControl(makeRequestContext('EDITOR'), 'ctl-1');

        expect(runCheck.mock.calls[0][0].connectionConfig).toStrictEqual({ site: 'eu' });
        expect(mockLoggerError).toHaveBeenCalledWith(
            'Failed to decrypt integration secrets',
            { component: 'integrations' },
        );
    });
});

describe('runAutomationForControl — runtime failure classification', () => {
    it('records ERROR with the thrown message and returns without touching evidence', async () => {
        const h = harness({ id: 'conn-1', configJson: {}, secretEncrypted: null });
        const runCheck = jest.fn().mockRejectedValue(new Error('datadog 503'));
        const mapEvidence = jest.fn();
        resolveTo(runCheck, mapEvidence);

        const res = await runAutomationForControl(makeRequestContext('EDITOR'), 'ctl-1');

        expect(h.execUpdate.mock.calls[0][0].data).toMatchObject({
            status: 'ERROR', errorMessage: 'datadog 503',
        });
        expect((res.execution as any).status).toBe('ERROR');
        expect((res.execution as any).errorMessage).toBe('datadog 503');
        expect(mapEvidence).not.toHaveBeenCalled();
        expect(h.evidenceCreate).not.toHaveBeenCalled();
    });

    it('stringifies a non-Error rejection rather than storing undefined', async () => {
        const h = harness({ id: 'conn-1', configJson: {}, secretEncrypted: null });
        resolveTo(jest.fn().mockRejectedValue('socket hang up'), jest.fn());

        const res = await runAutomationForControl(makeRequestContext('EDITOR'), 'ctl-1');

        expect(h.execUpdate.mock.calls[0][0].data.errorMessage).toBe('socket hang up');
        expect((res.execution as any).errorMessage).toBe('socket hang up');
    });
});

describe('runAutomationForControl — the evidence gate', () => {
    const passed = (extra: Partial<CheckResult> = {}): CheckResult => ({
        status: 'PASSED', summary: 'all good', details: { n: 1 }, ...extra,
    } as CheckResult);

    it('creates evidence and links it to the control when the provider returns a payload', async () => {
        const h = harness({ id: 'conn-1', configJson: {}, secretEncrypted: null });
        const payload: EvidencePayload = {
            title: 'Monitor coverage', content: 'body', type: 'REPORT', category: 'monitoring',
        };
        resolveTo(jest.fn().mockResolvedValue(passed()), jest.fn().mockReturnValue(payload));

        const res = await runAutomationForControl(makeRequestContext('EDITOR'), 'ctl-1');

        const ev = h.evidenceCreate.mock.calls[0][0].data;
        expect(ev.title).toBe('Monitor coverage');
        // The integration vocabulary (REPORT) is mapped onto the Prisma enum.
        expect(ev.type).toBe('TEXT');
        expect(ev.category).toBe('monitoring');
        expect(h.linkCreate.mock.calls[0][0].data).toStrictEqual({
            tenantId: 'tenant-1', evidenceId: 'ev-1', controlId: 'ctl-1', createdByUserId: 'user-1',
        });
        // The evidence id reaches BOTH the execution row and the caller.
        expect(h.execUpdate.mock.calls[0][0].data.evidenceId).toBe('ev-1');
        expect((res.execution as any).evidenceId).toBe('ev-1');
    });

    it('falls back to the "integration" category when the payload names none', async () => {
        const h = harness({ id: 'conn-1', configJson: {}, secretEncrypted: null });
        resolveTo(
            jest.fn().mockResolvedValue(passed()),
            jest.fn().mockReturnValue({ title: 't', content: 'c', type: 'LOG' } as EvidencePayload),
        );

        await runAutomationForControl(makeRequestContext('EDITOR'), 'ctl-1');

        expect(h.evidenceCreate.mock.calls[0][0].data.category).toBe('integration');
    });

    it('stores a NULL author when the run has no acting user (scheduled job)', async () => {
        const h = harness({ id: 'conn-1', configJson: {}, secretEncrypted: null });
        resolveTo(
            jest.fn().mockResolvedValue(passed()),
            jest.fn().mockReturnValue({ title: 't', content: 'c', type: 'LOG' } as EvidencePayload),
        );

        await runAutomationForControl(
            makeRequestContext('EDITOR', { userId: undefined }),
            'ctl-1',
            { triggeredBy: 'scheduled' },
        );

        expect(h.linkCreate.mock.calls[0][0].data.createdByUserId).toBeNull();
    });

    it('creates NO evidence when the provider declines to map one', async () => {
        const h = harness({ id: 'conn-1', configJson: {}, secretEncrypted: null });
        const mapEvidence = jest.fn().mockReturnValue(null);
        resolveTo(jest.fn().mockResolvedValue(passed()), mapEvidence);

        const res = await runAutomationForControl(makeRequestContext('EDITOR'), 'ctl-1');

        expect(mapEvidence).toHaveBeenCalled();
        expect(h.evidenceCreate).not.toHaveBeenCalled();
        expect(h.linkCreate).not.toHaveBeenCalled();
        expect(h.execUpdate.mock.calls[0][0].data.evidenceId).toBeUndefined();
        expect((res.execution as any).evidenceId).toBeUndefined();
    });

    it('does not even ASK for evidence when the check was NOT_APPLICABLE', async () => {
        const h = harness({ id: 'conn-1', configJson: {}, secretEncrypted: null });
        const mapEvidence = jest.fn().mockReturnValue({
            title: 'should never be used', content: 'c', type: 'LOG',
        } as EvidencePayload);
        resolveTo(
            jest.fn().mockResolvedValue({ status: 'NOT_APPLICABLE', summary: 'empty population', details: {} } as CheckResult),
            mapEvidence,
        );

        const res = await runAutomationForControl(makeRequestContext('EDITOR'), 'ctl-1');

        expect(mapEvidence).not.toHaveBeenCalled();
        expect(h.evidenceCreate).not.toHaveBeenCalled();
        // …but the outcome is still persisted and reported.
        expect(h.execUpdate.mock.calls[0][0].data.status).toBe('NOT_APPLICABLE');
        expect((res.execution as any).status).toBe('NOT_APPLICABLE');
    });

    it('prefers the provider-reported duration over the wall clock', async () => {
        const h = harness({ id: 'conn-1', configJson: {}, secretEncrypted: null });
        resolveTo(jest.fn().mockResolvedValue(passed({ durationMs: 4242 })), jest.fn().mockReturnValue(null));

        const res = await runAutomationForControl(makeRequestContext('EDITOR'), 'ctl-1');

        expect(h.execUpdate.mock.calls[0][0].data.durationMs).toBe(4242);
        expect((res.execution as any).durationMs).toBe(4242);
    });

    it('falls back to the measured elapsed time when the provider reports none', async () => {
        const h = harness({ id: 'conn-1', configJson: {}, secretEncrypted: null });
        const realNow = Date.now;
        const ticks = [1_000_000, 1_000_777];
        Date.now = jest.fn(() => ticks.shift() ?? 1_000_777) as unknown as () => number;
        try {
            resolveTo(jest.fn().mockResolvedValue(passed()), jest.fn().mockReturnValue(null));
            const res = await runAutomationForControl(makeRequestContext('EDITOR'), 'ctl-1');
            expect(h.execUpdate.mock.calls[0][0].data.durationMs).toBe(777);
            expect((res.execution as any).durationMs).toBe(777);
        } finally {
            Date.now = realNow;
        }
    });
});

// ─── handleIncomingWebhook — the error arm ───────────────────────────

describe('handleIncomingWebhook — processing failure', () => {
    it('flips the row to "error" and reports the message when the update throws', async () => {
        mockWebhookCreate.mockResolvedValueOnce({ id: 'evt-9' } as never);
        mockGetWebhookProvider.mockReturnValue({} as never);
        mockWebhookUpdate
            .mockRejectedValueOnce(new Error('deadlock detected'))
            .mockResolvedValueOnce({} as never);

        const res = await handleIncomingWebhook('tenant-1', 'datadog', { headers: {}, body: {} });

        expect(res).toStrictEqual({
            eventId: 'evt-9', status: 'error', errorMessage: 'deadlock detected',
        });
        expect(mockWebhookUpdate.mock.calls[1][0]).toStrictEqual({
            where: { id: 'evt-9' },
            data: { status: 'error', errorMessage: 'deadlock detected' },
        });
    });

    it('accepts a null tenantId — an unattributed webhook is still stored', async () => {
        mockWebhookCreate.mockResolvedValueOnce({ id: 'evt-10' } as never);
        mockGetWebhookProvider.mockReturnValue(null);

        const res = await handleIncomingWebhook(null, 'mystery', { headers: {}, body: {} });

        expect(mockWebhookCreate.mock.calls[0][0].data.tenantId).toBeNull();
        expect(res.status).toBe('ignored');
        expect(mockWebhookUpdate.mock.calls[0][0].data.errorMessage).toBe('No handler for provider: mystery');
    });
});

// ─── listAvailableProviders — category + liveValidation defaulting ───

describe('listAvailableProviders', () => {
    it('categorises a known connector and falls back to "other" for an unmapped one', () => {
        mockListProviders.mockReturnValue([
            { id: 'okta', displayName: 'Okta', description: 'd', supportedChecks: [], configSchema: {}, liveValidation: true },
            { id: 'datadog', displayName: 'Datadog', description: 'd', supportedChecks: [], configSchema: {} },
        ] as never);

        const out = listAvailableProviders();

        expect(out[0].category).toBe('identity');
        expect(out[0].liveValidation).toBe(true);
        expect(out[1].category).toBe('other');
        // Absent liveValidation must read as false, not undefined — the admin
        // UI renders "live validation" off a boolean.
        expect(out[1].liveValidation).toBe(false);
    });
});

// ─── list limits ─────────────────────────────────────────────────────

describe('listExecutionsForConnection — bound', () => {
    it('defaults the page size and honours an explicit one', async () => {
        const findMany = jest.fn().mockResolvedValue([]);
        mockRunInTx.mockImplementation(async (_ctx, fn) =>
            fn({ integrationExecution: { findMany } } as never),
        );

        await listExecutionsForConnection(makeRequestContext('READER'), 'conn-1');
        expect(findMany.mock.calls[0][0].take).toBe(50);
        expect(findMany.mock.calls[0][0].where).toStrictEqual({ tenantId: 'tenant-1', connectionId: 'conn-1' });

        await listExecutionsForConnection(makeRequestContext('READER'), 'conn-1', { limit: 3 });
        expect(findMany.mock.calls[1][0].take).toBe(3);
    });
});

// ─── getConnectionsHealth — freshness arithmetic ─────────────────────

describe('getConnectionsHealth — activity vs success', () => {
    const NOW = 1_700_000_000_000;
    const minsAgo = (m: number) => new Date(NOW - m * 60_000);
    let realNow: () => number;

    beforeEach(() => {
        realNow = Date.now;
        Date.now = () => NOW;
    });
    afterEach(() => {
        Date.now = realNow;
    });

    function health(connections: unknown[], passedRows: unknown[], anyRows: unknown[]) {
        const groupBy = jest.fn()
            .mockResolvedValueOnce(passedRows)
            .mockResolvedValueOnce(anyRows);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn({
                integrationConnection: { findMany: jest.fn().mockResolvedValue(connections) },
                integrationExecution: { groupBy },
            } as never),
        );
        return getConnectionsHealth(makeRequestContext('ADMIN'));
    }

    it('counts a SUCCESSFUL connection test as activity, an unsuccessful one as none', async () => {
        const res = await health(
            [
                { id: 'tested-ok', provider: 'okta', name: 'A', createdAt: minsAgo(9999), lastTestedAt: minsAgo(5), lastTestStatus: 'ok' },
                { id: 'tested-bad', provider: 'okta', name: 'B', createdAt: minsAgo(9999), lastTestedAt: minsAgo(5), lastTestStatus: 'error' },
            ],
            [], [],
        );
        const byId = Object.fromEntries(res.connections.map((c) => [c.connectionId, c]));

        // Same lastTestedAt on both rows — only the STATUS differs, so a
        // reading that ignored lastTestStatus would call both fresh.
        expect(byId['tested-ok'].isStale).toBe(false);
        expect(byId['tested-ok'].secondsSinceActivity).toBe(300);
        expect(byId['tested-bad'].isStale).toBe(true);
        expect(byId['tested-bad'].secondsSinceActivity).toBeNull();
        // Neither has ever passed a CHECK, whatever the test said.
        expect(byId['tested-ok'].hasEverSucceeded).toBe(false);
        expect(byId['tested-ok'].lastSuccessAt).toBeNull();
        expect(res.staleCount).toBe(1);
    });

    it('reads executedAt when the grouped max has no completedAt', async () => {
        const res = await health(
            [{ id: 'c1', provider: 'okta', name: 'A', createdAt: minsAgo(9999), lastTestedAt: null, lastTestStatus: null }],
            [{ connectionId: 'c1', _max: { completedAt: null, executedAt: minsAgo(30) } }],
            [{ connectionId: 'c1', _max: { completedAt: null, executedAt: minsAgo(30) } }],
        );

        expect(res.connections[0].secondsSinceLastSuccess).toBe(1800);
        expect(res.connections[0].lastSuccessAt).toBe(minsAgo(30).toISOString());
        expect(res.connections[0].isStale).toBe(false);
    });

    it('ignores a grouped row with no connectionId instead of crashing', async () => {
        const res = await health(
            [{ id: 'c1', provider: 'okta', name: 'A', createdAt: minsAgo(9999), lastTestedAt: null, lastTestStatus: null }],
            [{ connectionId: null, _max: { completedAt: minsAgo(1), executedAt: minsAgo(1) } }],
            [{ connectionId: null, _max: { completedAt: minsAgo(1), executedAt: minsAgo(1) } }],
        );

        // The orphan row must not be credited to c1.
        expect(res.connections[0].hasEverSucceeded).toBe(false);
        expect(res.connections[0].lastActivityAt).toBeNull();
        expect(res.connections[0].isStale).toBe(true);
    });

    it('is fresh on a recent FAILED run even though it has never succeeded', async () => {
        const res = await health(
            [{ id: 'c1', provider: 'okta', name: 'A', createdAt: minsAgo(9999), lastTestedAt: null, lastTestStatus: null }],
            [],
            [{ connectionId: 'c1', _max: { completedAt: minsAgo(2), executedAt: minsAgo(3) } }],
        );

        expect(res.connections[0].hasEverSucceeded).toBe(false);
        expect(res.connections[0].isStale).toBe(false);
        expect(res.connections[0].lastRunAt).toBe(minsAgo(2).toISOString());
        expect(res.connections[0].secondsSinceLastSuccess).toBeNull();
    });

    it('takes the MOST RECENT of a run and a successful test as the activity time', async () => {
        const res = await health(
            [{ id: 'c1', provider: 'okta', name: 'A', createdAt: minsAgo(9999), lastTestedAt: minsAgo(1), lastTestStatus: 'ok' }],
            [],
            [{ connectionId: 'c1', _max: { completedAt: minsAgo(90), executedAt: minsAgo(90) } }],
        );

        // Run at T-90m, test at T-1m: the newer of the two wins.
        expect(res.connections[0].lastActivityAt).toBe(minsAgo(1).toISOString());
        expect(res.connections[0].secondsSinceActivity).toBe(60);
    });
});
