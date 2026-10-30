/**
 * ROUTING AN ERP'S ROWS TO AN EXTERNAL MODEL IS A TRANSFER (M5, #3872).
 *
 * The pure half of constraint 3. Which runs are refused is decided here with no
 * database; the wiring that reads the tenant's acknowledgement and settles the
 * run is covered where it lives.
 *
 * The case worth reading twice is `reachesBusinessSystem: null`. Everything
 * else in this subsystem fails CLOSED, so proceeding on NULL looks like the
 * wrong direction — and it is the right one, for a reason the module states:
 * fail-closed is correct for AUTHORITY and wrong for a CLAIM ABOUT THE WORLD.
 * NULL is nobody having reviewed the connection, which is not evidence that it
 * carries an ERP's rows; acting on it would refuse nearly every run for a
 * reason about our own bookkeeping.
 */
import { FLUE_PROVIDER_IDS } from '@/lib/agentic/flue/model-selection';
import {
    businessSystemConnections,
    externalResidencyRefusal,
    isAcknowledged,
    type OfferedExternalTool,
} from '@/lib/agentic/external-residency-gate';

const tool = (
    name: string,
    reachesBusinessSystem: boolean | null,
    connectionName = 'SAP production',
): OfferedExternalTool => ({
    name,
    connectionId: `conn-${connectionName}`,
    connectionName,
    reachesBusinessSystem,
});

const ACKED = { at: new Date('2026-10-29T12:00:00.000Z'), byUserId: 'u-1' };
const UNACKED = { at: null, byUserId: null };

describe('a run that stays inside the deployment transfers nothing', () => {
    it('proceeds on the LOCAL provider even with business data and no acknowledgement', () => {
        // The control for the whole gate. `inflect-local` is the answer the
        // roadmap names for exactly this case, so it must not be refused — a
        // gate that refused here would make the acknowledgement compulsory for
        // a tenant that had already chosen the stricter option.
        expect(
            externalResidencyRefusal({
                providerId: FLUE_PROVIDER_IDS.local,
                offered: [tool('sap__read_orders', true)],
                acknowledgement: UNACKED,
            }),
        ).toBeNull();
    });
});

describe('an EXTERNAL run over a business-system connection', () => {
    it('is refused when nobody has acknowledged the transfer, and the refusal names the connection', () => {
        const refusal = externalResidencyRefusal({
            providerId: FLUE_PROVIDER_IDS.external,
            offered: [tool('sap__read_orders', true)],
            acknowledgement: UNACKED,
        });
        expect(refusal?.reason).toBe('EXTERNAL_AI_BUSINESS_DATA_UNACKNOWLEDGED');
        // An admin cannot act on "a connection".
        expect(refusal?.connectionNames).toEqual(['SAP production']);
        expect(refusal?.message).toContain('SAP production');
        // And it says BOTH ways out, because one of them is a setting the
        // tenant may prefer to the acknowledgement.
        expect(refusal?.message).toContain('LOCAL_ONLY');
        expect(refusal?.message).toContain('acknowledgement');
    });

    it('proceeds once the acknowledgement is recorded', () => {
        expect(
            externalResidencyRefusal({
                providerId: FLUE_PROVIDER_IDS.external,
                offered: [tool('sap__read_orders', true)],
                acknowledgement: ACKED,
            }),
        ).toBeNull();
    });

    it('is refused by an acknowledgement nobody can attribute', () => {
        // The database CHECK makes this unrepresentable going forward. Asserted
        // anyway: the gate is the read boundary, and a row written before that
        // CHECK existed — or by a future raw UPDATE — must not clear it
        // anonymously. An acknowledgement with no author is not one.
        for (const half of [{ at: ACKED.at, byUserId: null }, { at: null, byUserId: 'u-1' }]) {
            expect(isAcknowledged(half)).toBe(false);
            expect(
                externalResidencyRefusal({
                    providerId: FLUE_PROVIDER_IDS.external,
                    offered: [tool('sap__read_orders', true)],
                    acknowledgement: half,
                }),
            ).not.toBeNull();
        }
    });
});

describe('NULL is nobody having said, and is not a claim', () => {
    it('proceeds when the connection has never been reviewed', () => {
        // The `=== true` case. Treating NULL as "carries business data" would
        // refuse nearly every run in the product on a fact nobody has asserted.
        expect(
            externalResidencyRefusal({
                providerId: FLUE_PROVIDER_IDS.external,
                offered: [tool('github__list_prs', null)],
                acknowledgement: UNACKED,
            }),
        ).toBeNull();
    });

    it('proceeds on a reviewed `false`', () => {
        expect(
            externalResidencyRefusal({
                providerId: FLUE_PROVIDER_IDS.external,
                offered: [tool('github__list_prs', false)],
                acknowledgement: UNACKED,
            }),
        ).toBeNull();
    });

    it('still refuses when ONE of several connections is marked', () => {
        // The discriminator for the two cases above: they must pass because
        // NULL and `false` are not claims, not because the gate cannot see a
        // mixed offered set at all.
        const refusal = externalResidencyRefusal({
            providerId: FLUE_PROVIDER_IDS.external,
            offered: [
                tool('github__list_prs', null, 'GitHub'),
                tool('sap__read_orders', true, 'SAP production'),
                tool('okta__list_users', false, 'Okta'),
            ],
            acknowledgement: UNACKED,
        });
        expect(refusal?.connectionNames).toEqual(['SAP production']);
    });
});

describe('an empty offered set refuses nothing', () => {
    it('proceeds with no external tools at all', () => {
        // A run with no external tools cannot transfer anything over one. Note
        // this is NOT the vacuity trap: the claim being made is about transfers
        // over business-system connections, and there are none — it is not a
        // claim that the run read anything.
        expect(
            externalResidencyRefusal({
                providerId: FLUE_PROVIDER_IDS.external,
                offered: [],
                acknowledgement: UNACKED,
            }),
        ).toBeNull();
    });
});

describe('the named connections are stable', () => {
    it('de-duplicates by connection and sorts, so one message is not two', () => {
        // Several tools on one connection name it once; a refusal that listed
        // "SAP production, SAP production, SAP production" would read as three
        // problems.
        expect(
            businessSystemConnections([
                tool('sap__read_orders', true, 'SAP production'),
                tool('sap__read_vendors', true, 'SAP production'),
                tool('wd__read_workers', true, 'Workday'),
            ]),
        ).toEqual(['SAP production', 'Workday']);
    });
});
