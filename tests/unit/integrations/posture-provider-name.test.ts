/**
 * THE PER-TENANT GATEWAY PROVIDER NAME — #5476.
 *
 * #5251: every tenant's sandboxed posture scan attached the one shared provider,
 * so a scan benchmarked whatever account that credential reached and the result
 * was stored as this tenant's Evidence. #5475 made it refuse. This name is what
 * makes the capability reachable again, and the properties below are exactly the
 * ones that make it safe to attach something derived rather than configured.
 *
 * Three of them would each be a cross-tenant defect if they broke, and none is
 * visible by reading the function:
 *
 *   1. SEPARATION. Two different pairs never derive one name, including the pairs
 *      that differ only in where one id ends and the next begins.
 *   2. STABILITY. The name is an operator's provisioning input, so it may never
 *      move for a given pair. Nothing keyed, nothing dated, nothing rotatable.
 *   3. OPACITY. It is read back as a label, in lease rows and in harness
 *      observations, so it may carry no slug, account or readable identifier.
 */
import {
    POSTURE_CONNECTION_PROVIDERS,
    POSTURE_PROVIDER_DIGEST_CHARS,
    POSTURE_PROVIDER_PREFIX,
    postureProviderName,
} from '@/app-layer/integrations/cloud-posture/provider-name';

const TENANT = 'clz1tenantaaaaaaaaaaaaaa';
const CONNECTION = 'clz1connbbbbbbbbbbbbbbbb';

describe('separation — one name per (tenant, connection) and never two pairs', () => {
    it('gives two tenants different names for the same connection id', () => {
        expect(postureProviderName({ tenantId: 't1', connectionId: CONNECTION })).not.toBe(
            postureProviderName({ tenantId: 't2', connectionId: CONNECTION }),
        );
    });

    it('gives one tenant different names for two connections', () => {
        expect(postureProviderName({ tenantId: TENANT, connectionId: 'c1' })).not.toBe(
            postureProviderName({ tenantId: TENANT, connectionId: 'c2' }),
        );
    });

    it('does not merge pairs that differ only in where the ids split', () => {
        // THE case a bare concatenation gets wrong: ('ab','c') and ('a','bc') are
        // two different tenants, and one name for both is the #5251 defect
        // reachable by nothing more than two id lengths.
        expect(postureProviderName({ tenantId: 'ab', connectionId: 'c' })).not.toBe(
            postureProviderName({ tenantId: 'a', connectionId: 'bc' }),
        );
    });

    it('does not merge them when an id contains the separator character either', () => {
        // THIS CASE FOUND A REAL DEFECT while it was being written. The derivation
        // joined the ids with a colon, on the reasoning that no cuid or uuid
        // contains one — true of today's ids, and not a property the derivation
        // should depend on, because an id format is somebody else's decision and a
        // collision here merges two tenants' credentials. Both of these built
        // `a:b:c` and derived one name. Length-prefixing is injective for ANY pair,
        // so the assumption is gone rather than documented.
        expect(postureProviderName({ tenantId: 'a', connectionId: 'b:c' })).not.toBe(
            postureProviderName({ tenantId: 'a:b', connectionId: 'c' }),
        );
        // And the same shape one level out, with digits, which is what a reader of
        // a length-prefixed encoding could in principle be confused by.
        expect(postureProviderName({ tenantId: '1', connectionId: '1:x' })).not.toBe(
            postureProviderName({ tenantId: '1:1', connectionId: 'x' }),
        );
    });

    it('keeps 1000 distinct pairs distinct', () => {
        // Not a probabilistic claim about SHA-256 — a check that the function
        // actually varies on both inputs. A derivation that ignored one of them
        // would collapse this set to 1 or to 10.
        const names = new Set<string>();
        for (let t = 0; t < 10; t += 1) {
            for (let c = 0; c < 100; c += 1) {
                names.add(postureProviderName({ tenantId: `tenant-${t}`, connectionId: `conn-${c}` }));
            }
        }
        expect(names.size).toBe(1000);
    });
});

describe('stability — the operator provisions against this, so it may never move', () => {
    it('is the same on every call', () => {
        const first = postureProviderName({ tenantId: TENANT, connectionId: CONNECTION });
        for (let i = 0; i < 5; i += 1) {
            expect(postureProviderName({ tenantId: TENANT, connectionId: CONNECTION })).toBe(first);
        }
    });

    it('is pinned to an exact value, so a change to the recipe cannot pass silently', () => {
        // A GOLDEN VALUE, and it is the whole point of this case. Every property
        // above holds just as well for a different recipe, so without this a
        // refactor could move every name — orphaning every provisioned provider —
        // while the rest of this file stayed green. If this line has to change,
        // the operator has to re-provision every connection, and that is the
        // conversation this assertion forces.
        expect(postureProviderName({ tenantId: 'tenant-fixed', connectionId: 'conn-fixed' })).toBe(
            'inflect-posture-612f9569efe7045106a1077ba1311703',
        );
    });
});

describe('opacity — it is read back as a label', () => {
    const name = postureProviderName({ tenantId: 'acme-corp', connectionId: 'conn-prod-aws' });

    it('carries neither id, nor any part of one', () => {
        // The name reaches `SandboxLease` rows and, for an opted-in estate,
        // harness observations as `openshell://sandbox/<id>/provider/<name>`.
        expect(name).not.toContain('acme');
        expect(name).not.toContain('corp');
        expect(name).not.toContain('conn-prod');
        expect(name).not.toContain('aws');
    });

    it('is a prefix plus lowercase hex, and nothing else', () => {
        expect(name).toMatch(/^inflect-posture-[0-9a-f]{32}$/);
        expect(name).toHaveLength(POSTURE_PROVIDER_PREFIX.length + POSTURE_PROVIDER_DIGEST_CHARS);
    });

    it('is not the shared provider #5251 refused', () => {
        expect(name).not.toBe('inflect-collector');
        expect(POSTURE_PROVIDER_PREFIX).not.toBe('inflect-collector');
    });
});

describe('the posture connection providers', () => {
    it('names the three that collect in a sandbox', () => {
        // Exact equality: a fourth posture provider must widen the operator's
        // provisioning list in the same diff, or its connections get a name
        // nobody was told to provision and every scan refuses.
        expect([...POSTURE_CONNECTION_PROVIDERS].sort()).toEqual([
            'aws-posture',
            'azure-posture',
            'gcp-posture',
        ]);
    });
});
