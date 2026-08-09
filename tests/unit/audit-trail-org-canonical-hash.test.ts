/**
 * Epic B — `org-canonical-hash` determinism + payload contract.
 *
 * Locks in:
 *   - identical inputs → identical hash byte-for-byte (canonical
 *     serialisation discipline holds)
 *   - changing any single hashed field → different hash
 *   - the field set in the payload matches `ORG_HASH_FIELDS`
 *     (no silent inclusion/exclusion)
 *   - the canonical-JSON helper recurses + sorts (sanity)
 *
 * Concurrency / advisory-lock / append-only behaviour is covered by
 * the integration suite (`tests/integration/org-audit-immutability.test.ts`).
 */
import {
    computeOrgEntryHash,
    buildOrgHashPayload,
    ORG_HASH_FIELDS,
    type OrgHashInput,
} from '@/lib/audit/org-canonical-hash';
import { canonicalJsonStringify } from '@/lib/audit/canonical-hash';

const sample: OrgHashInput = {
    organizationId: 'org-1',
    actorType: 'USER',
    actorUserId: 'caller-1',
    action: 'ORG_MEMBER_ADDED',
    targetUserId: 'user-2',
    occurredAt: '2026-04-30T05:00:00.000Z',
    detailsJson: { role: 'ORG_ADMIN', provisionedTenantCount: 3 },
    previousHash: null,
    version: 1,
};

describe('org-canonical-hash — determinism', () => {
    it('identical input produces identical 64-char hex hash', () => {
        const a = computeOrgEntryHash(sample);
        const b = computeOrgEntryHash({ ...sample });
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
    });

    it.each(ORG_HASH_FIELDS.map((f) => [f]))(
        'changing %s changes the hash (no silent equivalence)',
        (field) => {
            const base = computeOrgEntryHash(sample);
            // Construct a perturbed input that differs only in `field`.
            const perturbed: OrgHashInput = { ...sample };
            switch (field) {
                case 'organizationId':
                    perturbed.organizationId = 'org-2';
                    break;
                case 'actorType':
                    perturbed.actorType = 'SYSTEM';
                    break;
                case 'actorUserId':
                    perturbed.actorUserId = null;
                    break;
                case 'action':
                    perturbed.action = 'ORG_MEMBER_REMOVED';
                    break;
                case 'targetUserId':
                    perturbed.targetUserId = null;
                    break;
                case 'occurredAt':
                    perturbed.occurredAt = '2026-05-01T00:00:00.000Z';
                    break;
                case 'detailsJson':
                    perturbed.detailsJson = { role: 'ORG_READER' };
                    break;
                case 'previousHash':
                    perturbed.previousHash = 'a'.repeat(64);
                    break;
                case 'version':
                    perturbed.version = 2;
                    break;
            }
            const perturbedHash = computeOrgEntryHash(perturbed);
            expect(perturbedHash).not.toBe(base);
        },
    );

    it('detailsJson key order does not affect the hash (canonical sort)', () => {
        const a = computeOrgEntryHash({
            ...sample,
            detailsJson: { role: 'ORG_ADMIN', provisionedTenantCount: 3 },
        });
        const b = computeOrgEntryHash({
            ...sample,
            detailsJson: { provisionedTenantCount: 3, role: 'ORG_ADMIN' },
        });
        expect(a).toBe(b);
    });

    it('payload includes EXACTLY the documented fields', () => {
        const payload = buildOrgHashPayload(sample);
        expect(Object.keys(payload).sort()).toEqual([...ORG_HASH_FIELDS].sort());
    });

    it('null detailsJson serialises as null (not omitted)', () => {
        const canonical = canonicalJsonStringify(
            buildOrgHashPayload({ ...sample, detailsJson: null }),
        );
        expect(canonical).toContain('"detailsJson":null');
    });

    it('null actorUserId / targetUserId / previousHash serialise as null', () => {
        const canonical = canonicalJsonStringify(
            buildOrgHashPayload({
                ...sample,
                actorUserId: null,
                targetUserId: null,
                previousHash: null,
            }),
        );
        expect(canonical).toContain('"actorUserId":null');
        expect(canonical).toContain('"targetUserId":null');
        expect(canonical).toContain('"previousHash":null');
    });
});
