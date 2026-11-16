/**
 * THE GATEWAY'S CREDENTIAL IS BEHIND — #5476, acceptance criterion 4.
 *
 * A posture connection's gateway provider is written by an operator and attached
 * by name. Rotating the credential in the product leaves the gateway holding the
 * previous one, under the same name, so every later scan benchmarks an account
 * the tenant no longer has on record — the quietest version of #5251, because the
 * account is real and simply not theirs any more.
 *
 * Criterion 4 was renegotiated from "rotation removes the provider" to detect and
 * report, and the owner's decision (2026-11-16) is that a PERSON closes the
 * finding after re-provisioning. So the two properties worth more than the rest:
 *
 *   1. Nothing closes it automatically. There is no positive evidence available —
 *      the readiness observation says `credentials_installed`, not WHICH — so a
 *      close on the next successful scan would close on the old credential
 *      working perfectly well.
 *   2. One OPEN finding per connection. The fact is the same fact however many
 *      times the credential moved, and a per-rotation finding would pile up.
 */
import {
    providerStalenessVerdict,
    reportsStaleness,
    type StoredCredential,
} from '@/app-layer/integrations/cloud-posture/provider-staleness';
import {
    POSTURE_PROVIDER_STALE_SEVERITY,
    POSTURE_PROVIDER_STALE_SOURCE_KIND,
    reportPostureProviderStaleness,
} from '@/app-layer/usecases/posture-provider-staleness';
import { postureProviderName } from '@/app-layer/integrations/cloud-posture/provider-name';
import { makeRequestContext } from '../../helpers/make-context';

const readable = (canonical: string): StoredCredential => ({ kind: 'readable', canonical });

describe('providerStalenessVerdict', () => {
    const base = {
        isPostureConnection: true,
        suppliedCanonical: '[["key","new"]]',
        previous: readable('[["key","old"]]'),
    };

    it('reports a changed credential as STALE', () => {
        expect(providerStalenessVerdict(base)).toBe('STALE');
    });

    it('says nothing when the same credential is re-saved', () => {
        // The admin UI never returns the stored secret, so a re-save normally
        // sends none at all — but a reader who retypes the same key must not
        // raise a finding about a gateway that is perfectly current.
        expect(
            providerStalenessVerdict({ ...base, suppliedCanonical: '[["key","old"]]' }),
        ).toBe('UNCHANGED');
    });

    it('says nothing when no credential was supplied', () => {
        expect(providerStalenessVerdict({ ...base, suppliedCanonical: undefined })).toBe(
            'NOT_APPLICABLE',
        );
    });

    it('says nothing for a connection that is not a posture connection', () => {
        expect(providerStalenessVerdict({ ...base, isPostureConnection: false })).toBe(
            'NOT_APPLICABLE',
        );
    });

    it('treats a FIRST credential as nothing to report', () => {
        // There is no provisioned provider to be behind: the operator provisions
        // against the credential the connection has now.
        expect(providerStalenessVerdict({ ...base, previous: { kind: 'none' } })).toBe(
            'FIRST_CREDENTIAL',
        );
    });

    it('REPORTS when the previous credential cannot be read', () => {
        // "We cannot tell" is a thing an operator should be told. Treating it as
        // `none` would read as a first provisioning and say nothing, which is the
        // one reading it certainly is not.
        expect(providerStalenessVerdict({ ...base, previous: { kind: 'unreadable' } })).toBe(
            'UNREADABLE_PREVIOUS',
        );
    });

    it('distinguishes the three previous-credential states from one another', () => {
        const verdicts = (['none', 'unreadable'] as const).map((kind) =>
            providerStalenessVerdict({ ...base, previous: { kind } }),
        );
        // Collapsing any two of the three gets a case wrong, so they are asserted
        // as a set rather than one at a time.
        expect(new Set([...verdicts, providerStalenessVerdict(base)]).size).toBe(3);
    });
});

describe('reportsStaleness', () => {
    it('reports exactly STALE and UNREADABLE_PREVIOUS', () => {
        const all = [
            'NOT_APPLICABLE',
            'FIRST_CREDENTIAL',
            'UNCHANGED',
            'STALE',
            'UNREADABLE_PREVIOUS',
        ] as const;
        expect(all.filter((v) => reportsStaleness(v))).toEqual(['STALE', 'UNREADABLE_PREVIOUS']);
    });
});

