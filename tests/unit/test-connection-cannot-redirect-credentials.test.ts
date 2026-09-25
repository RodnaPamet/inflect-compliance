/**
 * The test button must not become a credential exfiltration primitive.
 *
 * ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
 *
 * `testConnectionCredentials` uses the STORED secrets when the caller does not
 * resend them, and that is correct — secrets are never rendered back to the
 * client, so the admin UI cannot resend them, and without this the test button
 * reported "invalid" for healthy connections and PERSISTED that verdict.
 *
 * But it merged the CALLER'S config over the stored config on the same call:
 *
 *     validateConnection(
 *         { ...storedConfig, ...(input.configJson ?? {}) },
 *         { ...storedSecrets, ...(input.secrets ?? {}) },
 *     )
 *
 * So one request naming a host the caller controls presented the tenant's
 * stored bind DN and password to it. The save path has refused exactly this
 * since `redirectsStoredCredential` was written — read that docblock, it
 * describes the attack in full — and the test path had no equivalent.
 *
 * It is the SHARPER version of the same hole. A save writes an audit row and
 * leaves a changed connection behind; a test leaves only a routine-looking
 * `lastTestStatus`, and `updateConnectionTestStatus` writes no audit row at
 * all. And it is available to an `admin.manage` holder who cannot READ the
 * credential through any route, because GET masks it.
 *
 * Found by the second-pass JML audit (#2892, finding 1) and verified against
 * the source before fixing.
 */
import { testConnectionCredentials } from '@/app-layer/usecases/integrations';

const mockDb = { integrationConnection: { findFirst: jest.fn(), updateMany: jest.fn() } };
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
}));

const validateConnection = jest.fn();
// NO MODULE MOCK — a spy on the real registry.
//
// Mocking the module broke the suite three times: it exports more than one
// registry, `bootstrap.ts` calls `register` on each at load, and `registry` is
// a CLASS INSTANCE — so even `{ ...actual.registry }` dropped `register`,
// because spreading copies own properties and that method is on the prototype.
//
// Each attempt produced "Test suite failed to run" with `Tests: 0 total`,
// which reads as a passing run in any summary counting failures rather than
// tests. A spy cannot be a subset of the thing it stands for.
import { registry } from '@/app-layer/integrations/registry';

// `decryptConnectionSecrets` is a LOCAL function in the usecase, so it cannot
// be mocked directly — it calls `decryptField` and JSON.parses the result.
// Mocking that primitive is what puts a known secret bag on the stored row.
jest.mock('@/lib/security/encryption', () => {
    const actual = jest.requireActual('@/lib/security/encryption');
    return {
        ...actual,
        // A FIXTURE, never a credential: the test asserts this value reaches the
        // provider unchanged, so it has to occupy the shape of the thing it
        // stands for. The marker goes on the OFFENDING LINE — the scanner reads
        // the line, not a preceding comment.
        decryptField: () =>
            JSON.stringify({ bindDN: 'CN=svc,DC=corp', bindPassword: 'fixture-not-a-secret' }), // pragma: allowlist secret
    };
});

const CTX = { tenantId: 't-1', userId: 'u-1' } as never;

beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.spyOn(registry, 'getProvider').mockReturnValue({
        validateConnection: (...a: unknown[]) => validateConnection(...a),
    } as never);
    validateConnection.mockResolvedValue({ valid: true });
    mockDb.integrationConnection.findFirst.mockResolvedValue({
        provider: 'active-directory',
        configJson: { url: 'ldaps://dc.corp.example.com:636', baseDN: 'DC=corp,DC=example,DC=com' },
        secretEncrypted: 'ciphertext',
    });
    mockDb.integrationConnection.updateMany.mockResolvedValue({ count: 1 });
});

describe('a caller cannot point a stored credential at a host they chose', () => {
    it('REFUSES a url change when the secret was not resent, and never calls the provider', async () => {
        await expect(
            testConnectionCredentials(CTX, {
                connectionId: 'c-1',
                provider: 'active-directory',
                configJson: { url: 'ldaps://attacker.tld:636' },
            }),
        ).rejects.toThrow(/different host/i);
        // The refusal must happen BEFORE the bind. A provider call that already
        // went out cannot be un-sent.
        expect(validateConnection).not.toHaveBeenCalled();
    });

    it('ALLOWS a url change when the credential is resent — the rotate-and-retarget case', async () => {
        // The positive control, and it is the case the save path also allows.
        // A check that refused every host change would break testing a
        // connection whose server genuinely moved, which is how a guard gets
        // deleted rather than fixed.
        await testConnectionCredentials(CTX, {
            connectionId: 'c-1',
            provider: 'active-directory',
            configJson: { url: 'ldaps://newdc.corp.example.com:636' },
            secrets: { bindPassword: 'freshly-typed' },
        });
        expect(validateConnection).toHaveBeenCalled();
    });

    it('allows a config change that does NOT move the host', async () => {
        // `baseDN` addresses no credential. Refusing it would be a check that
        // does not know what it is protecting.
        await testConnectionCredentials(CTX, {
            connectionId: 'c-1',
            provider: 'active-directory',
            configJson: { baseDN: 'OU=Staff,DC=corp,DC=example,DC=com' },
        });
        expect(validateConnection).toHaveBeenCalled();
    });

    it('still tests an unchanged saved connection — the bug the stored-secret merge fixed', async () => {
        // Regression guard on the original defect. If this breaks, the test
        // button marks healthy connections broken again.
        await testConnectionCredentials(CTX, { connectionId: 'c-1', provider: 'active-directory' });
        const [, secrets] = validateConnection.mock.calls[0];
        expect(secrets).toMatchObject({ bindPassword: 'fixture-not-a-secret' }); // pragma: allowlist secret
    });
});

describe("a caller cannot test one provider's connection as another", () => {
    it('refuses when the named provider is not the connection\'s', async () => {
        // The amplification: `providerImpl` comes from the CALLER while the
        // secrets come from the ROW, so without this they may disagree and one
        // integration's decrypted credential reaches another's client.
        await expect(
            testConnectionCredentials(CTX, {
                connectionId: 'c-1',
                provider: 'servicenow',
                configJson: { instance: 'attacker.service-now.com' },
            }),
        ).rejects.toThrow(/not servicenow|is a active-directory/i);
        expect(validateConnection).not.toHaveBeenCalled();
    });

    it('allows the matching provider — the control', async () => {
        await testConnectionCredentials(CTX, { connectionId: 'c-1', provider: 'active-directory' });
        expect(validateConnection).toHaveBeenCalled();
    });
});

describe('an unsaved connection is unaffected', () => {
    it('tests caller-supplied config and secrets with no stored row', async () => {
        // No connectionId means nothing stored is at risk — the caller is
        // testing values they already hold.
        await testConnectionCredentials(CTX, {
            provider: 'active-directory',
            configJson: { url: 'ldaps://anywhere.example:636' },
            secrets: { bindPassword: 'typed' },
        });
        expect(validateConnection).toHaveBeenCalled();
        expect(mockDb.integrationConnection.findFirst).not.toHaveBeenCalled();
    });
});
