/**
 * RQ3-6 — "the loss-event register: forecasts meet reality" ratchet.
 *
 * Regression classes guarded:
 *
 *   - the LossEvent model losing its RLS pairing (schema column ↔
 *     migration ↔ policies — the rls-coverage suite catches policy
 *     absence; this pins the shape that makes it a tenant-scoped
 *     row in the first place);
 *   - the encryption manifest dropping LossEvent so a future
 *     decryptor reads plaintext narratives off disk (Epic B);
 *   - the usecase losing its sanitisation, audit-event provenance,
 *     or ADMIN-only delete (Epic D.2 + RQ2-1 patterns);
 *   - the predicted-vs-actual surface vanishing from the risks
 *     section (the whole point of the feature is that the
 *     forecasting stack is FALSIFIABLE — hiding the page collapses
 *     it back to theology).
 */

import * as fs from 'fs';
import * as path from 'path';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { braceBlockAfter } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const schema = readPrismaSchema();
const enums = read('prisma/schema/enums.prisma');
const migration = read('prisma/migrations/20260612040000_rq3_6_loss_event_register/migration.sql');
const usecase = read('src/app-layer/usecases/loss-event.ts');
const listRoute = read('src/app/api/t/[tenantSlug]/loss-events/route.ts');
const aggregateRoute = read('src/app/api/t/[tenantSlug]/loss-events/aggregate/route.ts');
const itemRoute = read('src/app/api/t/[tenantSlug]/loss-events/[id]/route.ts');
const page = read('src/app/t/[tenantSlug]/(app)/risks/loss-events/page.tsx');
const risksClient = read('src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx');
// The page's user-facing copy moved to next-intl; resolve moved literals
// against the en catalog so the intent still holds.
const enMessages = JSON.parse(read('messages/en.json')) as {
    risks: { lossEvents: Record<string, string> };
};
const encryptionManifest = read('src/lib/security/encrypted-fields.ts');

