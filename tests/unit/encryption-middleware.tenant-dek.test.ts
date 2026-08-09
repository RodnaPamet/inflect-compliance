/**
 * Unit Test: Epic B.2 tenant-DEK integration in the encryption middleware.
 *
 * Builds on the Epic B.1 baseline (existing
 * `encryption-middleware.test.ts`) to pin the v2 / tenant-DEK behaviour:
 *
 *   - With an audit-context tenantId, writes produce **v2** ciphertext
 *     using the tenant's DEK.
 *   - Without context, writes fall back to **v1** under the global KEK.
 *   - Reads dispatch per-value: v1 → global KEK, v2 → tenant DEK.
 *   - **Cross-tenant isolation**: tenant A's v2 ciphertext is NOT
 *     decryptable with tenant B's DEK; the middleware catches the
 *     GCM failure, logs a warning, and returns the raw ciphertext.
 *   - Bypass sources (seed / job / system) fall back to v1 so
 *     cross-tenant sweeps don't end up encrypting under the wrong
 *     tenant's DEK.
 *   - `Tenant` model queries never resolve a DEK (recursion guard).
 *   - Mixed v1/v2 rows in a single result are handled correctly.
 */

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        warn: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

jest.mock('@/lib/observability/metrics', () => ({
    recordFieldDecryptFailure: jest.fn(),
}));

// Mock the audit-context stack so we can script tenant context for
// specific tests without spinning up the real request pipeline.
const currentAuditCtx: { tenantId?: string; source?: string } = {};
jest.mock('@/lib/audit-context', () => ({
    getAuditContext: () => ({ ...currentAuditCtx }),
}));

// Mock the tenant key manager. We script DEKs per tenantId so the
// test can ask "did we encrypt under tenant A's key?" by attempting
// a decrypt with the same DEK.
const tenantDekMap = new Map<string, Buffer>();
const tenantPreviousDekMap = new Map<string, Buffer>();
const getTenantDekMock = jest.fn(async (tenantId: string) => {
    const dek = tenantDekMap.get(tenantId);
    if (!dek) throw new Error(`no DEK for ${tenantId}`);
    return dek;
});
const getTenantPreviousDekMock = jest.fn(async (tenantId: string) => {
    return tenantPreviousDekMap.get(tenantId) ?? null;
});
jest.mock('@/lib/security/tenant-key-manager', () => ({
    getTenantDek: (tenantId: string) => getTenantDekMock(tenantId),
    getTenantPreviousDek: (tenantId: string) =>
        getTenantPreviousDekMock(tenantId),
}));

import {
    encryptField,
    encryptWithKey,
    decryptField,
    decryptWithKey,
    getCiphertextVersion,
    isEncryptedValue,
} from '@/lib/security/encryption';
import { generateDek } from '@/lib/security/tenant-keys';
import { _internals } from '@/lib/db/encryption-middleware';
import { logger } from '@/lib/observability/logger';
import { recordFieldDecryptFailure } from '@/lib/observability/metrics';

const { walkWriteArgument, walkReadResult, resolveTenantDekPair } = _internals;

// Test helper — wrap a Buffer | null primary DEK in the pair shape
// the read path now expects. Most existing tests don't exercise the
// previous-DEK fallback, so previous is null.
function pair(primary: Buffer | null, previous: Buffer | null = null) {
    // `reason` carries WHY a pair has no primary — 'by-design' (cross-tenant
    // work that is supposed to have no DEK, which now reads back as null)
    // vs 'resolve-failed' (the lookup threw, which still fails open). These
    // fixtures supply a real DEK, so the resolved case is the honest label.
    const reason: 'resolved' | 'by-design' = primary ? 'resolved' : 'by-design';
    return { primary, previous, reason };
}

// Small helper — run a block with a specific audit context in play,
// then reset. Keeps tests independent of ordering.
async function withAuditCtx<T>(
    ctx: { tenantId?: string; source?: string },
    fn: () => Promise<T> | T,
): Promise<T> {
    Object.assign(currentAuditCtx, ctx);
    try {
        return await fn();
    } finally {
        delete currentAuditCtx.tenantId;
        delete currentAuditCtx.source;
    }
}

beforeEach(() => {
    tenantDekMap.clear();
    tenantPreviousDekMap.clear();
    getTenantDekMock.mockClear();
    getTenantPreviousDekMock.mockClear();
    jest.clearAllMocks();
    delete currentAuditCtx.tenantId;
    delete currentAuditCtx.source;
});

