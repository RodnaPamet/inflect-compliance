/**
 * Branch coverage for the parts of the Epic B encryption extension the
 * existing three suites never reach.
 *
 * `encryption-middleware.test.ts` drives the traversal helpers directly and
 * `encryption-middleware.tenant-dek.test.ts` drives the v1/v2 key dispatch.
 * Neither exercises:
 *
 *   - the `$allOperations` dispatch itself beyond `create` — the `upsert`
 *     arm (which walks `args.create` AND `args.update`, not `args.data`),
 *     and the neither-write-nor-read arm that must resolve no DEK at all;
 *   - the `*` fan-out arms, taken whenever the model is absent from the
 *     manifest but the payload/row still carries a manifest field NAME;
 *   - `connectOrCreate.create`, the one nested-write shape with no test;
 *   - the traversal guards that stop a walk early (scalar payload, array
 *     `data`, a manifest key holding an object).
 *
 * Every one of those is a silent failure: the operation succeeds, the row is
 * written, and the value is simply the wrong side of the encryption boundary.
 */

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        warn: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

const recordTenantContextMismatchMock =
    jest.fn<void, [{ model: string; operation: string; outcome: string }]>();
jest.mock('@/lib/observability/metrics', () => ({
    recordFieldDecryptFailure: jest.fn(),
    recordTenantContextMismatch: (attrs: {
        model: string;
        operation: string;
        outcome: string;
    }) => recordTenantContextMismatchMock(attrs),
}));

import { encryptField, isEncryptedValue } from '@/lib/security/encryption';
import { _internals, withEncryptionExtension } from '@/lib/db/encryption-middleware';

const { walkWriteArgument, walkReadResult, checkWriteTenantContext } = _internals;

/**
 * The no-tenant-DEK pair, `by-design`. Every test here runs without an audit
 * context, so the middleware falls back to the global KEK (v1) — which is
 * what makes `encryptField` / `isEncryptedValue` usable as the oracle.
 */
const NO_DEKS = { primary: null, previous: null, reason: 'by-design' } as const;

// ─── Harness ──────────────────────────────────────────────────────────
//
// Capture the `$allOperations` handler the extension registers, so a test can
// drive one Prisma operation end to end without a database.

interface OpParams {
    model: string;
    operation: string;
    args?: unknown;
    query: (a: unknown) => Promise<unknown>;
}
type Op = (p: OpParams) => Promise<unknown>;

function captureHandler(): Op {
    let captured: Op | null = null;
    const fake = {
        $extends: (cfg: unknown): unknown => {
            captured = (
                cfg as { query: { $allModels: { $allOperations: Op } } }
            ).query.$allModels.$allOperations;
            return fake;
        },
    };
    withEncryptionExtension(fake);
    if (!captured) throw new Error('extension registered no $allOperations handler');
    return captured;
}

/** Deep clone so the result-decrypt pass cannot mutate the write snapshot. */
function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
}

beforeEach(() => {
    recordTenantContextMismatchMock.mockClear();
});

// ══════════════════════════════════════════════════════════════════════
// $allOperations dispatch
// ══════════════════════════════════════════════════════════════════════

describe('withEncryptionExtension — the upsert arm', () => {
    it('encrypts BOTH args.create and args.update, neither of which is args.data', async () => {
        // `upsert` is the only operation whose payload lives under two keys.
        // A dispatch that only looked at `args.data` would write BOTH halves
        // of every upsert as plaintext and never fail anything.
        const handler = captureHandler();
        let seen: { create: { threat: string }; update: { threat: string } } | undefined;
        const query = jest.fn(async (args: unknown): Promise<unknown> => {
            seen = clone(args) as typeof seen;
            return null;
        });

        await handler({
            model: 'Risk',
            operation: 'upsert',
            args: {
                where: { id: 'r1' },
                create: { threat: 'insider exfiltration' },
                update: { threat: 'ransomware' },
            },
            query,
        });

        expect(isEncryptedValue(seen!.create.threat)).toBe(true);
        expect(isEncryptedValue(seen!.update.threat)).toBe(true);
        expect(seen!.create.threat).not.toContain('insider');
        expect(seen!.update.threat).not.toContain('ransomware');
    });

    it('tolerates an upsert that supplies only one half', async () => {
        const handler = captureHandler();
        let seen: { create: { threat: string } } | undefined;
        const query = jest.fn(async (args: unknown): Promise<unknown> => {
            seen = clone(args) as typeof seen;
            return null;
        });

        await handler({
            model: 'Risk',
            operation: 'upsert',
            args: { where: { id: 'r1' }, create: { threat: 'phishing' } },
            query,
        });

        expect(isEncryptedValue(seen!.create.threat)).toBe(true);
    });
});