describe('RQ3-6 — schema + RLS + encryption', () => {
    test('LossEvent model carries tenantId, occurredAt, amount, source, soft-delete', () => {
        /*
         * Bound to the model the test is named for.
         *
         * THREE of the five needles are field declarations that repeat
         * across the schema — counted over the concatenated schema,
         * `tenantId String` matches in 165 models, `deletedAt DateTime?`
         * in 21, `occurredAt DateTime` in 4. Those three said nothing
         * about LossEvent: measured 7/7 green with all three columns
         * deleted from the model, INCLUDING `tenantId` on a tenant-scoped
         * table. (`amount Float` and `source LossEventSource` are unique
         * to LossEvent today, so they did bind — but only by accident of
         * naming, and nothing kept it that way.)
         *
         * The anchor ends in `\s*\{` so it cannot bind to a longer model
         * name that merely starts with `LossEvent`, and `braceBlockAfter`
         * throws when the model is gone — which is what the deleted
         * `/^model LossEvent \{/m` existence check was for.
         */
        const lossEvent = braceBlockAfter(schema, 'model LossEvent\\s*\\{');
        expect(lossEvent).toMatch(/tenantId\s+String\b/);
        expect(lossEvent).toMatch(/occurredAt\s+DateTime\b/);
        expect(lossEvent).toMatch(/amount\s+Float\b/);
        expect(lossEvent).toMatch(/source\s+LossEventSource\b/);
        expect(lossEvent).toMatch(/deletedAt\s+DateTime\?/);
        expect(enums).toMatch(/enum LossEventSource \{[\s\S]*USER[\s\S]*FINDING[\s\S]*INCIDENT/);
    });

    test('migration creates the table, indexes, and the canonical RLS policies', () => {
        expect(migration).toMatch(/CREATE TABLE "LossEvent"/);
        expect(migration).toMatch(/ALTER TABLE "LossEvent" ENABLE ROW LEVEL SECURITY/);
        expect(migration).toMatch(/ALTER TABLE "LossEvent" FORCE ROW LEVEL SECURITY/);
        expect(migration).toMatch(/CREATE POLICY tenant_isolation ON "LossEvent"/);
        expect(migration).toMatch(/CREATE POLICY tenant_isolation_insert ON "LossEvent"[\s\S]*FOR INSERT WITH CHECK/);
        expect(migration).toMatch(/CREATE POLICY superuser_bypass ON "LossEvent"/);
        expect(migration).toMatch(/CREATE INDEX "LossEvent_tenantId_occurredAt_idx"/);
    });

    test('Epic B encryption manifest covers LossEvent narrative fields', () => {
        expect(encryptionManifest).toMatch(/LossEvent: \['description', 'justification'\]/);
    });
});

describe('RQ3-6 — usecase contract', () => {
    /**
     * B3-5 — four cases removed. All are covered by
     * `tests/integration/loss-event.test.ts`, which exercises the usecases
     * against a REAL DATABASE:
     *
     *   createLossEvent + sanitisation + audit  → "creates a loss event and
     *     reads it back through the list endpoint", "sanitises free-text
     *     before persistence", "emits an LOSS_EVENT_RECORDED audit row
     *     carrying the source + amount"
     *   aggregate roll-ups                      → "aggregates by year and by
     *     risk (the predicted-vs-actual spine)"
     *   ADMIN-only soft delete + hiding         → "soft-delete is ADMIN-only
     *     and hides the row from list + aggregate"
     *
     * The last one is the clearest case for deleting rather than keeping
     * both. The guard asserted hiding like this:
     *
     *     const occurrences = (usecase.match(/deletedAt: null/g) ?? []).length;
     *     expect(occurrences).toBeGreaterThanOrEqual(2);
     *
     * — counting string occurrences in a file. That passes if both
     * occurrences sit in COMMENTS, and it says nothing about whether a
     * soft-deleted row actually disappears from the list. The integration
     * test deletes a row and asserts it is gone from both reads.
     *
     * What remains below is what no test of the usecases can see: the
     * SCHEMA and MIGRATION shape (columns, indexes, RLS policies), the
     * encryption manifest entry, the ROUTE wiring, and the page/header
     * links that make the feature reachable.
     */
    test('list route exposes GET (list) + POST (record) with the validated body', () => {
        expect(listRoute).toMatch(/export const GET = withApiErrorHandling/);
        expect(listRoute).toMatch(/export const POST = withApiErrorHandling/);
        expect(listRoute).toMatch(/withValidatedBody\(NewSchema/);
        expect(listRoute).toMatch(/occurredAt: z\.string\(\)\.refine/);
        expect(listRoute).toMatch(/amount: z\.number\(\)\.finite\(\)\.nonnegative\(\)/);
        expect(listRoute).toMatch(/source: z\.enum\(\['USER', 'FINDING', 'INCIDENT'\]/);
    });

    test('aggregate + item routes wire the usecase verbs', () => {
        expect(aggregateRoute).toMatch(/getLossEventAggregate/);
        expect(itemRoute).toMatch(/export const DELETE = withApiErrorHandling/);
        expect(itemRoute).toMatch(/deleteLossEvent/);
    });
});

describe('RQ3-6 — the register page surfaces the predicted-vs-actual overlay', () => {
    test('page renders the roll-up, empty-state explanation, the form, and the register', () => {
        expect(page).toMatch(/data-testid="loss-events-rollup"/);
        expect(page).toMatch(/loss-events-empty/);
        expect(page).toMatch(/t\('lossEvents\.emptyActuals'\)/);
        expect(enMessages.risks.lossEvents.emptyActuals).toMatch(/forecasting stack is unfalsifiable/);
        expect(page).toMatch(/loss-events-form/);
        expect(page).toMatch(/loss-events-list/);
        expect(page).toMatch(/loss-events-by-year/);
        expect(page).toMatch(/loss-events-prediction-line/);
    });

    test('the risks header links the new page so people can find it', () => {
        expect(risksClient).toMatch(/href: '\/risks\/loss-events'/);
    });
});