describe('resolveTenantDekPair (middleware hook)', () => {
    it('returns empty pair when no audit context is set (v1 fallback)', async () => {
        const deks = await resolveTenantDekPair('Risk');
        expect(deks.primary).toBeNull();
        expect(deks.previous).toBeNull();
    });

    it('returns empty pair for Tenant model regardless of context (recursion guard)', async () => {
        tenantDekMap.set('tenant-A', generateDek());
        await withAuditCtx({ tenantId: 'tenant-A', source: 'api' }, async () => {
            const deks = await resolveTenantDekPair('Tenant');
            expect(deks.primary).toBeNull();
            expect(deks.previous).toBeNull();
        });
        // Most importantly — we never called either side of the manager.
        expect(getTenantDekMock).not.toHaveBeenCalled();
        expect(getTenantPreviousDekMock).not.toHaveBeenCalled();
    });

    it.each(['seed', 'job', 'system'])(
        'returns empty pair for bypass source=%s (v1 fallback, multi-tenant scoped code)',
        async (source) => {
            tenantDekMap.set('tenant-A', generateDek());
            await withAuditCtx(
                { tenantId: 'tenant-A', source },
                async () => {
                    const deks = await resolveTenantDekPair('Risk');
                    expect(deks.primary).toBeNull();
                    expect(deks.previous).toBeNull();
                },
            );
            expect(getTenantDekMock).not.toHaveBeenCalled();
            expect(getTenantPreviousDekMock).not.toHaveBeenCalled();
        },
    );

    it('returns the primary DEK when audit context is a regular api request', async () => {
        const dek = generateDek();
        tenantDekMap.set('tenant-A', dek);
        await withAuditCtx({ tenantId: 'tenant-A', source: 'api' }, async () => {
            const deks = await resolveTenantDekPair('Risk');
            expect(deks.primary).not.toBeNull();
            expect(deks.primary!.equals(dek)).toBe(true);
            expect(deks.previous).toBeNull();
        });
    });

    it('returns BOTH primary and previous DEKs when a rotation is in flight', async () => {
        const primaryDek = generateDek();
        const previousDek = generateDek();
        tenantDekMap.set('tenant-A', primaryDek);
        tenantPreviousDekMap.set('tenant-A', previousDek);
        await withAuditCtx({ tenantId: 'tenant-A', source: 'api' }, async () => {
            const deks = await resolveTenantDekPair('Risk');
            expect(deks.primary!.equals(primaryDek)).toBe(true);
            expect(deks.previous!.equals(previousDek)).toBe(true);
        });
    });

    it('returns empty pair + logs warn when the primary key manager throws', async () => {
        // No DEK set → primary mock throws.
        await withAuditCtx({ tenantId: 'tenant-missing', source: 'api' }, async () => {
            const deks = await resolveTenantDekPair('Risk');
            expect(deks.primary).toBeNull();
            expect(deks.previous).toBeNull();
        });
        expect(logger.warn).toHaveBeenCalledWith(
            'encryption-middleware.dek_resolve_failed',
            expect.objectContaining({ tenantId: 'tenant-missing' }),
        );
    });

    it('survives a previous-DEK lookup throw — primary stays valid', async () => {
        const dek = generateDek();
        tenantDekMap.set('tenant-A', dek);
        getTenantPreviousDekMock.mockImplementationOnce(async () => {
            throw new Error('transient db blip');
        });
        await withAuditCtx({ tenantId: 'tenant-A', source: 'api' }, async () => {
            const deks = await resolveTenantDekPair('Risk');
            expect(deks.primary!.equals(dek)).toBe(true);
            expect(deks.previous).toBeNull();
        });
        expect(logger.warn).toHaveBeenCalledWith(
            'encryption-middleware.previous_dek_resolve_failed',
            expect.objectContaining({ tenantId: 'tenant-A' }),
        );
    });
});

