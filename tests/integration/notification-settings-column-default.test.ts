/**
 * The migration that removed the sender's column default actually reached the
 * database, and the sibling column's default was not removed with it (#2296).
 *
 * WHY THIS IS A DB TEST AND NOT A SCHEMA SCAN. There is already a scan over
 * `prisma/schema/automation.prisma` — tests/unit/notification-sender-fallback.test.ts
 * fails if the literal reappears in the schema file. What that scan cannot see
 * is DRIFT: a `@default` removed from the schema but never expressed in a
 * migration leaves every existing database still holding it, and production is
 * exactly such a database. The schema file and the deployed column are two
 * different facts, and the outage came from the second one.
 *
 * WHAT THE DEFAULT DID. `TenantNotificationSettings.defaultFromEmail` is the
 * `From` header processOutbox puts on every message for a tenant. It defaulted
 * to a placeholder address deliverable only from a relay that has verified that
 * domain; production's relay had verified a different one, so every message was
 * rejected `550 ... domain is not verified` — 520 of them, silently, over three
 * months. PR #2286 removed the literal from the application code but not from
 * the column, and the column was still reachable through an insert that omitted
 * the field.
 *
 * `defaultFromName` deliberately KEEPS its default: a product name is not a
 * deployment fact and no relay can reject it. Asserting that here stops a later
 * "tidy up the other one too" from passing unnoticed.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

async function column(name: string) {
    const rows = await prisma.$queryRaw<Array<{ is_nullable: string; column_default: string | null }>>`
        SELECT is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'TenantNotificationSettings' AND column_name = ${name}
    `;
    expect(rows).toHaveLength(1);
    return rows[0];
}

describeFn('TenantNotificationSettings column defaults', () => {
    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('defaultFromEmail has NO column default', async () => {
        expect((await column('defaultFromEmail')).column_default).toBeNull();
    });

    it('defaultFromEmail is still NOT NULL', async () => {
        // Dropping the default without keeping NOT NULL would let a row hold a
        // null sender, which just moves the "what if it is absent" decision
        // into processOutbox — the two-places-to-decide shape this removes.
        expect((await column('defaultFromEmail')).is_nullable).toBe('NO');
    });

    it('defaultFromName keeps its default', async () => {
        expect((await column('defaultFromName')).column_default).toContain('Inflect Compliance');
    });
});
