/**
 * Branch coverage for the parts of `src/lib/security/pii-middleware.ts`
 * that `pii-middleware-hash-rewriter.test.ts` does not reach.
 *
 * That file covers the WHERE rewriter and single-row create/read. What
 * it leaves untested is every SHAPE the middleware has to recognise:
 *
 *   - `createMany` — a bulk insert whose rows are NOT encrypted would
 *     put plaintext PII straight into the column, and no read-side test
 *     would notice because the plaintext reads back fine.
 *   - The legacy dual-write branch (`mapped: false` models like
 *     `VendorContact` / `Account`) — a different line of `encryptOnWrite`
 *     entirely from the `@map`'d one.
 *   - Nested relation decryption through ARRAYS (`tenant.memberships[]
 *     .user`) and top-level `findMany` arrays.
 *   - The `NOT: { … }` compound WHERE clause in its object (non-array)
 *     form.
 *   - `withPiiEncryptionExtension` — the Prisma-7 `$extends` adapter
 *     that is the ONLY wiring production actually uses; the legacy
 *     `piiEncryptionMiddleware` export exists for these tests.
 *
 * Real encryption is used throughout (as the sibling file does) — the
 * dev fallback key is deterministic enough for `hashForLookup`, and
 * ciphertext is asserted via `isEncryptedValue` + a decrypt round trip
 * rather than by comparing bytes.
 */
import {
    piiEncryptionMiddleware,
    withPiiEncryptionExtension,
    _getPiiFieldMap,
    _rewriteWhereForHash,
} from '@/lib/security/pii-middleware';
import {
    hashForLookup,
    encryptField,
    decryptField,
    isEncryptedValue,
} from '@/lib/security/encryption';

type MiddlewareParams = {
    action: string;
    model?: string;
    args: { data?: unknown; create?: unknown; update?: unknown; where?: unknown };
    dataPath?: unknown;
    runInTransaction?: boolean;
};

/**
 * Run the middleware and hand back BOTH what Prisma would have been
 * given and what the caller received. Typed explicitly rather than
 * inferred from a bare `jest.fn()`.
 */
async function run(
    params: MiddlewareParams,
    dbResult: unknown = null,
): Promise<{ sent: MiddlewareParams; received: unknown }> {
    let sent: MiddlewareParams | undefined;
    const next = async (p: MiddlewareParams): Promise<unknown> => {
        // Snapshot the reference — the middleware mutates args in place.
        sent = p;
        return dbResult;
    };
    const received = await piiEncryptionMiddleware(params, next);
    if (!sent) throw new Error('next() was never called');
    return { sent, received };
}

// ─── createMany ─────────────────────────────────────────────────────

describe('createMany — bulk inserts must not bypass encryption', () => {
    it('encrypts and hashes EVERY row of a User createMany', async () => {
        const { sent } = await run({
            model: 'User',
            action: 'createMany',
            args: { data: [{ email: 'a@b.com', name: 'Alice' }, { email: 'c@d.com' }] },
        });

        const rows = sent.args.data as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(isEncryptedValue(row.email as string)).toBe(true);
        }
        // Hash column is what every later lookup joins on; a row inserted
        // without it becomes permanently unfindable by address.
        expect(rows[0].emailHash).toBe(hashForLookup('a@b.com'));
        expect(rows[1].emailHash).toBe(hashForLookup('c@d.com'));
        expect(decryptField(rows[0].email as string)).toBe('a@b.com');
        expect(decryptField(rows[0].name as string)).toBe('Alice');
    });

    it('skips a non-object row rather than throwing mid-batch', async () => {
        const { sent } = await run({
            model: 'User',
            action: 'createMany',
            args: { data: [null, { email: 'a@b.com' }] },
        });
        const rows = sent.args.data as Array<Record<string, unknown> | null>;
        expect(rows[0]).toBeNull();
        expect(rows[1]?.emailHash).toBe(hashForLookup('a@b.com'));
    });

    it('leaves a non-array createMany payload untouched', async () => {
        const { sent } = await run({
            model: 'User',
            action: 'createMany',
            args: { data: { email: 'a@b.com' } },
        });
        // Not an array → the bulk branch must not run. Prisma will reject
        // the shape itself; the middleware must not corrupt it first.
        expect((sent.args.data as Record<string, unknown>).email).toBe('a@b.com');
    });
});