describe('write path — v2 when DEK present, v1 fallback otherwise', () => {
    it('with a tenant DEK, writes produce v2 ciphertext', () => {
        const dek = generateDek();
        const data = { treatmentNotes: 'secret-notes' };
        walkWriteArgument(data, 'Risk', dek);
        expect(getCiphertextVersion(data.treatmentNotes as string)).toBe('v2');
        // Round-trip under the tenant DEK recovers the plaintext.
        expect(decryptWithKey(dek, data.treatmentNotes as string)).toBe(
            'secret-notes',
        );
    });

    it('without a tenant DEK (null), writes produce v1 ciphertext', () => {
        const data = { treatmentNotes: 'fallback-notes' };
        walkWriteArgument(data, 'Risk', null);
        expect(getCiphertextVersion(data.treatmentNotes as string)).toBe('v1');
        expect(decryptField(data.treatmentNotes as string)).toBe(
            'fallback-notes',
        );
    });

    it('nested writes inherit the DEK (comments under a Task create)', () => {
        const dek = generateDek();
        const data = {
            title: 'plain-title',
            description: 'parent-desc',
            comments: {
                create: [{ body: 'c1' }, { body: 'c2' }],
            },
        };
        walkWriteArgument(data, 'Task', dek);
        expect(getCiphertextVersion(data.description as string)).toBe('v2');
        const comments = (data.comments as { create: Array<{ body: string }> })
            .create;
        for (const c of comments) {
            expect(getCiphertextVersion(c.body)).toBe('v2');
            expect(decryptWithKey(dek, c.body)).toMatch(/^c[12]$/);
        }
    });

    it('is idempotent — a value that is already v2 is not double-encrypted', () => {
        const dek = generateDek();
        const already = encryptWithKey(dek, 'already encrypted');
        const data = { treatmentNotes: already };
        walkWriteArgument(data, 'Risk', dek);
        expect(data.treatmentNotes).toBe(already);
    });

    it('is idempotent — a value that is already v1 is not double-encrypted with v2', () => {
        const dek = generateDek();
        const alreadyV1 = encryptField('v1 legacy value');
        const data = { treatmentNotes: alreadyV1 };
        walkWriteArgument(data, 'Risk', dek);
        // Still v1 — mixed-state tolerance.
        expect(data.treatmentNotes).toBe(alreadyV1);
    });
});

