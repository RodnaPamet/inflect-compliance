/**
 * Unit tests for email enqueue dedupe logic and outbox processing.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { buildDedupeKey } from '@/app-layer/notifications/enqueue';
import { hashForLookup } from '@/lib/security/encryption';
import { codeOf } from '../helpers/source-blocks';

describe('buildDedupeKey', () => {
    it('produces the correct format, with the recipient HASHED (#3577)', () => {
        const date = new Date('2026-03-17T10:00:00Z');
        const key = buildDedupeKey('tenant-1', 'TASK_ASSIGNED', 'alice@acme.com', 'task-42', date);
        // Derived from `hashForLookup`, not written as a literal: the digest
        // depends on `DATA_ENCRYPTION_KEY`, so a hardcoded hex string would
        // pass only in whichever environment it was captured from.
        expect(key).toBe(
            `tenant-1:TASK_ASSIGNED:${hashForLookup('alice@acme.com')}:task-42:2026-03-17`,
        );
    });

    it('carries no address, which is the whole point (#3577)', () => {
        // THE PROPERTY, asserted on its own so it cannot be lost in a format
        // change. This key used to embed the address, giving the row a SECOND
        // copy of personal data — in a uniquely-indexed column with no
        // retention rule — that redacting `toEmail` would have missed.
        const key = buildDedupeKey('t1', 'TASK_ASSIGNED', 'alice@acme.com', 'x', new Date('2026-03-17'));
        expect(key).not.toContain('alice@acme.com');
        expect(key).not.toContain('alice');
        expect(key).not.toContain('acme.com');
        expect(key).not.toContain('@');
    });

    it('is KEYED, not a bare digest (#3577)', () => {
        // An unkeyed SHA-256 of a corporate address is reversible by dictionary
        // attack over a known user base, so it would pseudonymise nothing.
        // Asserted by showing the segment is NOT the plain digest anyone could
        // compute without the key.
        const email = 'alice@acme.com';
        const plain = createHash('sha256').update(email).digest('hex');
        const key = buildDedupeKey('t1', 'TASK_ASSIGNED', email, 'x', new Date('2026-03-17'));
        expect(key).not.toContain(plain);
        expect(key).toContain(hashForLookup(email));
    });

    it('treats one mailbox as one recipient, whatever the casing (#3577)', () => {
        // THE ONE BEHAVIOUR CHANGE, asserted rather than left to be discovered.
        // `hashForLookup` lowercases and trims, so these now dedupe together —
        // more correct, since it is one mailbox, and measured safe against
        // production first: 1,085 rows produce 1,085 distinct keys with 0
        // colliding groups.
        const date = new Date('2026-03-17');
        expect(buildDedupeKey('t1', 'TASK_ASSIGNED', 'Alice@Acme.com', 'x', date)).toBe(
            buildDedupeKey('t1', 'TASK_ASSIGNED', '  alice@acme.com ', 'x', date),
        );
    });

    it('uses current date if none provided', () => {
        const key = buildDedupeKey('tenant-1', 'TASK_ASSIGNED', 'alice@acme.com', 'task-42');
        const today = new Date().toISOString().slice(0, 10);
        expect(key).toContain(today);
    });

    it('produces different keys for different types', () => {
        const date = new Date('2026-03-17');
        const key1 = buildDedupeKey('t1', 'TASK_ASSIGNED', 'a@b.com', 'x', date);
        const key2 = buildDedupeKey('t1', 'EVIDENCE_EXPIRING', 'a@b.com', 'x', date);
        expect(key1).not.toBe(key2);
    });

    it('produces different keys for different tenants', () => {
        const date = new Date('2026-03-17');
        const key1 = buildDedupeKey('t1', 'TASK_ASSIGNED', 'a@b.com', 'x', date);
        const key2 = buildDedupeKey('t2', 'TASK_ASSIGNED', 'a@b.com', 'x', date);
        expect(key1).not.toBe(key2);
    });

    it('produces different keys for different recipients', () => {
        const date = new Date('2026-03-17');
        const key1 = buildDedupeKey('t1', 'TASK_ASSIGNED', 'alice@b.com', 'x', date);
        const key2 = buildDedupeKey('t1', 'TASK_ASSIGNED', 'bob@b.com', 'x', date);
        expect(key1).not.toBe(key2);
    });

    it('produces different keys for different days', () => {
        const key1 = buildDedupeKey('t1', 'TASK_ASSIGNED', 'a@b.com', 'x', new Date('2026-03-17'));
        const key2 = buildDedupeKey('t1', 'TASK_ASSIGNED', 'a@b.com', 'x', new Date('2026-03-18'));
        expect(key1).not.toBe(key2);
    });

    it('produces same key for same inputs on same day', () => {
        const date = new Date('2026-03-17T08:00:00Z');
        const key1 = buildDedupeKey('t1', 'TASK_ASSIGNED', 'a@b.com', 'x', date);
        const date2 = new Date('2026-03-17T22:00:00Z');
        const key2 = buildDedupeKey('t1', 'TASK_ASSIGNED', 'a@b.com', 'x', date2);
        expect(key1).toBe(key2);
    });
});

/**
 * The dedupe key must not grow an address back (#3577).
 *
 * The behavioural tests above prove today's key carries no address. They cannot
 * stop someone reintroducing one, because the obvious way to do that is to edit
 * the template string — and a future author changing the format would most
 * naturally update the behavioural expectations alongside it, since they are
 * derived from `hashForLookup`.
 *
 * So this reads the construction itself. Narrow on purpose: one assertion about
 * one template literal, over a MASKED read, because this file's own prose names
 * the thing it forbids.
 */
describe('the key construction cannot reintroduce the address (#3577)', () => {
    const source = codeOf(
        readFileSync(
            path.resolve(__dirname, '../../src/app-layer/notifications/enqueue.ts'),
            'utf-8',
        ),
    );

    it('reads CODE, not the comment explaining it', () => {
        // The mask, proved. The function's docstring explains at length why the
        // address is hashed, and says the word `email` repeatedly — so an
        // unmasked read would be satisfied by the explanation.
        expect(source.length).toBeGreaterThan(500);
        expect(source).not.toContain('SECOND copy of personal data');
    });

    it('interpolates the HASH into the key, never the address', () => {
        // The one line that matters. `${hashForLookup(email)}` is the fix;
        // `${email}` was the defect.
        expect(source).toContain('${hashForLookup(email)}');
        expect(source).not.toContain(':${email}:');
    });

    it('builds exactly one dedupe key, so there is no second construction', () => {
        // Counted: a second template producing a key — in a helper, a migration
        // shim, a "legacy format" fallback — is how the address would come back
        // without touching the line above.
        const templates = source.split('${hashForLookup(email)}').length - 1;
        expect(templates).toBe(1);
    });
});
