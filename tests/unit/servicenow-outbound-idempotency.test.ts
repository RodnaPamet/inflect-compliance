/**
 * A retried outbound write produces exactly one incident.
 *
 * This is the property the whole design exists for, so the central test
 * SIMULATES THE REAL FAILURE rather than asserting on the pieces: a create that
 * succeeds remotely and then dies before the id is recorded, followed by the
 * retry BullMQ will automatically perform (`attempts: 3`, exponential backoff —
 * retry is the normal case, not an edge case).
 *
 * WHY THE DATABASE CONSTRAINT DOES NOT COVER THIS, since it looks like it
 * should: `IntegrationSyncMapping` is unique on (tenant, provider, localType,
 * localId), and that constraint holds perfectly throughout the sequence below.
 * There is one mapping row and — without the correlation id — two incidents.
 * The constraint makes the MAPPING idempotent; only a correlation id the remote
 * can be queried by makes the WRITE idempotent.
 */
import { ensureRemoteRecord } from '@/app-layer/integrations/providers/servicenow/outbound';
import { correlationIdFor, isInflectCorrelationId, CORRELATION_PREFIX } from '@/app-layer/integrations/providers/servicenow/correlation';

const IDENTITY = {
    tenantId: 't1',
    provider: 'servicenow',
    localEntityType: 'finding',
    localEntityId: 'f-123',
};

const DATA = { short_description: 'Control CC6.1 failed', urgency: '2' };

/**
 * A fake ServiceNow that behaves like the real one in the only respect that
 * matters: a created record is retrievable by its correlation id afterwards.
 *
 * `failAfterCreate` reproduces the dangerous window precisely — the record is
 * stored (the POST reached ServiceNow) and THEN the call throws, which is what
 * a socket timeout or a pod eviction looks like from here.
 */
function fakeServiceNow(opts: { failAfterCreate?: boolean } = {}) {
    const records: Array<{ sys_id: string; correlation_id: string; data: Record<string, unknown> }> = [];
    let nextId = 1;
    const createCalls: Array<Record<string, unknown>> = [];
    const updateCalls: Array<[string, Record<string, unknown>]> = [];

    return {
        records,
        createCalls,
        updateCalls,
        async findByCorrelationId(correlationId: string) {
            const hits = records.filter((r) => r.correlation_id === correlationId);
            if (hits.length === 0) return null;
            if (hits.length > 1) throw new Error('more than one record');
            return { remoteId: hits[0].sys_id, data: hits[0].data as never };
        },
        async createRemoteObject(data: Record<string, unknown>, correlationId?: string) {
            if (!correlationId) throw new Error('correlation id required');
            createCalls.push(data);
            const sys_id = `INC${String(nextId++).padStart(7, '0')}`;
            // The write REACHES ServiceNow before the failure — that is the
            // whole point. A fake that threw before storing would prove nothing.
            records.push({ sys_id, correlation_id: correlationId, data });
            if (opts.failAfterCreate) throw new Error('socket hang up');
            return { remoteId: sys_id, data: data as never };
        },
        async updateRemoteObject(remoteId: string, changes: Record<string, unknown>) {
            updateCalls.push([remoteId, changes]);
            return { remoteId, data: changes as never };
        },
    };
}

describe('a forced mid-write failure plus its retry produces ONE incident', () => {
    it('the crash-then-retry sequence, end to end', async () => {
        const sn = fakeServiceNow({ failAfterCreate: true });
        let recordedRemoteId: string | null = null;
        const recordRemoteId = async (id: string) => { recordedRemoteId = id; };

        // ── Attempt 1: the POST lands, the process dies before step 4.
        await expect(
            ensureRemoteRecord({
                client: sn as never,
                identity: IDENTITY,
                data: DATA,
                knownRemoteId: null,
                recordRemoteId,
            }),
        ).rejects.toThrow('socket hang up');

        // The remote record EXISTS and we never learned its id. This is the
        // window; everything below is about surviving it.
        expect(sn.records).toHaveLength(1);
        expect(recordedRemoteId).toBeNull();

        // ── Attempt 2: BullMQ retries. Same inputs, same identity.
        // The SAME fake, so the first attempt's record is still there — but
        // creates are counted separately so a second one is unmistakable.
        const createSpy = jest.fn(sn.createRemoteObject);
        const retryClient = { ...sn, createRemoteObject: createSpy };

        const result = await ensureRemoteRecord({
            client: retryClient as never,
            identity: IDENTITY,
            data: DATA,
            knownRemoteId: null,
            recordRemoteId,
        });

        // THE ASSERTION THIS FILE EXISTS FOR.
        expect(sn.records).toHaveLength(1);
        expect(createSpy).not.toHaveBeenCalled();
        expect(result.action).toBe('adopted');
        expect(result.remoteId).toBe('INC0000001');
        expect(recordedRemoteId).toBe('INC0000001');
    });

    it('a third attempt still adopts — the property does not decay with retries', async () => {
        // attempts: 3, so the sequence really can run three times.
        const sn = fakeServiceNow();
        const rec = jest.fn(async () => {});
        await ensureRemoteRecord({ client: sn as never, identity: IDENTITY, data: DATA, recordRemoteId: rec });
        for (let i = 0; i < 2; i++) {
            const r = await ensureRemoteRecord({
                client: sn as never, identity: IDENTITY, data: DATA, knownRemoteId: null, recordRemoteId: rec,
            });
            expect(r.action).toBe('adopted');
        }
        expect(sn.records).toHaveLength(1);
        expect(sn.createCalls).toHaveLength(1);
    });
});