describe('read path — per-value dispatch on v1 / v2', () => {
    it('decrypts v2 with the supplied tenant DEK', () => {
        const dek = generateDek();
        const node = {
            treatmentNotes: encryptWithKey(dek, 'notes-under-v2'),
        };
        walkReadResult(node, 'Risk', pair(dek));
        expect(node.treatmentNotes).toBe('notes-under-v2');
    });

    it('decrypts v1 using the global KEK, regardless of the supplied DEK', () => {
        const dek = generateDek();
        const node = {
            treatmentNotes: encryptField('legacy-v1-value'),
        };
        walkReadResult(node, 'Risk', pair(dek));
        expect(node.treatmentNotes).toBe('legacy-v1-value');
    });

    it('handles MIXED v1 + v2 rows in a single findMany result', () => {
        const dek = generateDek();
        const rows = [
            { treatmentNotes: encryptField('v1-row') },
            { treatmentNotes: encryptWithKey(dek, 'v2-row') },
            { treatmentNotes: null },
            { treatmentNotes: 'pre-encryption plaintext legacy' },
        ];
        walkReadResult(rows, 'Risk', pair(dek));
        expect(rows[0].treatmentNotes).toBe('v1-row');
        expect(rows[1].treatmentNotes).toBe('v2-row');
        expect(rows[2].treatmentNotes).toBeNull();
        expect(rows[3].treatmentNotes).toBe(
            'pre-encryption plaintext legacy',
        );
    });

    it('included relations inherit the DEK on recursive decrypt', () => {
        const dek = generateDek();
        const row = {
            description: encryptWithKey(dek, 'parent-desc'),
            comments: [
                { body: encryptWithKey(dek, 'comment-1') },
                { body: encryptWithKey(dek, 'comment-2') },
            ],
        };
        walkReadResult(row, 'Task', pair(dek));
        expect(row.description).toBe('parent-desc');
        expect(row.comments[0].body).toBe('comment-1');
        expect(row.comments[1].body).toBe('comment-2');
    });

    it('v2 with no DEK BY DESIGN — returns NULL, never throws', () => {
        const dek = generateDek();
        const node = {
            treatmentNotes: encryptWithKey(dek, 'should-not-decrypt'),
        };
        // `pair(null)` is the cross-tenant read: no tenant DEK, by design.
        expect(() => walkReadResult(node, 'Risk', pair(null))).not.toThrow();
        expect(node.treatmentNotes).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            'encryption-middleware.decrypt_failed',
            expect.objectContaining({
                version: 'v2',
                field: 'treatmentNotes',
                outcome: 'no_dek_by_design',
            }),
        );
        // Counted, not just logged — a warn nobody is alerted on is not a
        // control. The `outcome` label is what makes a genuine key mismatch
        // visible instead of hiding inside routine by-design noise.
        expect(recordFieldDecryptFailure).toHaveBeenCalledWith({
            model: 'Risk',
            field: 'treatmentNotes',
            version: 'v2',
            outcome: 'no_dek_by_design',
        });
    });

    it('the ciphertext NEVER reaches the caller on the by-design path', () => {
        // This replaces a test that pinned the opposite ("the returned value
        // is the CIPHERTEXT itself — the fail-open contract"), which said in
        // its own comment that it was the executable record of what the
        // system did, not an endorsement, and should be rewritten if the
        // posture changed. It has.
        //
        // WHY THIS IS THE CONTRACT THAT MATTERS: the caller received a
        // `string` it could not distinguish from plaintext, so a `v2:`-
        // prefixed blob flowed on to every consumer of the row — the UI, PDF
        // exports, audit-pack share links, SDK readers. For a product whose
        // rows land in evidence artefacts, an unreadable blob rendered as if
        // it were content is worse than an absent value.
        const dek = generateDek();
        const secret = 'operator wrote this';
        const node = { treatmentNotes: encryptWithKey(dek, secret) };
        const original = node.treatmentNotes;

        walkReadResult(node, 'Risk', pair(null));

        expect(node.treatmentNotes).toBeNull();
        expect(node.treatmentNotes).not.toBe(original);
        expect(node.treatmentNotes).not.toBe(secret);
    });

    it('a FAILED DEK lookup still falls open to the ciphertext', () => {
        // The other half of the split, and the reason it exists. A tenantId
        // WAS present and the lookup threw — a transient DB blip, or a
        // tenant with no `encryptedDek` row. Nulling every encrypted field
        // on a page for that is its own outage, and unlike the by-design
        // case there is a legitimate reader waiting for the value.
        const dek = generateDek();
        const node = { treatmentNotes: encryptWithKey(dek, 'still-needed') };
        const original = node.treatmentNotes;

        walkReadResult(node, 'Risk', {
            primary: null,
            previous: null,
            reason: 'resolve-failed',
        });

        expect(node.treatmentNotes).toBe(original);
        expect(recordFieldDecryptFailure).toHaveBeenCalledWith({
            model: 'Risk',
            field: 'treatmentNotes',
            version: 'v2',
            outcome: 'dek_resolve_failed',
        });
    });

    it('a decrypt failure WITH a DEK THROWS — fail closed', () => {
        // Wrong key, corrupt row, or a write made under a mismatched tenant
        // context. A DEK was in hand and AES-GCM still rejected the value, so
        // this is an integrity anomaly about the DATA, not the key lookup.
        //
        // There is no safe continuation: either the ciphertext reaches an
        // unknown consumer or the request stops. For a product whose rows land
        // in audit packs and PDF exports, stopping is correct AND recoverable
        // (fix the row); silent ciphertext contaminates exports indefinitely
        // and nobody learns.
        const writtenUnder = generateDek();
        const readWith = generateDek(); // different key — AES-GCM auth fails
        const node = { treatmentNotes: encryptWithKey(writtenUnder, 'v') };

        expect(() => walkReadResult(node, 'Risk', pair(readWith))).toThrow(
            /failed to decrypt Risk\.treatmentNotes/,
        );
        expect(recordFieldDecryptFailure).toHaveBeenCalledWith({
            model: 'Risk',
            field: 'treatmentNotes',
            version: 'v2',
            outcome: 'decrypt_failed',
        });
    });

    it('the thrown error carries coordinates but NEVER the value', () => {
        // The message reaches logs and, through the API error wrapper, can
        // reach a client. Leaking the plaintext it failed on — or the
        // ciphertext — would turn an integrity signal into a disclosure.
        const writtenUnder = generateDek();
        const readWith = generateDek();
        const secret = 'operator wrote this';
        const node = { treatmentNotes: encryptWithKey(writtenUnder, secret) };
        const ciphertext = node.treatmentNotes;

        let caught: unknown;
        try {
            walkReadResult(node, 'Risk', pair(readWith));
        } catch (e) {
            caught = e;
        }
        const msg = (caught as Error).message;
        expect(msg).toContain('Risk.treatmentNotes');
        expect(msg).toContain('v2');
        expect(msg).not.toContain(secret);
        expect(msg).not.toContain(ciphertext);
    });

    it('the kill-switch restores the fail-open behaviour without a redeploy', () => {
        // The lever an operator needs at 3am when one corrupt row is 500ing a
        // list page. Documented in docs/epic-b-encryption.md.
        const prev = process.env.ENCRYPTION_DECRYPT_FAIL_CLOSED;
        process.env.ENCRYPTION_DECRYPT_FAIL_CLOSED = '0';
        jest.resetModules();
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { _internals } = require('@/lib/db/encryption-middleware');
            const writtenUnder = generateDek();
            const readWith = generateDek();
            const node = { treatmentNotes: encryptWithKey(writtenUnder, 'v') };
            const original = node.treatmentNotes;
            expect(() =>
                _internals.walkReadResult(node, 'Risk', pair(readWith)),
            ).not.toThrow();
            expect(node.treatmentNotes).toBe(original);
        } finally {
            if (prev === undefined) delete process.env.ENCRYPTION_DECRYPT_FAIL_CLOSED;
            else process.env.ENCRYPTION_DECRYPT_FAIL_CLOSED = prev;
            jest.resetModules();
        }
    });

    it('a DEK-resolve FAILURE still falls open — infra flap is not a data anomaly', () => {
        // Unchanged, and the distinction is the point: a tenantId WAS present
        // and the lookup threw. Failing an entire page over a transient DB
        // blip is its own outage, and unlike the by-design case there is a
        // legitimate reader waiting for the value.
        const dek = generateDek();
        const node = { treatmentNotes: encryptWithKey(dek, 'still-needed') };
        const original = node.treatmentNotes;

        expect(() =>
            walkReadResult(node, 'Risk', {
                primary: null,
                previous: null,
                reason: 'resolve-failed',
            }),
        ).not.toThrow();
        expect(node.treatmentNotes).toBe(original);
    });
});

