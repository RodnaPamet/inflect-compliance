/**
 * The automation dispatchers read `AutomationRule` with the tenant DEK
 * resolvable — so `webhookSecretEncrypted` arrives as PLAINTEXT.
 *
 * ## The bug this locks out
 *
 * `action-executor.ts` signs every outbound webhook with
 * `rule.webhookSecretEncrypted` as the HMAC key. All three callers of
 * `executeAction` are BullMQ jobs that read the rule via bare `prisma`.
 *
 * `runJob` establishes a REQUEST context — AsyncLocalStorage, in
 * `@/lib/observability/context`. The encryption middleware reads
 * `getAuditContext()`, a SEPARATE module-level stack in `@/lib/audit-context`
 * (deliberately not ALS, because Prisma middleware runs detached). Two
 * stores. So a job carrying a perfectly good `tenantId` still left
 * `getAuditContext()` undefined, the DEK never resolved, the v2 decrypt
 * threw, and the middleware's fail-open catch returned the RAW CIPHERTEXT.
 *
 * Every automation webhook was therefore signed with a key no consumer could
 * hold — and since the effective key was the exact bytes stored in the
 * database, encrypting that column bought nothing against an attacker with
 * DB read access, which is the single thing it existed to do.
 *
 * ## Why this test is integration, not unit
 *
 * Nothing here is observable with a mocked Prisma client: the whole failure
 * lives in the interaction between the real encryption extension, the real
 * context stack, and a real per-tenant DEK. A unit test that hands
 * `executeAction` a plain object proves only that HMAC works.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { runWithAuditContext } from '@/lib/audit-context';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { withEncryptionExtension } from '@/lib/db/encryption-middleware';
import { readRulesWithTenantDek } from '@/app-layer/automation/tenant-dek-read';

/** The one field under test; the client is typed `any` in this harness. */
type Rule = { webhookSecretEncrypted: string | null } | null;

const d = DB_AVAILABLE ? describe : describe.skip;

d('automation dispatch — tenant DEK resolution on the rule read', () => {
    // Throwaway fixture written to a temporary tenant in the test DB; never
    // a real credential.
    const SECRET = 'super-secret-signing-key'; // pragma: allowlist secret
    let base: ReturnType<typeof prismaTestClient>;
    let prisma: ReturnType<typeof prismaTestClient>;
    let tenantId = '';
    let ruleId = '';

    beforeAll(async () => {
        base = prismaTestClient();
        prisma = withEncryptionExtension(base) as typeof base;
        const tenant = await createTenantWithDek({
            name: 'Dispatch DEK',
            slug: `dispatch-dek-${Date.now()}`,
        });
        tenantId = tenant.id;
        await runWithAuditContext({ tenantId, source: 'api' }, async () => {
            const rule = await prisma.automationRule.create({
                data: {
                    tenantId,
                    name: 'signs a webhook',
                    triggerEvent: 'risk.created',
                    actionType: 'WEBHOOK',
                    status: 'ENABLED',
                    actionConfigJson: {},
                    webhookSecretEncrypted: SECRET,
                },
            });
            ruleId = rule.id;
        });
    }, 60000);

    it('stores the secret as a v2 tenant-DEK ciphertext, never plaintext', async () => {
        // If this ever returns plaintext the rest of the test proves nothing
        // — there would be no decryption happening to get wrong.
        // `prismaTestClient()` is typed `any`, so an explicit type argument
        // is rejected (TS2347) — assert on the result instead.
        const rows = (await base.$queryRawUnsafe(
            'SELECT "webhookSecretEncrypted" AS s FROM "AutomationRule" WHERE id = $1',
            ruleId,
        )) as Array<{ s: string | null }>;
        const row = rows[0];
        expect(row?.s).toMatch(/^v2:/);
        expect(row?.s).not.toContain(SECRET);
    });

    it('returns the PLAINTEXT secret through readRulesWithTenantDek', async () => {
        // This is the assertion that fails if the wrapper is removed from a
        // dispatcher, or if its `source` is changed to a BYPASS_SOURCES value.
        const rule = await readRulesWithTenantDek<Rule>(tenantId, () =>
            prisma.automationRule.findFirst({ where: { id: ruleId } }),
        );
        expect(rule?.webhookSecretEncrypted).toBe(SECRET);
    });

    it('yields NO usable secret without the wrapper — the regression itself', async () => {
        // Pinning the broken path makes the test above meaningful: it proves
        // the wrapper is what does the work, not some ambient context the
        // harness happens to leave lying around.
        //
        // This originally asserted the read came back as raw `v2:`
        // ciphertext, which was the bug's whole mechanism — a string
        // indistinguishable from plaintext, used as the HMAC key. The
        // encryption middleware now returns NULL for a no-DEK-by-design
        // read instead, so the two fixes compose: even if a dispatcher lost
        // its wrapper again, `signingSecret` would be null and the webhook
        // would go out UNSIGNED rather than signed with the wrong key.
        // Absent beats plausible-but-wrong.
        const rule: Rule = await prisma.automationRule.findFirst({ where: { id: ruleId } });
        expect(rule?.webhookSecretEncrypted).toBeNull();
        expect(rule?.webhookSecretEncrypted).not.toBe(SECRET);
    });

    it('produces an HMAC a consumer holding the plaintext secret can verify', async () => {
        // The user-visible contract. `action-executor` computes
        // createHmac('sha256', rule.webhookSecretEncrypted). Before the fix
        // the two digests below differed and nothing verified.
        const { createHmac } = await import('node:crypto');
        const body = JSON.stringify({ event: 'risk.created', id: 'r1' });
        const rule = await readRulesWithTenantDek<Rule>(tenantId, () =>
            prisma.automationRule.findFirst({ where: { id: ruleId } }),
        );
        const ours = createHmac('sha256', rule!.webhookSecretEncrypted!)
            .update(body)
            .digest('hex');
        const theirs = createHmac('sha256', SECRET).update(body).digest('hex');
        expect(ours).toBe(theirs);
    });
});