describe('the ordering the safety property depends on', () => {
    it('asks the remote BEFORE creating', async () => {
        const sn = fakeServiceNow();
        const order: string[] = [];
        const client = {
            findByCorrelationId: async (id: string) => { order.push('find'); return sn.findByCorrelationId(id); },
            createRemoteObject: async (d: Record<string, unknown>, c?: string) => { order.push('create'); return sn.createRemoteObject(d, c); },
            updateRemoteObject: sn.updateRemoteObject,
        };
        await ensureRemoteRecord({ client: client as never, identity: IDENTITY, data: DATA, recordRemoteId: async () => {} });
        expect(order).toEqual(['find', 'create']);
    });

    it('records the id IMMEDIATELY after the create, with nothing in between', async () => {
        // Every instruction between the remote write and this call widens the
        // window the whole design exists to close.
        const sn = fakeServiceNow();
        const order: string[] = [];
        const client = {
            findByCorrelationId: sn.findByCorrelationId,
            createRemoteObject: async (d: Record<string, unknown>, c?: string) => { order.push('create'); return sn.createRemoteObject(d, c); },
            updateRemoteObject: sn.updateRemoteObject,
        };
        await ensureRemoteRecord({
            client: client as never, identity: IDENTITY, data: DATA,
            recordRemoteId: async () => { order.push('record'); },
        });
        expect(order).toEqual(['create', 'record']);
    });

    it('a known remote id UPDATES and never queries or creates', async () => {
        const sn = fakeServiceNow();
        const find = jest.fn(sn.findByCorrelationId);
        const create = jest.fn(sn.createRemoteObject);
        const r = await ensureRemoteRecord({
            client: { ...sn, findByCorrelationId: find, createRemoteObject: create } as never,
            identity: IDENTITY,
            data: DATA,
            knownRemoteId: 'INC0009999',
            recordRemoteId: async () => {},
        });
        expect(r.action).toBe('updated');
        expect(find).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(sn.updateCalls).toEqual([['INC0009999', DATA]]);
    });

    it('a create returning no sys_id throws rather than recording an empty id', async () => {
        // The record IS stamped, so the next attempt adopts it. Continuing here
        // would record '' and make the mapping permanently unlinkable.
        const client = {
            findByCorrelationId: async () => null,
            createRemoteObject: async () => ({ remoteId: '', data: {} }),
            updateRemoteObject: async () => ({ remoteId: '', data: {} }),
        };
        const rec = jest.fn();
        await expect(
            ensureRemoteRecord({ client: client as never, identity: IDENTITY, data: DATA, recordRemoteId: rec }),
        ).rejects.toThrow(/no sys_id/);
        expect(rec).not.toHaveBeenCalled();
    });

    it('adopting does not also mutate the record', async () => {
        // The caller asked to ensure it exists. Adopt-then-update turns a
        // recovery into a second mutation, and the case that reaches adopt is a
        // crash mid-create where the local data has not changed since.
        const sn = fakeServiceNow();
        await ensureRemoteRecord({ client: sn as never, identity: IDENTITY, data: DATA, recordRemoteId: async () => {} });
        await ensureRemoteRecord({ client: sn as never, identity: IDENTITY, data: DATA, knownRemoteId: null, recordRemoteId: async () => {} });
        expect(sn.updateCalls).toEqual([]);
    });
});

describe('the correlation id is stable, scoped, and safe to write into a customer instance', () => {
    it('is identical across calls — nothing per-attempt goes into it', async () => {
        // A timestamp, attempt counter or random makes every retry a fresh
        // record: the defect wearing the fix's clothes.
        expect(correlationIdFor(IDENTITY)).toBe(correlationIdFor({ ...IDENTITY }));
    });

    it('differs for every component of identity', () => {
        const base = correlationIdFor(IDENTITY);
        expect(correlationIdFor({ ...IDENTITY, tenantId: 't2' })).not.toBe(base);
        expect(correlationIdFor({ ...IDENTITY, provider: 'jira' })).not.toBe(base);
        expect(correlationIdFor({ ...IDENTITY, localEntityType: 'task' })).not.toBe(base);
        expect(correlationIdFor({ ...IDENTITY, localEntityId: 'f-124' })).not.toBe(base);
    });

    it.each([[':'], ['\n'], ['|'], ['\u0000']])('does not collide on a %j in a component', (sep) => {
        // Any separator-join collides when a component can contain the
        // separator, and `localEntityType` is a free-form string. The `\n` case
        // is not hypothetical — it was the shipped implementation, and its twin
        // in the calendar reconciler failed exactly this assertion.
        const a = correlationIdFor({ ...IDENTITY, localEntityType: `find${sep}ing`, localEntityId: 'x' });
        const b = correlationIdFor({ ...IDENTITY, localEntityType: 'find', localEntityId: `ing${sep}x` });
        expect(a).not.toBe(b);
    });

    it('fits the 40-character column', () => {
        // A truncated concatenation would collide unpredictably instead.
        const long = correlationIdFor({
            tenantId: 'c'.repeat(40), provider: 'servicenow',
            localEntityType: 'a-very-long-entity-type-name', localEntityId: 'd'.repeat(40),
        });
        expect(long.length).toBeLessThanOrEqual(40);
    });

    it('carries no tenant or entity id in plain text', () => {
        // It lands in a CUSTOMER'S instance, visible to every ITSM user and
        // carried into every report they export.
        const id = correlationIdFor(IDENTITY);
        expect(id).not.toContain('t1');
        expect(id).not.toContain('f-123');
        expect(id).not.toContain('finding');
    });

    it('is recognisable as ours', () => {
        expect(isInflectCorrelationId(correlationIdFor(IDENTITY))).toBe(true);
        expect(correlationIdFor(IDENTITY).startsWith(CORRELATION_PREFIX)).toBe(true);
        expect(isInflectCorrelationId('CHG0001-manual')).toBe(false);
    });
});