describe('mid-rotation read fallback to previous DEK', () => {
    it('decrypts a v2 row written under the PREVIOUS DEK using the fallback', () => {
        const previousDek = generateDek();
        const newPrimaryDek = generateDek();
        // Row was written before the rotation — under the (now)
        // previous DEK.
        const oldRow = {
            treatmentNotes: encryptWithKey(previousDek, 'pre-rotation-value'),
        };
        // Reader has the new primary DEK + the previous (mid-rotation
        // pair). The middleware's decryptValue falls back on AES-GCM
        // auth failure.
        walkReadResult(oldRow, 'Risk', pair(newPrimaryDek, previousDek));
        expect(oldRow.treatmentNotes).toBe('pre-rotation-value');
    });

    it('mixed batch of pre- and post-rotation rows decrypts cleanly under the pair', () => {
        const previousDek = generateDek();
        const newPrimaryDek = generateDek();
        const rows = [
            {
                treatmentNotes: encryptWithKey(previousDek, 'pre-row'),
            },
            {
                treatmentNotes: encryptWithKey(newPrimaryDek, 'post-row'),
            },
        ];
        walkReadResult(rows, 'Risk', pair(newPrimaryDek, previousDek));
        expect(rows[0].treatmentNotes).toBe('pre-row');
        expect(rows[1].treatmentNotes).toBe('post-row');
    });

    it('without a previous DEK, a stale pre-rotation row now THROWS', () => {
        // OPERATIONAL CONSEQUENCE OF FAILING CLOSED, stated plainly because it
        // is the one that can bite: if `Tenant.previousEncryptedDek` is
        // cleared while rows written under the old DEK have NOT yet been
        // swept, reading one of those rows 500s instead of rendering a
        // ciphertext blob.
        //
        // That is the intended trade — a blob in an audit pack is worse than a
        // failed request — but it makes the rotation ORDER load-bearing:
        // `previousEncryptedDek` must stay populated until the sweep reports
        // zero remaining. See docs/epic-b-encryption.md.
        const previousDek = generateDek();
        const newPrimaryDek = generateDek();
        const oldRow = {
            treatmentNotes: encryptWithKey(previousDek, 'pre-rotation-value'),
        };

        expect(() => walkReadResult(oldRow, 'Risk', pair(newPrimaryDek, null))).toThrow(
            /failed to decrypt Risk\.treatmentNotes/,
        );
        expect(logger.warn).toHaveBeenCalledWith(
            'encryption-middleware.decrypt_failed',
            expect.objectContaining({ version: 'v2', outcome: 'decrypt_failed' }),
        );
    });
});

