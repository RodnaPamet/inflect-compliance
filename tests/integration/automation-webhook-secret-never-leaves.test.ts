/**
 * Integration — a WEBHOOK rule's signing key is stored encrypted and is never
 * returned by any read.
 *
 * Proven here against a real database, through the real usecases:
 *
 *   • a key sent either way (`webhookSecret`, or the legacy
 *     `actionConfig.secretRef`) lands in the encrypted column as ciphertext,
 *     and the JSON column carries none;
 *   • no response from list, detail, create, update, toggle or archive
 *     contains the key anywhere, and each says `webhookSecretSet`;
 *   • an edit that says nothing about the key keeps it; `null` removes it;
 *   • editing a rule whose key is still in the legacy JSON moves it to the
 *     column instead of dropping it.
 *
 * Setup and raw reads use a plain client, which sees the stored bytes.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    archiveAutomationRule,
    createAutomationRule,
    getAutomationRule,
    listAutomationRules,
    toggleAutomationRule,
    updateAutomationRule,
} from '@/app-layer/usecases/automation-rules';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `aws-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${TAG}`;
const KEY = `k-${randomUUID()}`;
const URL_ = 'https://hooks.example.com/inflect';

let adminId: string;
let readerId: string;
let adminCtx: ReturnType<typeof makeRequestContext>;
let readerCtx: ReturnType<typeof makeRequestContext>;

async function makeMember(label: string, role: Role): Promise<string> {
    const email = `${TAG}-${label}@example.test`;
    const u = await db.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await db.tenantMembership.create({
        data: { tenantId: TENANT, userId: u.id, role, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

/** The row as stored: no decryption. */
async function raw(id: string) {
    const r = await db.automationRule.findUniqueOrThrow({
        where: { id },
        select: { actionConfigJson: true, webhookSecretEncrypted: true },
    });
    return r;
}

const leaks = (value: unknown, key = KEY) => JSON.stringify(value).includes(key);

describeFn('a WEBHOOK signing key never leaves the server', () => {
    beforeAll(async () => {
        await db.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: `t ${TAG}`, slug: TENANT },
        });
        adminId = await makeMember('admin', Role.ADMIN);
        readerId = await makeMember('reader', Role.READER);
        adminCtx = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: TENANT, userId: adminId });
        readerCtx = makeRequestContext('READER', { tenantId: TENANT, tenantSlug: TENANT, userId: readerId });
    });

    afterAll(async () => {
        try {
            await deleteAuditRowsForTenants(db, TENANT);
            await db.automationRule.deleteMany({ where: { tenantId: TENANT } });
            await db.tenantMembership.deleteMany({ where: { tenantId: TENANT } });
            await db.user.deleteMany({ where: { id: { in: [adminId, readerId] } } });
            await db.tenant.delete({ where: { id: TENANT } });
        } catch {
            /* best effort */
        }
        await db.$disconnect();
    });

    test('stored encrypted, absent from every response, and kept or removed as asked', async () => {
        const created = await createAutomationRule(adminCtx, {
            name: `${TAG} hook`,
            triggerEvent: 'RISK_CREATED',
            actionType: 'WEBHOOK',
            actionConfig: { url: URL_, method: 'POST' },
            webhookSecret: KEY,
        });
        expect(leaks(created)).toBe(false);
        expect(created.webhookSecretSet).toBe(true);

        // At rest: ciphertext in the column, nothing in the JSON.
        const stored = await raw(created.id);
        expect(stored.webhookSecretEncrypted).toBeTruthy();
        expect(stored.webhookSecretEncrypted).not.toBe(KEY);
        expect(stored.webhookSecretEncrypted).toMatch(/^v\d:/);
        expect(leaks(stored.actionConfigJson)).toBe(false);

        // Every read a member can make.
        const list = await listAutomationRules(readerCtx);
        expect(list.some((r) => r.id === created.id)).toBe(true);
        expect(leaks(list)).toBe(false);
        const detail = await getAutomationRule(readerCtx, created.id);
        expect(leaks(detail)).toBe(false);
        expect(detail.webhookSecretSet).toBe(true);

        // An edit that says nothing about the key keeps it.
        const edited = await updateAutomationRule(adminCtx, created.id, {
            actionConfig: { url: `${URL_}/v2`, method: 'POST' },
        });
        expect(leaks(edited)).toBe(false);
        expect(edited.webhookSecretSet).toBe(true);
        expect((await raw(created.id)).webhookSecretEncrypted).toBe(stored.webhookSecretEncrypted);

        const toggled = await toggleAutomationRule(adminCtx, created.id, 'ENABLED');
        expect(leaks(toggled)).toBe(false);

        // `null` removes it.
        const cleared = await updateAutomationRule(adminCtx, created.id, { webhookSecret: null });
        expect(cleared.webhookSecretSet).toBe(false);
        expect((await raw(created.id)).webhookSecretEncrypted).toBeNull();

        const archived = await archiveAutomationRule(adminCtx, created.id);
        expect(leaks(archived)).toBe(false);
    });

    test('a key sent the old way, in actionConfig.secretRef, is moved to the column', async () => {
        const created = await createAutomationRule(adminCtx, {
            name: `${TAG} legacy-shape`,
            triggerEvent: 'RISK_CREATED',
            actionType: 'WEBHOOK',
            actionConfig: { url: URL_, secretRef: KEY },
        });
        expect(leaks(created)).toBe(false);
        const stored = await raw(created.id);
        expect(leaks(stored.actionConfigJson)).toBe(false);
        expect(stored.webhookSecretEncrypted).toMatch(/^v\d:/);
    });

    test('editing a rule whose key is still in the legacy JSON moves it rather than losing it', async () => {
        const legacyKey = `legacy-${randomUUID()}`;
        // A rule as the builder used to store it.
        const row = await db.automationRule.create({
            data: {
                tenantId: TENANT,
                name: `${TAG} pre-change`,
                triggerEvent: 'RISK_CREATED',
                actionType: 'WEBHOOK',
                actionConfigJson: { url: URL_, secretRef: legacyKey },
                createdByUserId: adminId,
            },
        });

        // Read: the legacy key is not returned, but the rule says it has one.
        const detail = await getAutomationRule(readerCtx, row.id);
        expect(leaks(detail, legacyKey)).toBe(false);
        expect(detail.webhookSecretSet).toBe(true);

        // Edited the way the form edits it: a config without the key.
        await updateAutomationRule(adminCtx, row.id, { actionConfig: { url: `${URL_}/moved` } });
        const stored = await raw(row.id);
        expect(leaks(stored.actionConfigJson, legacyKey)).toBe(false);
        expect(stored.webhookSecretEncrypted).toMatch(/^v\d:/);
        expect(stored.webhookSecretEncrypted).not.toBe(legacyKey);
    });
});