describe('withEncryptionExtension — operations that are neither write nor read', () => {
    it('forwards a delete untouched and decrypts nothing on the way back', async () => {
        // `delete` is absent from BOTH action sets. If it leaked into the read
        // set the returned row would be decrypted under a DEK the operation
        // never resolved; if it leaked into the write set the `where` clause
        // would be walked. Both are silent.
        const handler = captureHandler();
        const ciphertext = encryptField('deleted risk notes');
        const argsIn = { where: { id: 'r1' } };
        const query = jest.fn(async (): Promise<unknown> => ({
            id: 'r1',
            treatmentNotes: ciphertext,
        }));

        const result = (await handler({
            model: 'Risk',
            operation: 'delete',
            args: argsIn,
            query,
        })) as { treatmentNotes: string };

        expect(query).toHaveBeenCalledWith(argsIn);
        expect(result.treatmentNotes).toBe(ciphertext);
    });

    it('forwards a count untouched', async () => {
        const handler = captureHandler();
        const query = jest.fn(async (): Promise<unknown> => 7);

        const result = await handler({
            model: 'Risk',
            operation: 'count',
            args: { where: { status: 'OPEN' } },
            query,
        });

        expect(result).toBe(7);
    });
});

describe('withEncryptionExtension — the `*` fan-out arm for unmanifested models', () => {
    it('decrypts a manifest FIELD NAME on a model that is not itself in the manifest', async () => {
        // Raw-relation reads and `$queryRaw`-shaped results arrive under a
        // model the manifest does not list. The fan-out is what keeps the
        // ciphertext from reaching the caller as a `v1:`-prefixed string that
        // reads like ordinary text all the way into a PDF export.
        const handler = captureHandler();
        const query = jest.fn(async (): Promise<unknown> => [
            { id: 'x1', treatmentNotes: encryptField('fan-out plaintext') },
        ]);

        const rows = (await handler({
            model: 'Framework',
            operation: 'findMany',
            args: {},
            query,
        })) as Array<{ treatmentNotes: string }>;

        expect(rows[0].treatmentNotes).toBe('fan-out plaintext');
    });

    it('encrypts a manifest FIELD NAME written through an unmanifested model', async () => {
        const handler = captureHandler();
        let seen: { data: { treatmentNotes: string; name: string } } | undefined;
        const query = jest.fn(async (args: unknown): Promise<unknown> => {
            seen = clone(args) as typeof seen;
            return null;
        });

        await handler({
            model: 'Framework',
            operation: 'create',
            args: { data: { name: 'ISO 27001', treatmentNotes: 'secret note' } },
            query,
        });

        expect(isEncryptedValue(seen!.data.treatmentNotes)).toBe(true);
        expect(seen!.data.name).toBe('ISO 27001');
    });

    it('leaves an unmanifested model with no manifest field names entirely alone', async () => {
        // The `nodeHasAnyEncryptedFieldKey` fast path. A regression that
        // dropped it would still be correct — just slower — so the assertion
        // is on the OUTPUT identity, which is what callers depend on.
        const handler = captureHandler();
        let seen: { data: Record<string, unknown> } | undefined;
        const query = jest.fn(async (args: unknown): Promise<unknown> => {
            seen = clone(args) as typeof seen;
            return null;
        });

        await handler({
            model: 'Framework',
            operation: 'create',
            args: { data: { name: 'ISO 27001', version: '2022' } },
            query,
        });

        expect(seen!.data).toStrictEqual({ name: 'ISO 27001', version: '2022' });
    });
});

// ══════════════════════════════════════════════════════════════════════
// Write traversal — the shapes with no existing test
// ══════════════════════════════════════════════════════════════════════

describe('walkWriteArgument — connectOrCreate', () => {
    it('encrypts the create half of a connectOrCreate nest', async () => {
        // The one nested-write shape the traversal handles that nothing
        // covers. Prisma only runs the `create` half when the connect misses,
        // so a miss here writes plaintext on a code path that fires rarely —
        // the worst kind to leave unguarded.
        const payload = {
            title: 'T',
            risk: {
                connectOrCreate: {
                    where: { id: 'r1' },
                    create: { treatmentNotes: 'connect-or-create notes' },
                },
            },
        };

        walkWriteArgument(payload, 'Task', null);

        expect(
            isEncryptedValue(payload.risk.connectOrCreate.create.treatmentNotes),
        ).toBe(true);
    });

    it('does not treat the connectOrCreate `where` clause as a payload', () => {
        const payload = {
            risk: {
                connectOrCreate: {
                    where: { treatmentNotes: 'lookup value' },
                    create: { threat: 'x' },
                },
            },
        };

        walkWriteArgument(payload, 'Task', null);

        expect(payload.risk.connectOrCreate.where.treatmentNotes).toBe('lookup value');
    });

    it('is a no-op when connectOrCreate carries no create half', () => {
        const payload = { risk: { connectOrCreate: { where: { id: 'r1' } } } };
        walkWriteArgument(payload, 'Task', null);
        expect(payload).toStrictEqual({ risk: { connectOrCreate: { where: { id: 'r1' } } } });
    });
});

