/**
 * Two requests in flight must not see each other's tenant.
 *
 * The audit context decides which DEK the encryption extension uses. Until
 * 2026-08-10 it was a module-level LIFO stack, defended as safe because "Node
 * is single-threaded". Single-threaded rules out parallelism, not concurrency:
 * the stack was shared by every in-flight request, and the moment one awaited,
 * another pushed on top of it. The first request's next Prisma call then read
 * the top of the stack — someone else's tenant — and sealed its rows with that
 * tenant's key.
 *
 * These tests interleave on purpose. Every one of them passes trivially with a
 * single request in flight, which is why the stack survived so long: nothing
 * exercised two.
 *
 * Measured cost before the fix: 613 cross-tenant writes in one CI run, 15
 * ambient tenants against 16 row tenants, surfacing later as
 * `DecryptIntegrityError` 500s on unrelated reads.
 */
import {
    runWithAuditContext,
    getAuditContext,
    mergeAuditContext,
} from '@/lib/audit-context';

/** Yield to the event loop so another "request" can interleave here. */
const yieldTurn = () => new Promise((r) => setImmediate(r));

describe('concurrent contexts do not bleed', () => {
    it('each request sees its OWN tenant across an await', async () => {
        // The exact interleaving the stack got wrong:
        //   A pushes, A awaits, B pushes, A reads → used to be B.
        const seen: Record<string, string | undefined> = {};

        const requestA = runWithAuditContext({ tenantId: 'tenant-A' }, async () => {
            await yieldTurn();
            await yieldTurn();
            seen.A = getAuditContext()?.tenantId;
        });

        const requestB = runWithAuditContext({ tenantId: 'tenant-B' }, async () => {
            await yieldTurn();
            seen.B = getAuditContext()?.tenantId;
        });

        await Promise.all([requestA, requestB]);
        expect(seen).toEqual({ A: 'tenant-A', B: 'tenant-B' });
    });

    it('a request finishing early cannot tear down another\'s context', async () => {
        // `pop()` removed whatever was on TOP, not the entry that call pushed.
        // So a short request completing inside a long one destroyed the long
        // one's frame, and the long one continued with no context at all —
        // which silently downgrades writes to the global KEK.
        let lateReading: string | undefined = 'unset';

        const long = runWithAuditContext({ tenantId: 'tenant-long' }, async () => {
            await yieldTurn();
            await yieldTurn();
            await yieldTurn();
            lateReading = getAuditContext()?.tenantId;
        });

        const short = runWithAuditContext({ tenantId: 'tenant-short' }, async () => {
            await yieldTurn();
        });

        await Promise.all([short, long]);
        expect(lateReading).toBe('tenant-long');
    });

    it('holds under many interleaved requests', async () => {
        // The E2E shape: lots of concurrent tenants, each doing several awaits.
        const ids = Array.from({ length: 25 }, (_, i) => `tenant-${i}`);
        const results = await Promise.all(
            ids.map((id) =>
                runWithAuditContext({ tenantId: id }, async () => {
                    await yieldTurn();
                    const mid = getAuditContext()?.tenantId;
                    await yieldTurn();
                    const end = getAuditContext()?.tenantId;
                    return [mid, end];
                }),
            ),
        );
        results.forEach(([mid, end], i) => {
            expect(mid).toBe(ids[i]);
            expect(end).toBe(ids[i]);
        });
    });
});

describe('nesting', () => {
    it('an inner context shadows only its own subtree', async () => {
        await runWithAuditContext({ tenantId: 'outer' }, async () => {
            expect(getAuditContext()?.tenantId).toBe('outer');
            await runWithAuditContext({ tenantId: 'inner' }, async () => {
                await yieldTurn();
                expect(getAuditContext()?.tenantId).toBe('inner');
            });
            // Restored without anyone popping anything.
            expect(getAuditContext()?.tenantId).toBe('outer');
        });
    });

    it('restores the outer context even when the inner one throws', async () => {
        await runWithAuditContext({ tenantId: 'outer' }, async () => {
            await expect(
                runWithAuditContext({ tenantId: 'inner' }, async () => {
                    throw new Error('boom');
                }),
            ).rejects.toThrow('boom');
            expect(getAuditContext()?.tenantId).toBe('outer');
        });
    });
});

describe('the surrounding contract still holds', () => {
    it('returns the callback value for an async fn', async () => {
        await expect(
            runWithAuditContext({ tenantId: 't' }, async () => 42),
        ).resolves.toBe(42);
    });

    it('supports a synchronous callback', () => {
        expect(runWithAuditContext({ tenantId: 't' }, () => getAuditContext()?.tenantId)).toBe('t');
    });

    it('is undefined outside any context', () => {
        expect(getAuditContext()).toBeUndefined();
    });

    it('mergeAuditContext updates the live context and reports success', async () => {
        await runWithAuditContext({ tenantId: 't' }, async () => {
            expect(mergeAuditContext({ actorUserId: 'u1' })).toBe(true);
            await yieldTurn();
            expect(getAuditContext()).toMatchObject({ tenantId: 't', actorUserId: 'u1' });
        });
    });

    it('mergeAuditContext reports failure outside a context', () => {
        expect(mergeAuditContext({ actorUserId: 'u1' })).toBe(false);
    });

    it('a merge inside one request is invisible to another', async () => {
        // The aliasing half of the old bug: contexts were shared objects, so a
        // merge could reach across requests.
        let bSaw: string | undefined;
        await Promise.all([
            runWithAuditContext({ tenantId: 'A' }, async () => {
                await yieldTurn();
                mergeAuditContext({ actorUserId: 'user-A' });
            }),
            runWithAuditContext({ tenantId: 'B' }, async () => {
                await yieldTurn();
                await yieldTurn();
                bSaw = getAuditContext()?.actorUserId;
            }),
        ]);
        expect(bSaw).toBeUndefined();
    });

    it('does not mutate the caller\'s object', async () => {
        // Entering with a shared literal must not let the callee write back
        // into something the caller still holds.
        const caller = { tenantId: 'A' };
        await runWithAuditContext(caller, async () => {
            mergeAuditContext({ actorUserId: 'u' });
        });
        expect(caller).toEqual({ tenantId: 'A' });
    });
});