// ─── Legacy dual-write models (mapped: false) ───────────────────────

describe('legacy dual-write models', () => {
    it('KEEPS the plaintext column and writes ciphertext alongside it', async () => {
        const { sent } = await run({
            model: 'VendorContact',
            action: 'create',
            args: { data: { name: 'Ada', email: 'ada@vendor.com', phone: '+15550001' } },
        });

        const data = sent.args.data as Record<string, unknown>;
        // Plaintext survives — the column still exists on this model, and
        // dropping it here would break every existing read.
        expect(data.name).toBe('Ada');
        expect(data.email).toBe('ada@vendor.com');
        // ...and the encrypted sibling column is populated.
        expect(isEncryptedValue(data.nameEncrypted as string)).toBe(true);
        expect(decryptField(data.emailEncrypted as string)).toBe('ada@vendor.com');
        expect(decryptField(data.phoneEncrypted as string)).toBe('+15550001');
        expect(data.emailHash).toBe(hashForLookup('ada@vendor.com'));
    });

    it('does NOT rewrite a WHERE on a legacy model — the plaintext column is real', async () => {
        // Rewriting to emailHash here would be wrong: the plaintext column
        // still exists and is what the query should match.
        const where = _rewriteWhereForHash(
            { email: 'ada@vendor.com' },
            'VendorContact',
        );
        expect(where).toStrictEqual({ email: 'ada@vendor.com' });
    });

    it('encrypts OAuth tokens on Account without a hash column', async () => {
        const { sent } = await run({
            model: 'Account',
            action: 'update',
            args: { data: { access_token: 'at-123', refresh_token: 'rt-456' } },
        });
        const data = sent.args.data as Record<string, unknown>;
        expect(decryptField(data.accessTokenEncrypted as string)).toBe('at-123');
        expect(decryptField(data.refreshTokenEncrypted as string)).toBe('rt-456');
        // No hash spec on these fields — an invented hash column would be
        // a Prisma "unknown field" error at runtime.
        expect(data).not.toHaveProperty('accessTokenHash');
    });

    it('ignores a non-string or empty value rather than encrypting it', async () => {
        const { sent } = await run({
            model: 'User',
            action: 'create',
            args: { data: { email: '', name: 42, emailHash: undefined } },
        });
        const data = sent.args.data as Record<string, unknown>;
        // Empty string and non-strings are skipped: encrypting them would
        // make `''` unrecoverable and stringify a number silently.
        expect(data.email).toBe('');
        expect(data.name).toBe(42);
        expect(data.emailHash).toBeUndefined();
    });
});

// ─── Read-side decryption shapes ────────────────────────────────────

describe('decryption — result shapes', () => {
    const cipherEmail = encryptField('nested@example.com');
    const cipherName = encryptField('Nested User');

    it('decrypts every element of a top-level findMany array', async () => {
        const { received } = await run(
            { model: 'User', action: 'findMany', args: {} },
            [
                { id: 'u1', email: cipherEmail, name: cipherName },
                null,
                { id: 'u2', email: cipherEmail },
            ],
        );
        const rows = received as Array<Record<string, unknown> | null>;
        expect(rows[0]?.email).toBe('nested@example.com');
        expect(rows[0]?.name).toBe('Nested User');
        // A null element must not abort the loop for the rows after it.
        expect(rows[1]).toBeNull();
        expect(rows[2]?.email).toBe('nested@example.com');
    });

    it('decrypts a managed relation nested inside an ARRAY of a non-managed model', async () => {
        // OrgMembership is not itself managed, so the ONLY reason its
        // `user` relation comes back readable is the nested walk.
        const { received } = await run(
            { model: 'Tenant', action: 'findUnique', args: {} },
            {
                id: 't1',
                memberships: [
                    { id: 'm1', user: { id: 'u1', email: cipherEmail } },
                    { id: 'm2', user: { id: 'u2', email: cipherEmail } },
                ],
            },
        );
        const tenant = received as {
            memberships: Array<{ user: { email: string } }>;
        };
        expect(tenant.memberships[0].user.email).toBe('nested@example.com');
        expect(tenant.memberships[1].user.email).toBe('nested@example.com');
    });

    it('decrypts an aliased relation key (inviter → User)', async () => {
        const { received } = await run(
            { model: 'TenantInvite', action: 'findFirst', args: {} },
            { id: 'i1', inviter: { id: 'u1', email: cipherEmail } },
        );
        expect((received as { inviter: { email: string } }).inviter.email).toBe(
            'nested@example.com',
        );
    });

    it('leaves an unmapped relation key alone (no over-eager walking)', async () => {
        const { received } = await run(
            { model: 'Tenant', action: 'findUnique', args: {} },
            { id: 't1', billingAccount: { id: 'b1', email: cipherEmail } },
        );
        // `billingAccount` is not in RELATION_KEY_TO_MODEL, so its `email`
        // is not a managed field and must come back untouched.
        expect(
            (received as { billingAccount: { email: string } }).billingAccount.email,
        ).toBe(cipherEmail);
    });
});

