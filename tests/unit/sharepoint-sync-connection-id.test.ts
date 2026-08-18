/**
 * The manual-sync `connectionId` reaches a Redis key before anything checks it.
 *
 * `dispatchJobId` interpolates it into the BullMQ job id, and the route does
 * that BEFORE resolving the connection — so `z.string().min(1)` allowed a tenant
 * member to put arbitrary content of arbitrary length into a key, along with
 * whatever indexes or logs that key flows into.
 *
 * These assertions are on the schema rather than the route because the schema is
 * where the property lives: the route cannot become safe again while the schema
 * accepts an unbounded string, and it cannot become unsafe while the schema
 * does not.
 */
import { z } from 'zod';
import fs from 'node:fs';

/**
 * Mirrors the route's Body schema.
 *
 * Duplicated deliberately: the route module pulls in NextRequest, the permission
 * middleware and the job queue, so importing it would test the import graph
 * rather than the validation. The structural assertion at the bottom is what
 * keeps the two from drifting.
 */
const ConnectionId = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'connectionId must be an opaque identifier');

describe('connectionId is bounded before it becomes a Redis key', () => {
    it('accepts the id shapes this system actually issues', () => {
        // cuid (Prisma default), plus uuid / nanoid in case that ever changes.
        for (const id of [
            'cmsyhh8m9000ajvaniiqkgnhh',
            '550e8400-e29b-41d4-a716-446655440000',
            'V1StGXR8_Z5jdHi6B-myT',
        ]) {
            expect(ConnectionId.safeParse(id).success).toBe(true);
        }
    });

    it.each([
        ['a newline', 'abc\ndef'],
        ['a carriage return', 'abc\rdef'],
        ['a null byte', 'abc\u0000def'],
        ['a colon, which the job id joins on', 'abc:def'],
        ['whitespace', 'abc def'],
        ['an empty string', ''],
    ])('rejects %s', (_label, value) => {
        expect(ConnectionId.safeParse(value).success).toBe(false);
    });

    it('rejects a length that would bloat the key', () => {
        expect(ConnectionId.safeParse('a'.repeat(10_000)).success).toBe(false);
        expect(ConnectionId.safeParse('a'.repeat(64)).success).toBe(true);
        expect(ConnectionId.safeParse('a'.repeat(65)).success).toBe(false);
    });

    it('the route still uses this exact bound', () => {
        // Guards the duplication above. If the route relaxes its schema this
        // fails, rather than leaving a green test protecting a schema nothing
        // uses — the shape that made a stale descriptor assertion pass earlier
        // this week.
        const src = fs.readFileSync(
            'src/app/api/t/[tenantSlug]/integrations/sharepoint/sync/route.ts',
            'utf8',
        );
        expect(src).toMatch(/\.max\(64\)/);
        expect(src).toMatch(/\^\[A-Za-z0-9_-\]\+\$/);
    });
});
