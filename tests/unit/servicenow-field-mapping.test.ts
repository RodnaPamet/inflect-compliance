/**
 * An incomplete mapping refuses the write instead of producing a partial record.
 *
 * ServiceNow instances are heavily customised, so the field mapping has to be
 * per-connection config — and the moment it is configurable, it can be
 * configured wrong.
 *
 * WHAT GOES WRONG IF IT DOES NOT FAIL CLOSED. `BaseFieldMapper.toRemotePartial`
 * skips an unmapped field with a bare `continue` (base-mapper.ts:125), which is
 * correct for an optional field and catastrophic for a required one — and the
 * two are indistinguishable to it, because nothing tells it which is which.
 *
 * So a connection whose mapping omits `urgency` writes an incident with no
 * urgency. Our side sees 201 and reports the sync green. Their side has a record
 * that matches no priority-based assignment rule: nobody is paged, nobody knows
 * it exists. A record that looks successful on one side and is useless on the
 * other, with no signal anywhere, is exactly the class of failure a compliance
 * product cannot ship.
 *
 * So the assertions are mostly "and no request was made" rather than "an error
 * was thrown" — an error thrown after the POST is not a refusal.
 */
import {
    assertMappingComplete,
    resolveOutboundMappings,
    ServiceNowMappingError,
    REQUIRED_OUTBOUND_FIELDS,
} from '@/app-layer/integrations/providers/servicenow/field-mapping';
import { ensureRemoteRecord } from '@/app-layer/integrations/providers/servicenow/outbound';

const INCIDENT_DEFAULTS = {
    title: 'short_description',
    description: 'description',
    urgency: 'urgency',
    assignee: 'assigned_to',
};

const IDENTITY = {
    tenantId: 't1',
    provider: 'servicenow',
    localEntityType: 'finding',
    localEntityId: 'f-1',
};

describe('a complete mapping passes', () => {
    it('accepts the defaults', () => {
        expect(() => assertMappingComplete('incident', INCIDENT_DEFAULTS)).not.toThrow();
    });

    it('accepts custom target columns — the point of making it configurable', () => {
        // u_-prefixed custom fields are the normal case at a customised
        // instance, not an exotic one.
        expect(() =>
            assertMappingComplete('incident', {
                ...INCIDENT_DEFAULTS,
                urgency: 'u_inflect_severity',
                title: 'u_headline',
            }),
        ).not.toThrow();
    });
});

describe('an incomplete mapping is refused, by name', () => {
    it.each(REQUIRED_OUTBOUND_FIELDS.incident)('names %s when it has no target', (field) => {
        const broken = { ...INCIDENT_DEFAULTS } as Record<string, string>;
        delete broken[field];
        try {
            assertMappingComplete('incident', broken);
            throw new Error('expected a refusal');
        } catch (e) {
            expect(e).toBeInstanceOf(ServiceNowMappingError);
            expect((e as ServiceNowMappingError).missingFields).toEqual([field]);
            // The message has to name the field — "mapping incomplete" sends an
            // admin back to a form with no idea which row is wrong.
            expect((e as Error).message).toContain(field);
        }
    });

    it('reports EVERY missing field, not just the first', () => {
        // One at a time makes an admin rediscover the requirement list by
        // trial, and each cycle is a round trip through a test connection.
        try {
            assertMappingComplete('incident', { description: 'description' });
            throw new Error('expected a refusal');
        } catch (e) {
            expect((e as ServiceNowMappingError).missingFields.sort()).toEqual(['title', 'urgency']);
        }
    });

    it('treats a BLANK target as missing', () => {
        // Likelier than an absent one: an admin who cleared a form field rather
        // than one who never filled it in.
        for (const blank of ['', '   ']) {
            expect(() => assertMappingComplete('incident', { ...INCIDENT_DEFAULTS, urgency: blank })).toThrow(
                ServiceNowMappingError,
            );
        }
    });

    it('refuses an UNKNOWN record type rather than skipping validation', () => {
        // Fail-closed reading. The alternative is that a typo'd record type
        // silently skips validation entirely — turning this whole module off
        // for exactly the connection that typo'd it.
        expect(() => assertMappingComplete('inciden', INCIDENT_DEFAULTS)).toThrow(ServiceNowMappingError);
    });

    it('change_request has its own requirement list', () => {
        // A change with no type cannot enter an approval workflow at all — the
        // workflow is selected BY type — so it lands where no approver sees it.
        expect(() => assertMappingComplete('change_request', { title: 't', description: 'd' })).toThrow(
            /changeType/,
        );
    });
});

