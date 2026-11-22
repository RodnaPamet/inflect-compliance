/**
 * The behaviour fingerprint is OFF BY DEFAULT and needs two operator keys
 * (master roadmap G9); the latch is a third.
 */
import {
    behaviourDetectorDecisionFor,
    behaviourDetectorTenantSlugs,
} from '@/lib/agentic/behaviour-detector-switch';

const base = { detector: '1', tenants: 'acme, beta', latch: undefined, tenantSlug: 'acme' };

describe('the detector runs only with both keys', () => {
    it('absent configuration runs nothing', () => {
        expect(behaviourDetectorDecisionFor({ detector: undefined, tenants: undefined, latch: undefined, tenantSlug: 'acme' }))
            .toEqual({ on: false, basis: 'DEPLOYMENT_OFF', latch: false });
        expect(behaviourDetectorTenantSlugs({ detector: undefined, tenants: 'acme' })).toEqual([]);
    });

    it('the switch alone is not enough: an unnamed tenant is off', () => {
        expect(behaviourDetectorDecisionFor({ ...base, tenantSlug: 'gamma' }).on).toBe(false);
        expect(behaviourDetectorDecisionFor({ ...base, tenants: undefined }).basis).toBe('TENANT_NOT_NAMED');
    });

    it('naming the tenant alone is not enough: a switch that is not exactly on is off', () => {
        for (const detector of ['0', 'yes', 'on', ' ', 'TRUEE']) {
            expect(behaviourDetectorDecisionFor({ ...base, detector }).on).toBe(false);
        }
    });

    it('both keys turn it on, case- and space-insensitively', () => {
        expect(behaviourDetectorDecisionFor({ ...base, detector: ' TRUE ', tenantSlug: 'ACME' }))
            .toEqual({ on: true, basis: 'ON', latch: false });
    });

    it('there is no wildcard', () => {
        expect(behaviourDetectorDecisionFor({ ...base, tenants: '*', tenantSlug: 'acme' }).on).toBe(false);
    });
});

describe('the latch is a third key', () => {
    it('is off unless set, and never on for a tenant the detector does not admit', () => {
        expect(behaviourDetectorDecisionFor(base).latch).toBe(false);
        expect(behaviourDetectorDecisionFor({ ...base, latch: '1' }).latch).toBe(true);
        expect(behaviourDetectorDecisionFor({ ...base, latch: '1', tenantSlug: 'gamma' }).latch).toBe(false);
        expect(behaviourDetectorDecisionFor({ ...base, latch: '1', detector: '0' }).latch).toBe(false);
    });
});
