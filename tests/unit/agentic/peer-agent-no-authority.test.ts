/**
 * A2A adds no second authority model (#3673; `docs/a2a-mapping.md`).
 *
 * A peer is a principal for identity and attribution, never for authority:
 * whatever it causes is decided by the registered agent that receives it,
 * through the existing funnel. The place that rule would quietly break is a
 * column on `PeerAgent` — a grant, a scope, a rung, a role — so the model's
 * columns are a CLOSED list here. A new one fails this test until somebody
 * adds it below and can say, in the comment beside it, that it is an admission
 * fact and not authority. A per-peer workflow allowlist (4b, residual R6)
 * narrows what a peer may start and belongs here; a grant never does.
 */
import { parseSchemaModels } from '../../helpers/prisma-schema-models';

const ADMISSION_FACTS = [
    // identity
    'id', 'tenantId', 'name', 'cardUrl', 'createdByUserId', 'createdAt', 'updatedAt',
    // who answers for it, and whose it is
    'ownerUserId', 'vendorId', 'riskTier', 'riskTierScoredAt',
    // what its messages must be signed with
    'signingPublicKey', 'signingKeyFingerprint',
    // whether it is active
    'status',
    // which card a person accepted, and what was last seen
    'observedCardHash', 'observedAt',
    'pinnedCardHash', 'pinnedTextHash', 'pinnedEndpointHash', 'pinnedOtherHash',
    'pinRevision', 'pinnedByUserId', 'pinnedAt', 'previousCardHash',
    // relations to the rows above, nothing else
    'tenant', 'owner', 'vendor',
].sort();

describe('PeerAgent carries admission facts only', () => {
    it('has exactly the admission-fact columns and relations, and no other', () => {
        const model = parseSchemaModels().find((m) => m.name === 'PeerAgent');
        expect(model).toBeDefined();
        expect(model!.fields.map((f) => f.name).sort()).toEqual(ADMISSION_FACTS);
    });
});
