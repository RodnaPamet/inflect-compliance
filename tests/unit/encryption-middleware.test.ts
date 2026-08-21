/**
 * Unit Test: Epic B.1 field-level encryption middleware.
 *
 * Pins the transparent encrypt-on-write / decrypt-on-read contract:
 *   - manifest fields round-trip (plaintext → ciphertext → plaintext)
 *   - non-manifest fields are never touched
 *   - null / undefined / '' are passthrough
 *   - already-encrypted values are NOT re-encrypted (idempotent)
 *   - legacy plaintext on read passes through (rollout-safe)
 *   - malformed ciphertext on read logs + returns raw (never throws)
 *   - nested relation writes encrypt descendant models
 *   - included relations on reads get decrypted recursively
 */

jest.mock('@/lib/observability/logger', () => ({
    logger: {
        warn: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

import {
    encryptField,
    isEncryptedValue,
} from '@/lib/security/encryption';
import {
    ENCRYPTED_FIELDS,
    isEncryptedModel,
    getEncryptedFields,
} from '@/lib/security/encrypted-fields';
import {
    _internals,
    withEncryptionExtension,
} from '@/lib/db/encryption-middleware';
import { logger } from '@/lib/observability/logger';

/**
 * A pair with no tenant DEK, BY DESIGN — cross-tenant work that is supposed
 * to have none. `reason` distinguishes it from a FAILED lookup, which the
 * read path now handles differently: by-design reads back as `null`, a
 * failed lookup still falls back to the ciphertext.
 */
const NO_DEKS = { primary: null, previous: null, reason: 'by-design' } as const;
const { walkWriteArgument, walkReadResult, encryptDataNode, decryptResultNode } =
    _internals;

describe('ENCRYPTED_FIELDS manifest', () => {
    it('contains the core Epic B.1 models', () => {
        for (const m of [
            'Risk',
            'Finding',
            'EvidenceReview',
            'PolicyVersion',
            'Vendor',
            'Task',
            'TaskComment',
            'Audit',
            'AuditChecklistItem',
            'ControlTestRun',
        ]) {
            expect(isEncryptedModel(m)).toBe(true);
        }
    });

    it('deliberately excludes search-loaded-bearing fields', () => {
        // Flagged in the manifest as "omit until product decision on
        // dropping substring search". These must stay off until that
        // decision + the repo search removal land together.
        expect(ENCRYPTED_FIELDS.Risk).not.toContain('description');
        // PolicyVersion.contentText is the high-value target; Policy.description
        // stays plaintext. There is no Policy entry in the manifest.
        expect((ENCRYPTED_FIELDS as Record<string, unknown>).Policy).toBeUndefined();
    });

    it('excludes non-tenant global library tables', () => {
        for (const m of [
            'Framework',
            'Clause',
            'ControlTemplate',
            'PolicyTemplate',
            'QuestionnaireTemplate',
            'RiskTemplate',
        ]) {
            expect(isEncryptedModel(m)).toBe(false);
        }
    });

    it('encrypts BackgroundCheck.resultSummary (PR-6 — adverse-action detail)', () => {
        expect(isEncryptedModel('BackgroundCheck')).toBe(true);
        expect(getEncryptedFields('BackgroundCheck')).toContain('resultSummary');
    });

    it('returns undefined for unknown models', () => {
        expect(getEncryptedFields('DoesNotExist')).toBeUndefined();
        expect(getEncryptedFields(undefined)).toBeUndefined();
    });
});

describe('ConnectedIdentityAccount.protectionReason round-trips through the middleware', () => {
    /**
     * Step 3 of the manifest's own "Adding a new field" checklist.
     *
     * The operator's note saying WHY an account must never be offboarded. It
     * routinely names a person or the purpose of a credential — "Alice's
     * break-glass admin", "shared ops mailbox" — which is the same shape as
     * IdentityWriteJournal.detail below, and it sits on a row the whole product
     * reads.
     */
    it('is declared in the manifest', () => {
        expect(getEncryptedFields('ConnectedIdentityAccount')).toContain('protectionReason');
        expect(isEncryptedModel('ConnectedIdentityAccount')).toBe(true);
    });

    it('encrypts on write', () => {
        const data: Record<string, unknown> = { protectionReason: "Ada's break-glass admin, do not disable" };
        encryptDataNode(data, 'ConnectedIdentityAccount', null);
        expect(isEncryptedValue(data.protectionReason as string)).toBe(true);
        expect(data.protectionReason as string).not.toContain('Ada');
    });

    it('decrypts on read, recovering the original text', () => {
        const plain = 'shared ops mailbox — offboarding it locks out the on-call rota';
        const data: Record<string, unknown> = { protectionReason: plain };
        encryptDataNode(data, 'ConnectedIdentityAccount', null);
        expect(data.protectionReason).not.toBe(plain);
        decryptResultNode(data, 'ConnectedIdentityAccount', { primary: null, previous: null, reason: 'by-design' });
        expect(data.protectionReason).toBe(plain);
    });

    it('leaves a null reason alone', () => {
        // Nullable, and cleared on release. Encrypting null would turn "this
        // account is not protected" into ciphertext that reads as a value.
        const data: Record<string, unknown> = { protectionReason: null };
        encryptDataNode(data, 'ConnectedIdentityAccount', null);
        expect(data.protectionReason).toBeNull();
    });

    it('does NOT touch the columns the leaver path reads to make decisions', () => {
        // isProtected drives a refusal and externalUserId addresses a directory
        // write. Encrypting either would break the feature rather than protect
        // anyone — the manifest is for free text about people, not for flags.
        const data: Record<string, unknown> = { isProtected: true, externalUserId: 'ada@acme.com', email: 'ada@acme.com' };
        encryptDataNode(data, 'ConnectedIdentityAccount', null);
        expect(data.isProtected).toBe(true);
        expect(data.externalUserId).toBe('ada@acme.com');
        expect(data.email).toBe('ada@acme.com');
    });
});

describe('IdentityWriteJournal.detail round-trips through the middleware', () => {
    /**
     * Step 3 of the manifest's own "Adding a new field" checklist.
     *
     * `detail` carries the provider's rejection message for a failed disable —
     * which routinely echoes back the UPN and object id — and the human reason
     * a change was reverted. Free text about a NAMED person's access change.
     */
    it('is declared in the manifest', () => {
        expect(getEncryptedFields('IdentityWriteJournal')).toContain('detail');
        expect(isEncryptedModel('IdentityWriteJournal')).toBe(true);
    });

    it('encrypts on write', () => {
        const data: Record<string, unknown> = {
            detail: 'Graph returned 403 for user ada@acme.com (id 8f2c)',
        };
        encryptDataNode(data, 'IdentityWriteJournal', null);
        expect(isEncryptedValue(data.detail as string)).toBe(true);
        expect(data.detail as string).not.toContain('ada@acme.com');
    });

    it('decrypts on read, recovering the original text', () => {
        const plain = 'reverted: rehired 2026-09-01';
        const data: Record<string, unknown> = { detail: plain };
        encryptDataNode(data, 'IdentityWriteJournal', null);
        expect(data.detail).not.toBe(plain);
        decryptResultNode(data, 'IdentityWriteJournal', { primary: null, previous: null, reason: 'by-design' });
        expect(data.detail).toBe(plain);
    });

    it('leaves a null detail alone', () => {
        // The column is nullable — a settled-clean APPLIED write has no detail,
        // and encrypting null would turn "nothing to say" into ciphertext.
        const data: Record<string, unknown> = { detail: null };
        encryptDataNode(data, 'IdentityWriteJournal', null);
        expect(data.detail).toBeNull();
    });

    it('does NOT touch priorStateJson', () => {
        // The manifest encrypts STRING fields only, so the JSON capture cannot
        // be listed there. It holds structured directory attributes, not
        // credentials — see the note in encrypted-fields.ts.
        const data: Record<string, unknown> = {
            detail: 'x',
            priorStateJson: { accountEnabled: true },
        };
        encryptDataNode(data, 'IdentityWriteJournal', null);
        expect(data.priorStateJson).toEqual({ accountEnabled: true });
    });
});

describe('encryptDataNode', () => {
    it('encrypts listed fields and leaves others alone', () => {
        const data: Record<string, unknown> = {
            treatmentNotes: 'sensitive remediation plan',
            threat: 'ransomware via supply-chain',
            status: 'OPEN',
            score: 12,
            tenantId: 'tenant-1',
        };
        encryptDataNode(data, 'Risk', null);

        expect(isEncryptedValue(data.treatmentNotes as string)).toBe(true);
        expect(isEncryptedValue(data.threat as string)).toBe(true);
        expect(data.status).toBe('OPEN'); // not in manifest
        expect(data.score).toBe(12);
        expect(data.tenantId).toBe('tenant-1');
    });

    it('is idempotent — re-encrypting a ciphertext is a no-op', () => {
        const alreadyEncrypted = encryptField('existing ciphertext');
        const data = { treatmentNotes: alreadyEncrypted };
        encryptDataNode(data, 'Risk', null);
        expect(data.treatmentNotes).toBe(alreadyEncrypted);
    });

    it('passes null / undefined / empty string through unchanged', () => {
        const data: Record<string, unknown> = {
            treatmentNotes: null,
            threat: undefined,
            vulnerability: '',
        };
        encryptDataNode(data, 'Risk', null);
        expect(data.treatmentNotes).toBeNull();
        expect(data.threat).toBeUndefined();
        expect(data.vulnerability).toBe('');
    });

    it('skips non-string values defensively', () => {
        const data: Record<string, unknown> = {
            treatmentNotes: 42, // not a realistic Prisma shape but the
                                // middleware must not crash on it
        };
        encryptDataNode(data, 'Risk', null);
        expect(data.treatmentNotes).toBe(42);
    });

    it('ignores models not in the manifest', () => {
        const data = { secret: 'should-stay-plain' }; // pragma: allowlist secret — test fixture, asserts non-manifest pass-through
        encryptDataNode(data, 'Framework', null);
        expect(data.secret).toBe('should-stay-plain');
    });
});

describe('decryptResultNode', () => {
    it('decrypts listed fields and leaves others alone', () => {
        const encrypted = encryptField('nuclear launch codes');
        const node: Record<string, unknown> = {
            treatmentNotes: encrypted,
            status: 'CLOSED',
            score: 1,
        };
        decryptResultNode(node, 'Risk', NO_DEKS);
        expect(node.treatmentNotes).toBe('nuclear launch codes');
        expect(node.status).toBe('CLOSED');
    });

    it('passes legacy plaintext (no v1: prefix) through unchanged', () => {
        const node: Record<string, unknown> = {
            treatmentNotes: 'legacy plaintext row',
        };
        decryptResultNode(node, 'Risk', NO_DEKS);
        expect(node.treatmentNotes).toBe('legacy plaintext row');
    });

    it('logs warn + THROWS on malformed ciphertext', () => {
        // Valid prefix, gibberish payload — AES-GCM rejects it.
        //
        // NOTE THIS IS A v1 ROW: decrypted under the global KEK, so no tenant
        // DEK is involved and `NO_DEKS` is irrelevant to the outcome. The
        // fail-closed posture therefore covers v1 corruption too, not just
        // per-tenant v2 key mismatches — a corrupt legacy row stops the read
        // wherever it is encountered rather than passing `v1:garbage…` on to
        // a renderer as if it were content.
        const node: Record<string, unknown> = {
            treatmentNotes: 'v1:garbage-that-is-not-valid-base64-or-ciphertext',
        };
        expect(() => decryptResultNode(node, 'Risk', NO_DEKS)).toThrow(
            /failed to decrypt Risk\.treatmentNotes/,
        );
        expect(logger.warn).toHaveBeenCalledWith(
            'encryption-middleware.decrypt_failed',
            expect.objectContaining({
                model: 'Risk',
                field: 'treatmentNotes',
                outcome: 'decrypt_failed',
            }),
        );
        // The node is left untouched — no partial write of a half-decrypted
        // row, and nothing that could be mistaken for plaintext.
        expect(node.treatmentNotes).toBe(
            'v1:garbage-that-is-not-valid-base64-or-ciphertext',
        );
    });

    it('handles null / empty gracefully', () => {
        const node: Record<string, unknown> = {
            treatmentNotes: null,
            threat: '',
        };
        decryptResultNode(node, 'Risk', NO_DEKS);
        expect(node.treatmentNotes).toBeNull();
        expect(node.threat).toBe('');
    });
});

describe('walkWriteArgument — end-to-end encrypt', () => {
    it('encrypts a single create payload', () => {
        const data: Record<string, unknown> = {
            title: 'Bad thing',
            description: 'sensitive', // Finding.description IS in manifest
            rootCause: 'insider',
        };
        walkWriteArgument(data, 'Finding', null);
        expect(isEncryptedValue(data.description as string)).toBe(true);
        expect(isEncryptedValue(data.rootCause as string)).toBe(true);
        expect(data.title).toBe('Bad thing'); // not in manifest
    });

    it('encrypts an array payload (createMany.data)', () => {
        const rows = [
            { body: 'comment one' },
            { body: 'comment two' },
            { body: null },
        ];
        walkWriteArgument(rows, 'TaskComment', null);
        expect(isEncryptedValue(rows[0].body as string)).toBe(true);
        expect(isEncryptedValue(rows[1].body as string)).toBe(true);
        expect(rows[2].body).toBeNull();
    });

    it('descends into nested create under a relation', () => {
        // Task with nested comment.create — Task has `description`
        // (manifest), the nested TaskComment has `body` (manifest).
        const data: Record<string, unknown> = {
            title: 'Fix thing',
            description: 'parent description',
            comments: {
                create: [{ body: 'first comment' }, { body: 'second comment' }],
            },
        };
        walkWriteArgument(data, 'Task', null);
        expect(isEncryptedValue(data.description as string)).toBe(true);
        const comments = (data.comments as { create: Array<{ body: string }> })
            .create;
        expect(isEncryptedValue(comments[0].body)).toBe(true);
        expect(isEncryptedValue(comments[1].body)).toBe(true);
    });

    it('descends into createMany.data inside a relation nest', () => {
        const data: Record<string, unknown> = {
            title: 'Bulk parent',
            comments: {
                createMany: {
                    data: [{ body: 'bulk 1' }, { body: 'bulk 2' }],
                },
            },
        };
        walkWriteArgument(data, 'Task', null);
        const created = (
            data.comments as { createMany: { data: Array<{ body: string }> } }
        ).createMany.data;
        expect(isEncryptedValue(created[0].body)).toBe(true);
        expect(isEncryptedValue(created[1].body)).toBe(true);
    });

    it('descends into upsert.create + upsert.update', () => {
        const data: Record<string, unknown> = {
            title: 'X',
            comments: {
                upsert: {
                    where: { id: 'c1' },
                    create: { body: 'upsert-create' },
                    update: { body: 'upsert-update' },
                },
            },
        };
        walkWriteArgument(data, 'Task', null);
        const upsert = (
            data.comments as {
                upsert: { create: { body: string }; update: { body: string } };
            }
        ).upsert;
        expect(isEncryptedValue(upsert.create.body)).toBe(true);
        expect(isEncryptedValue(upsert.update.body)).toBe(true);
    });

    it('does NOT touch non-manifest fields under nested writes', () => {
        const data: Record<string, unknown> = {
            title: 'title stays plain',
            comments: {
                create: [
                    {
                        body: 'manifest field',
                        createdByUserId: 'user-1', // NOT in manifest
                    },
                ],
            },
        };
        walkWriteArgument(data, 'Task', null);
        const created = (data.comments as { create: Array<Record<string, unknown>> })
            .create;
        expect(created[0].createdByUserId).toBe('user-1');
    });

    it('passes through null / empty on all nested paths', () => {
        const data: Record<string, unknown> = {
            title: null,
            comments: { create: [{ body: null }, { body: '' }] },
        };
        walkWriteArgument(data, 'Task', null);
        const created = (data.comments as { create: Array<{ body: unknown }> })
            .create;
        expect(created[0].body).toBeNull();
        expect(created[1].body).toBe('');
    });
});

describe('walkReadResult — end-to-end decrypt', () => {
    it('decrypts a single read result', () => {
        const node = {
            id: 'r-1',
            treatmentNotes: encryptField('plan'),
            threat: encryptField('ransomware'),
            status: 'OPEN',
        };
        walkReadResult(node, 'Risk', NO_DEKS);
        expect(node.treatmentNotes).toBe('plan');
        expect(node.threat).toBe('ransomware');
        expect(node.status).toBe('OPEN');
    });

    it('decrypts an array of findMany results', () => {
        const results = [
            { treatmentNotes: encryptField('A') },
            { treatmentNotes: encryptField('B') },
            { treatmentNotes: null },
            { treatmentNotes: 'legacy plaintext — passes through' },
        ];
        walkReadResult(results, 'Risk', NO_DEKS);
        expect(results[0].treatmentNotes).toBe('A');
        expect(results[1].treatmentNotes).toBe('B');
        expect(results[2].treatmentNotes).toBeNull();
        expect(results[3].treatmentNotes).toBe(
            'legacy plaintext — passes through',
        );
    });

    it('decrypts included relations recursively', () => {
        const node = {
            id: 't-1',
            description: encryptField('parent task description'),
            comments: [
                { body: encryptField('comment 1') },
                { body: encryptField('comment 2') },
            ],
        };
        walkReadResult(node, 'Task', NO_DEKS);
        expect(node.description).toBe('parent task description');
        expect(node.comments[0].body).toBe('comment 1');
        expect(node.comments[1].body).toBe('comment 2');
    });

    it('decrypts deeply nested included relations', () => {
        const node = {
            id: 't-1',
            description: encryptField('top'),
            comments: [
                {
                    body: encryptField('mid'),
                    nestedExtra: {
                        body: encryptField('deep'),
                    },
                },
            ],
        };
        walkReadResult(node, 'Task', NO_DEKS);
        expect(node.description).toBe('top');
        expect(node.comments[0].body).toBe('mid');
        // The nestedExtra node is walked via the fan-out path.
        // Since `TaskComment` is in the manifest with `body`, the
        // nested body also gets decrypted.
        expect(
            (node.comments[0].nestedExtra as { body: string }).body,
        ).toBe('deep');
    });

    it('handles null / undefined / empty result shapes', () => {
        expect(() => walkReadResult(null, 'Risk', NO_DEKS)).not.toThrow();
        expect(() => walkReadResult(undefined, 'Risk', NO_DEKS)).not.toThrow();
        expect(() => walkReadResult([], 'Risk', NO_DEKS)).not.toThrow();
        expect(() => walkReadResult({}, 'Risk', NO_DEKS)).not.toThrow();
    });

    it('does NOT decrypt non-manifest model results', () => {
        const node = { description: 'stays plaintext forever' };
        walkReadResult(node, 'Framework', NO_DEKS); // not in manifest
        expect(node.description).toBe('stays plaintext forever');
    });
});

describe('withEncryptionExtension', () => {
    // Build a fake client whose `$extends` captures the registered
    // `$allOperations` handler so the tests can drive it directly,
    // mirroring how the equivalent v5 tests grabbed the `$use` callback.
    type Op = (p: {
        model: string;
        operation: string;
        args?: unknown;
        query: (a: unknown) => Promise<unknown>;
    }) => Promise<unknown>;

    function captureHandler(): { handler: Op } {
        const captured: { handler: Op } = {
            handler: (async ({ query, args }) => query(args)) as Op,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fake: any = {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            $extends: (cfg: any) => {
                captured.handler = cfg.query.$allModels.$allOperations as Op;
                return fake;
            },
        };
        withEncryptionExtension(fake);
        return captured;
    }

    it('encrypts write args then decrypts read result — full round trip', async () => {
        const { handler } = captureHandler();

        // Capture the args observed by `query` (what Prisma would
        // have sent to the DB). Clone eagerly — real Prisma returns
        // a fresh row from the DB, NOT the same object the caller
        // passed in; without the clone, the middleware's subsequent
        // result-decrypt pass would mutate our captured snapshot.
        let seenDbArgs: unknown;
        const query = jest.fn(async (args: unknown) => {
            seenDbArgs = JSON.parse(JSON.stringify(args));
            // Simulate DB returning the written row, still ciphertext.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return JSON.parse(JSON.stringify((args as any).data));
        });

        const plaintext = 'mitigation strategy details';
        const result = (await handler({
            model: 'Risk',
            operation: 'create',
            args: {
                data: { title: 'X', treatmentNotes: plaintext, status: 'OPEN' },
            },
            query,
        })) as { title: string; treatmentNotes: string; status: string };

        // What the DB saw: ciphertext.
        expect(
            isEncryptedValue(
                (seenDbArgs as { data: { treatmentNotes: string } }).data
                    .treatmentNotes,
            ),
        ).toBe(true);

        // What the caller saw: plaintext.
        expect(result.treatmentNotes).toBe(plaintext);
        expect(result.status).toBe('OPEN');
    });

    it('does not touch non-encrypted models', async () => {
        const { handler } = captureHandler();

        let seen: unknown;
        const query = jest.fn(async (args: unknown) => {
            seen = args;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (args as any).data;
        });

        const data = { key: 'ISO27001', name: 'ISO 27001' };
        await handler({
            model: 'Framework',
            operation: 'create',
            args: { data },
            query,
        });
        expect((seen as { data: Record<string, unknown> }).data).toEqual(data);
    });
});