describe('reportPostureProviderStaleness', () => {
    const TENANT = 'clz1tenantaaaaaaaaaaaaaa';
    const CONN = 'clz1connbbbbbbbbbbbbbbbb';
    const ctx = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: 'acme', userId: 'u1' });

    function makeDb(existingFinding: { id: string } | null) {
        const created: Array<Record<string, unknown>> = [];
        return {
            created,
            db: {
                finding: {
                    findFirst: jest.fn(async () => existingFinding),
                    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
                        created.push(data);
                        return { id: 'f-1', ...data };
                    }),
                },
            } as never,
        };
    }

    const call = (db: never, verdict: Parameters<typeof reportPostureProviderStaleness>[2]['verdict'], owner: string | null = 'owner-1') =>
        reportPostureProviderStaleness(db, ctx, {
            verdict,
            connectionId: CONN,
            provider: 'gcp-posture',
            ownerUserId: owner,
        });

    it('raises one finding, keyed on the connection, assigned to its owner', async () => {
        const { db, created } = makeDb(null);
        await expect(call(db, 'STALE')).resolves.toBe('f-1');
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({
            sourceKind: POSTURE_PROVIDER_STALE_SOURCE_KIND,
            sourceRef: CONN,
            status: 'OPEN',
            severity: POSTURE_PROVIDER_STALE_SEVERITY,
            assigneeUserId: 'owner-1',
        });
    });

    it('names the provider the operator must re-provision', async () => {
        const { db, created } = makeDb(null);
        await call(db, 'STALE');
        // The one thing the reader has to act on. It is an opaque digest of two
        // row ids, and it is what they pass to `provider create`.
        expect(created[0].description).toContain(
            postureProviderName({ tenantId: TENANT, connectionId: CONN }),
        );
    });

    it('carries no credential, in any form', async () => {
        const { db, created } = makeDb(null);
        await call(db, 'STALE');
        const body = `${created[0].title} ${created[0].description}`;
        // The finding says the credential MOVED, never what it is — not its
        // value, not its length, not a digest of it.
        for (const leak of ['secret', 'password', 'privateKey', 'accessKey', 'serviceAccount']) {
            expect(body.toLowerCase()).not.toContain(leak.toLowerCase());
        }
    });

    it('says the product cannot confirm the fix, so a person closes it', async () => {
        const { db, created } = makeDb(null);
        await call(db, 'STALE');
        // Without this sentence the reader has no way to know why it will sit
        // open until they act, and would reasonably wait for it to clear.
        expect(String(created[0].description)).toContain('nothing closes it automatically');
    });

    it('does NOT raise a second finding while one is open', async () => {
        const { db, created } = makeDb({ id: 'f-existing' });
        await expect(call(db, 'STALE')).resolves.toBeNull();
        // The fact is the same fact however many times the credential moved. A
        // per-rotation finding would pile up, which is what the owner's reasoning
        // ruled out.
        expect(created).toEqual([]);
    });

    it('raises nothing for a verdict that is not reportable', async () => {
        for (const verdict of ['NOT_APPLICABLE', 'FIRST_CREDENTIAL', 'UNCHANGED'] as const) {
            const { db, created } = makeDb(null);
            await expect(call(db, verdict)).resolves.toBeNull();
            expect(created).toEqual([]);
        }
    });

    it('leaves the finding unassigned rather than inventing an assignee', async () => {
        const { db, created } = makeDb(null);
        await call(db, 'STALE', null);
        // The rule the passport sweep follows for the same column: no accountable
        // owner means no assignee, never a guessed one.
        expect(created[0].assigneeUserId).toBeNull();
    });

    it('words the unreadable case as "cannot show", not as a rotation', async () => {
        const { db, created } = makeDb(null);
        await call(db, 'UNREADABLE_PREVIOUS');
        expect(String(created[0].description)).toContain('could not be read');
        expect(String(created[0].description)).not.toContain('was changed in the product');
    });
});
