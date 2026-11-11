/**
 * D-L1-1's scope, held where it is written. Invariants:
 *
 *   - the route ids are the residency provider ids the model selection
 *     registers, so "external routes only" means the route that leaves;
 *   - redaction applies to the external route and to nothing else;
 *   - every D-L1-1 type has exactly one Presidio wire name, and the reverse
 *     mapping refuses a type outside the scope.
 */
import { FLUE_PROVIDER_IDS } from '@/lib/agentic/flue/model-selection';
import {
    entityTypeFromPresidio,
    PII_ENTITY_TYPES,
    PII_LOCALES,
    PRESIDIO_ENTITY_NAME,
    redactionAppliesToRoute,
    type PiiEgressRoute,
} from '@/lib/ai/pii/entities';

describe('D-L1-1 scope', () => {
    it('is PERSON, EMAIL, PHONE, IBAN and EGN, in EN and BG', () => {
        expect([...PII_ENTITY_TYPES]).toEqual(['PERSON', 'EMAIL', 'PHONE', 'IBAN', 'EGN']);
        expect([...PII_LOCALES]).toEqual(['en', 'bg']);
    });

    it('names the routes by the residency provider ids', () => {
        const external: PiiEgressRoute = FLUE_PROVIDER_IDS.external;
        const local: PiiEgressRoute = FLUE_PROVIDER_IDS.local;
        expect(redactionAppliesToRoute(external)).toBe(true);
        expect(redactionAppliesToRoute(local)).toBe(false);
    });

    it('maps each type to one distinct Presidio name and back', () => {
        const names = PII_ENTITY_TYPES.map((t) => PRESIDIO_ENTITY_NAME[t]);
        expect(new Set(names).size).toBe(names.length);
        for (const t of PII_ENTITY_TYPES) expect(entityTypeFromPresidio(PRESIDIO_ENTITY_NAME[t])).toBe(t);
    });

    it.each(['LOCATION', 'ORGANIZATION', 'CREDIT_CARD', 'US_SSN'])('%s is outside the scope', (name) => {
        expect(entityTypeFromPresidio(name)).toBeNull();
    });
});