// ─── Legacy read path (mapped: false) ───────────────────────────────

describe('decryption — legacy dual-write models', () => {
    it('decrypts the encrypted sibling column INTO the plaintext field', async () => {
        // On a legacy model the caller reads `contact.email`, which is
        // the stale dual-write plaintext until this branch overwrites it
        // with the authoritative decrypted value.
        const { received } = await run(
            { model: 'VendorContact', action: 'findFirst', args: {} },
            {
                id: 'vc1',
                email: 'stale@vendor.com',
                emailEncrypted: encryptField('current@vendor.com'),
                name: 'Stale Name',
                nameEncrypted: encryptField('Current Name'),
            },
        );
        const row = received as { email: string; name: string };
        expect(row.email).toBe('current@vendor.com');
        expect(row.name).toBe('Current Name');
    });

    it('KEEPS the plaintext column on an undecryptable legacy ciphertext', async () => {
        // Looks like a v1 envelope (passes isEncryptedValue) but the body
        // is too short for a valid IV+tag, so decryptField throws.
        // Unlike the mapped path, nulling here would DISCARD a perfectly
        // good plaintext value that is still stored in its own column.
        const { received } = await run(
            { model: 'VendorContact', action: 'findFirst', args: {} },
            {
                id: 'vc1',
                email: 'fallback@vendor.com',
                emailEncrypted: 'v1:bm90LXJlYWwK',
            },
        );
        expect((received as { email: unknown }).email).toBe('fallback@vendor.com');
    });

    it('leaves the plaintext alone when the encrypted column is absent', async () => {
        const { received } = await run(
            { model: 'VendorContact', action: 'findFirst', args: {} },
            { id: 'vc1', email: 'only-plain@vendor.com' },
        );
        expect((received as { email: unknown }).email).toBe('only-plain@vendor.com');
    });
});

// ─── Compound WHERE clauses ─────────────────────────────────────────

describe('WHERE rewriting — compound clauses', () => {
    it('rewrites inside an object-form NOT clause', async () => {
        const where = _rewriteWhereForHash(
            { NOT: { email: 'a@b.com' } },
            'User',
        );
        expect(where).toStrictEqual({
            NOT: { emailHash: hashForLookup('a@b.com') },
        });
    });

    it('rewrites inside an array-form AND clause', () => {
        const where = _rewriteWhereForHash(
            { AND: [{ email: 'a@b.com' }, { id: 'u1' }] },
            'User',
        );
        expect(where).toStrictEqual({
            AND: [{ emailHash: hashForLookup('a@b.com') }, { id: 'u1' }],
        });
    });

    it('leaves an operator that cannot be hashed untouched', () => {
        // `contains` cannot be expressed against a hash. Rewriting it
        // would silently produce a WRONG match; leaving it produces an
        // obvious "no rows" instead.
        const where = _rewriteWhereForHash(
            { email: { contains: 'acme' } },
            'User',
        );
        expect(where).toStrictEqual({ email: { contains: 'acme' } });
    });

    it('returns an unmanaged model WHERE clause unchanged', () => {
        const where = _rewriteWhereForHash({ email: 'a@b.com' }, 'Risk');
        expect(where).toStrictEqual({ email: 'a@b.com' });
    });
});