describe('cross-tenant isolation', () => {
    it("tenant A's v2 ciphertext is NOT decryptable with tenant B's DEK", () => {
        const dekA = generateDek();
        const dekB = generateDek();
        expect(dekA.equals(dekB)).toBe(false); // sanity

        const aCipher = encryptWithKey(dekA, 'tenant-A-secret');
        const node = { treatmentNotes: aCipher };

        // Reader has tenant B's DEK only — GCM tag should fail.
        //
        // Fail-CLOSED strengthens this invariant rather than changing it. The
        // property is "B never obtains A's plaintext"; previously B got A's
        // ciphertext back as a `string` it could forward anywhere, now the
        // read stops. The node is left untouched either way.
        expect(() => walkReadResult(node, 'Risk', pair(dekB))).toThrow(
            /failed to decrypt/,
        );
        expect(node.treatmentNotes).toBe(aCipher);
        expect(node.treatmentNotes).not.toContain('tenant-A-secret');
        expect(logger.warn).toHaveBeenCalledWith(
            'encryption-middleware.decrypt_failed',
            expect.objectContaining({ version: 'v2' }),
        );
    });

    it('two tenants writing the same plaintext produce different ciphertexts', () => {
        const dekA = generateDek();
        const dekB = generateDek();
        const plaintext = 'identical value';
        const a = { treatmentNotes: plaintext };
        const b = { treatmentNotes: plaintext };
        walkWriteArgument(a, 'Risk', dekA);
        walkWriteArgument(b, 'Risk', dekB);
        expect(a.treatmentNotes).not.toBe(b.treatmentNotes);
        // Each is only decryptable with its own DEK.
        expect(decryptWithKey(dekA, a.treatmentNotes as string)).toBe(plaintext);
        expect(decryptWithKey(dekB, b.treatmentNotes as string)).toBe(plaintext);
        // Swapping keys does NOT produce plaintext — verified by the
        // GCM auth failure (thrown by decryptWithKey, not swallowed).
        expect(() =>
            decryptWithKey(dekA, b.treatmentNotes as string),
        ).toThrow();
    });

    it('isEncryptedValue recognises BOTH v1 and v2 so idempotency gates work across tenants', () => {
        const dekA = generateDek();
        const v1 = encryptField('v1');
        const v2 = encryptWithKey(dekA, 'v2');
        expect(isEncryptedValue(v1)).toBe(true);
        expect(isEncryptedValue(v2)).toBe(true);
        expect(isEncryptedValue('not an envelope')).toBe(false);
        expect(isEncryptedValue(null)).toBe(false);
    });
});

describe('never leaks DEK material or plaintext in logs', () => {
    it('decrypt failure logs carry no plaintext and no DEK bytes', () => {
        const dek = generateDek();
        const plaintext = 'SECRET_SAUCE_xyz_123';
        const node = {
            // v2 ciphertext, but we pass a different DEK to force a
            // GCM tag failure.
            treatmentNotes: encryptWithKey(dek, plaintext),
        };
        const wrongDek = generateDek();
        // Fail-closed: the read throws. The log line is still emitted first,
        // and it is the log line under test — so catch and assert on it.
        let thrown: unknown;
        try {
            walkReadResult(node, 'Risk', pair(wrongDek));
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(Error);
        // The THROWN MESSAGE is a new disclosure surface — it reaches logs and
        // can reach a client through the API error wrapper. Hold it to the
        // same bar as the log line.
        const msg = (thrown as Error).message;
        expect(msg).not.toContain(plaintext);
        expect(msg).not.toContain(dek.toString('hex'));
        expect(msg).not.toContain(node.treatmentNotes as string);

        // Every warn call should be value-free.
        const allLogs = JSON.stringify(
            (logger.warn as jest.Mock).mock.calls,
        );
        expect(allLogs).not.toContain(plaintext);
        expect(allLogs).not.toContain(dek.toString('hex'));
        expect(allLogs).not.toContain(dek.toString('base64'));
        expect(allLogs).not.toContain(wrongDek.toString('hex'));
    });
});