describe('no remote write happens when the mapping is incomplete', () => {
    function spyClient() {
        return {
            findByCorrelationId: jest.fn(async () => null),
            createRemoteObject: jest.fn(async () => ({ remoteId: 'INC1', data: {} })),
            updateRemoteObject: jest.fn(async () => ({ remoteId: 'INC1', data: {} })),
        };
    }

    it('refuses BEFORE querying or creating', async () => {
        // The assertion this file exists for. An error thrown after the POST is
        // not a refusal — the unroutable record is already in their queue.
        const client = spyClient();
        const recordRemoteId = jest.fn(async () => {});
        await expect(
            ensureRemoteRecord({
                client: client as never,
                identity: IDENTITY,
                data: { short_description: 'x' },
                recordRemoteId,
                mapping: { recordType: 'incident', mappings: { description: 'description' } },
            }),
        ).rejects.toBeInstanceOf(ServiceNowMappingError);

        expect(client.findByCorrelationId).not.toHaveBeenCalled();
        expect(client.createRemoteObject).not.toHaveBeenCalled();
        expect(client.updateRemoteObject).not.toHaveBeenCalled();
        expect(recordRemoteId).not.toHaveBeenCalled();
    });

    it('refuses an UPDATE too, not only a create', async () => {
        // A known remote id takes the update branch, which would otherwise skip
        // the check entirely — and an update that blanks a required field is
        // the same unroutable record, arriving later.
        const client = spyClient();
        await expect(
            ensureRemoteRecord({
                client: client as never,
                identity: IDENTITY,
                data: { short_description: 'x' },
                knownRemoteId: 'INC0009',
                recordRemoteId: async () => {},
                mapping: { recordType: 'incident', mappings: { description: 'description' } },
            }),
        ).rejects.toBeInstanceOf(ServiceNowMappingError);
        expect(client.updateRemoteObject).not.toHaveBeenCalled();
    });

    it('a complete mapping writes normally', async () => {
        const client = spyClient();
        const r = await ensureRemoteRecord({
            client: client as never,
            identity: IDENTITY,
            data: { short_description: 'x' },
            recordRemoteId: async () => {},
            mapping: { recordType: 'incident', mappings: INCIDENT_DEFAULTS },
        });
        expect(r.action).toBe('created');
        expect(client.createRemoteObject).toHaveBeenCalled();
    });
});

describe('resolveOutboundMappings', () => {
    it('overlays custom targets onto the defaults', () => {
        const m = resolveOutboundMappings(INCIDENT_DEFAULTS, { urgency: 'u_sev' });
        expect(m.urgency).toBe('u_sev');
        expect(m.title).toBe('short_description');
    });

    it('ignores non-string targets rather than coercing them', () => {
        // A number or object becomes "[object Object]" as a column name and
        // fails at the ServiceNow API — a worse place to learn about it than
        // here, where the connection form can say so.
        const m = resolveOutboundMappings(INCIDENT_DEFAULTS, { urgency: 3, title: { a: 1 } });
        expect(m.urgency).toBe('urgency');
        expect(m.title).toBe('short_description');
    });

    it('survives junk config without throwing', () => {
        for (const junk of [null, undefined, 'nope', 42, ['a']]) {
            expect(resolveOutboundMappings(INCIDENT_DEFAULTS, junk)).toEqual(INCIDENT_DEFAULTS);
        }
    });

    it('does not mutate the defaults', () => {
        // They are module-level and shared across every connection; mutating
        // them would let one tenant's custom mapping leak into another's.
        const before = { ...INCIDENT_DEFAULTS };
        resolveOutboundMappings(INCIDENT_DEFAULTS, { urgency: 'u_sev' });
        expect(INCIDENT_DEFAULTS).toEqual(before);
    });
});