// ─── Prisma 7 $extends adapter ──────────────────────────────────────

describe('withPiiEncryptionExtension', () => {
    type AllOperationsArgs = {
        model: string;
        operation: string;
        args: { data?: unknown; where?: unknown };
        query: (a: unknown) => Promise<unknown>;
    };
    type ExtensionConfig = {
        name: string;
        query: {
            $allModels: {
                $allOperations: (a: AllOperationsArgs) => Promise<unknown>;
            };
        };
    };

    function fakeClient(): {
        client: { $extends: (cfg: unknown) => unknown };
        captured: ExtensionConfig[];
    } {
        const captured: ExtensionConfig[] = [];
        const client = {
            $extends: (cfg: unknown): unknown => {
                captured.push(cfg as ExtensionConfig);
                return { extended: true };
            },
        };
        return { client, captured };
    }

    it('registers a named $allModels/$allOperations extension', () => {
        const { client, captured } = fakeClient();
        const out = withPiiEncryptionExtension(client);

        expect(out).toStrictEqual({ extended: true });
        expect(captured).toHaveLength(1);
        // The name is what makes a double-registration detectable.
        expect(captured[0].name).toBe('pii-encryption');
        expect(typeof captured[0].query.$allModels.$allOperations).toBe('function');
    });

    it('adapts the v7 call shape and encrypts before the query runs', async () => {
        const { client, captured } = fakeClient();
        withPiiEncryptionExtension(client);
        const handler = captured[0].query.$allModels.$allOperations;

        let queriedWith: { data?: Record<string, unknown> } | undefined;
        await handler({
            model: 'User',
            operation: 'create',
            args: { data: { email: 'ext@example.com', name: 'Ext' } },
            query: async (a: unknown): Promise<unknown> => {
                queriedWith = a as { data?: Record<string, unknown> };
                return { id: 'u1' };
            },
        });

        // `operation` must be mapped onto `action`, or every branch in
        // runPiiEncryption silently no-ops and PII goes in as plaintext.
        expect(isEncryptedValue(queriedWith?.data?.email as string)).toBe(true);
        expect(queriedWith?.data?.emailHash).toBe(hashForLookup('ext@example.com'));
    });

    it('adapts the v7 shape for reads and decrypts what the query returned', async () => {
        const { client, captured } = fakeClient();
        withPiiEncryptionExtension(client);
        const handler = captured[0].query.$allModels.$allOperations;

        const result = await handler({
            model: 'User',
            operation: 'findUnique',
            args: { where: { email: 'ext@example.com' } },
            query: async (a: unknown): Promise<unknown> => {
                // The WHERE must already be hashed by the time it lands here.
                expect((a as { where: Record<string, unknown> }).where).toStrictEqual({
                    emailHash: hashForLookup('ext@example.com'),
                });
                return { id: 'u1', email: encryptField('ext@example.com') };
            },
        });

        expect((result as { email: string }).email).toBe('ext@example.com');
    });
});

// ─── _getPiiFieldMap ────────────────────────────────────────────────

describe('_getPiiFieldMap', () => {
    it('returns the manifest for a managed model', () => {
        const specs = _getPiiFieldMap('User');
        expect(specs?.map((s) => s.plain)).toStrictEqual(['email', 'name']);
        // `mapped: true` is what routes the WHERE clause to the hash
        // column; flipping it would silently break every email lookup.
        expect(specs?.[0]).toMatchObject({
            encrypted: 'emailEncrypted',
            hash: 'emailHash',
            mapped: true,
        });
    });

    it('marks legacy dual-write models as NOT mapped', () => {
        expect(_getPiiFieldMap('VendorContact')?.every((s) => s.mapped)).toBe(false);
    });

    it('returns undefined for an unmanaged model', () => {
        expect(_getPiiFieldMap('Risk')).toBeUndefined();
    });
});