describe('walkWriteArgument — payloads that are not walkable', () => {
    it('returns without touching a scalar payload', () => {
        // Reached through nested fan-out, where a relation value can be a
        // string. The guard is the reason this does not throw.
        expect(() => walkWriteArgument('a bare string', 'Risk', null)).not.toThrow();
        expect(() => walkWriteArgument(42, 'Risk', null)).not.toThrow();
        expect(() => walkWriteArgument(null, 'Risk', null)).not.toThrow();
        expect(() => walkWriteArgument(undefined, 'Risk', null)).not.toThrow();
    });

    it('walks every element of an array payload, not just the first', () => {
        const rows = [
            { threat: 'one' },
            { threat: 'two' },
            { threat: 'three' },
        ];
        walkWriteArgument(rows, 'Risk', null);
        expect(rows.map((r) => isEncryptedValue(r.threat))).toStrictEqual([
            true,
            true,
            true,
        ]);
    });
});

// ══════════════════════════════════════════════════════════════════════
// Read traversal — the relation-descent guard
// ══════════════════════════════════════════════════════════════════════

describe('walkReadResult — the manifest-key descent guard', () => {
    it('does NOT descend into a relation whose key is also a manifest field of this model', () => {
        // `Risk.threat` is a manifest field. A row that carries an OBJECT
        // under `threat` (an included relation named the same as a scalar in
        // another shape) must not be re-walked as `*`, or the fan-out would
        // encrypt/decrypt the relation's own columns under the parent's rules.
        const inner = { treatmentNotes: encryptField('inner value') };
        const row: Record<string, unknown> = { id: 'r1', threat: inner };

        walkReadResult(row, 'Risk', NO_DEKS);

        // Untouched: still the ciphertext, because the walk never descended.
        expect((row.threat as { treatmentNotes: string }).treatmentNotes).toBe(
            inner.treatmentNotes,
        );
        expect(isEncryptedValue((row.threat as { treatmentNotes: string }).treatmentNotes)).toBe(
            true,
        );
    });

    it('DOES descend into a relation whose key is not a manifest field', () => {
        const row: Record<string, unknown> = {
            id: 'r1',
            comments: [{ body: encryptField('a comment') }],
        };

        walkReadResult(row, 'Risk', NO_DEKS);

        expect((row.comments as Array<{ body: string }>)[0].body).toBe('a comment');
    });

    it('treats a null deks argument as the by-design no-DEK pair', () => {
        // The back-compat overload. Passing `null` must behave exactly like
        // the by-design sentinel, not throw on `deks.primary`.
        const row: Record<string, unknown> = { treatmentNotes: encryptField('legacy call shape') };
        walkReadResult(row, 'Risk', null);
        expect(row.treatmentNotes).toBe('legacy call shape');
    });

    it('ignores a scalar result entirely', () => {
        expect(() => walkReadResult('scalar', 'Risk', NO_DEKS)).not.toThrow();
        expect(() => walkReadResult(12, 'Risk', NO_DEKS)).not.toThrow();
    });
});

// ══════════════════════════════════════════════════════════════════════
// checkWriteTenantContext — the shapes it must stay silent on
// ══════════════════════════════════════════════════════════════════════

describe('checkWriteTenantContext — non-row payloads', () => {
    it('says nothing about an ARRAY payload (createMany.data)', () => {
        // `createMany` hands the hook a list, not a row. Reading `.tenantId`
        // off an array yields undefined, so without the Array guard the
        // detector would silently never fire for the one operation that writes
        // the most rows — and would look identical to "no mismatches found".
        checkWriteTenantContext(
            [{ tenantId: 'tenant-B', threat: 'x' }],
            'Risk',
            'createMany',
        );
        expect(recordTenantContextMismatchMock).not.toHaveBeenCalled();
    });

    it('says nothing about a null or scalar payload', () => {
        checkWriteTenantContext(null, 'Risk', 'create');
        checkWriteTenantContext('nonsense', 'Risk', 'create');
        expect(recordTenantContextMismatchMock).not.toHaveBeenCalled();
    });

    it('says nothing when tenantId is present but empty', () => {
        checkWriteTenantContext({ tenantId: '', threat: 'x' }, 'Risk', 'create');
        expect(recordTenantContextMismatchMock).not.toHaveBeenCalled();
    });

    it('reports an unscoped write on a MANIFEST model that encrypts something', () => {
        // The positive control for the three negatives above: with the same
        // absent ambient context, a real row DOES report. Without this, all
        // four assertions would still pass if the detector were deleted.
        checkWriteTenantContext({ tenantId: 'tenant-B', threat: 'x' }, 'Risk', 'create');
        expect(recordTenantContextMismatchMock).toHaveBeenCalledWith({
            model: 'Risk',
            operation: 'create',
            outcome: 'unscoped',
        });
    });

    it('stays silent for a manifest model whose payload touches no manifest field', () => {
        checkWriteTenantContext(
            { tenantId: 'tenant-B', status: 'OPEN', title: 'T' },
            'Risk',
            'create',
        );
        expect(recordTenantContextMismatchMock).not.toHaveBeenCalled();
    });
});
