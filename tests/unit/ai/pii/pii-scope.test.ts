/**
 * D-L1-1's scope, held where it is written. Invariants:
 *
 *   - the five types are Presidio's own names, used unchanged by the corpus,
 *     the record and the seam — there is no translation table to drift;
 *   - the route ids are the residency provider ids the model selection
 *     registers, so "external routes only" means the route that leaves;
 *   - redaction applies to the external route and to nothing else;
 *   - a type outside the scope is not one.
 */
import { FLUE_PROVIDER_IDS } from '@/lib/agentic/flue/model-selection';
import {
    isPiiEntityType,
    isPiiLocale,
    LOCAL_ROUTE_REDACTED,
    PII_ENTITY_TYPES,
    PII_LOCALES,
    redactionAppliesToRoute,
    type PiiEgressRoute,
} from '@/lib/ai/pii/scope';

describe('D-L1-1 scope', () => {
    it('is PERSON, EMAIL_ADDRESS, PHONE_NUMBER, IBAN_CODE and BG_EGN, in EN and BG', () => {
        expect([...PII_ENTITY_TYPES]).toEqual(['PERSON', 'EMAIL_ADDRESS', 'PHONE_NUMBER', 'IBAN_CODE', 'BG_EGN']);
        expect([...PII_LOCALES]).toEqual(['en', 'bg']);
    });

    it('names the routes by the residency provider ids, and redacts only the external one', () => {
        const external: PiiEgressRoute = FLUE_PROVIDER_IDS.external;
        const local: PiiEgressRoute = FLUE_PROVIDER_IDS.local;
        expect(LOCAL_ROUTE_REDACTED).toBe(false);
        expect(redactionAppliesToRoute(external)).toBe(true);
        expect(redactionAppliesToRoute(local)).toBe(false);
    });

    it.each(['LOCATION', 'ORGANIZATION', 'CREDIT_CARD', 'US_SSN', 'EMAIL', 'EGN', 42, null])('%s is outside the scope', (name) => {
        expect(isPiiEntityType(name)).toBe(false);
    });

    it('accepts exactly the in-scope types and locales', () => {
        expect(PII_ENTITY_TYPES.every(isPiiEntityType)).toBe(true);
        expect(PII_LOCALES.every(isPiiLocale)).toBe(true);
        expect(isPiiLocale('de')).toBe(false);
    });
});
