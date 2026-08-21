/**
 * The admin integrations form holds every config value as a string. The Entra
 * writer compares `config.writesEnabled !== true` strictly, on purpose. Between
 * those two facts sat a checkbox that ticked, saved, reloaded ticked, and left
 * offboarding writes off with no error anywhere — while the writer's own
 * diagnostic told the operator to "re-save the connection", which reproduced
 * the string.
 */
import { coerceDeclaredBooleans } from '@/lib/integrations/config-form-values';

const DECLARED = new Set(['writesEnabled', 'enrichMfa']);

describe('coerceDeclaredBooleans', () => {
    it('turns a ticked checkbox into a real JSON boolean', () => {
        const out = coerceDeclaredBooleans({ writesEnabled: 'true' }, DECLARED);
        // Not `toBeTruthy` — the string 'true' is truthy too, and the string is
        // exactly the bug. Identity against the boolean is the assertion.
        expect(out.writesEnabled).toBe(true);
    });

    it('turns an unticked checkbox into false, not into the string', () => {
        expect(coerceDeclaredBooleans({ writesEnabled: 'false' }, DECLARED).writesEnabled).toBe(false);
    });

    it('round-trips a stored boolean through the form and back', () => {
        // The edit path stringifies whatever is stored, so a working connection
        // arrives here as 'true' and must leave as true. Break this pairing and
        // editing an unrelated field silently turns a writing connection into a
        // non-writing one.
        const hydrated = Object.fromEntries(
            Object.entries({ writesEnabled: true, tenantId: 'abc' }).map(([k, v]) => [k, String(v)]),
        ) as Record<string, string>;
        expect(coerceDeclaredBooleans(hydrated, DECLARED)).toEqual({ writesEnabled: true, tenantId: 'abc' });
    });

    it('leaves every field the provider did not declare boolean alone', () => {
        // 'true' as a genuine string value must survive. Coercing by VALUE
        // rather than by declared type would corrupt it.
        const out = coerceDeclaredBooleans({ someText: 'true', url: 'ldaps://dc1' }, DECLARED);
        expect(out.someText).toBe('true');
        expect(out.url).toBe('ldaps://dc1');
    });

    it('does not guess at spellings the checkbox never produces', () => {
        // 'yes' / '1' / 'TRUE' can only have arrived from outside this form. The
        // strict comparison downstream exists precisely to refuse a value that
        // merely looks affirmative, and quietly promoting one here would defeat
        // it — turning "somebody's script set a truthy-looking string" into a
        // standing grant to disable accounts.
        const out = coerceDeclaredBooleans({ writesEnabled: 'yes', enrichMfa: 'TRUE' }, DECLARED);
        expect(out.writesEnabled).toBe('yes');
        expect(out.enrichMfa).toBe('TRUE');
    });

    it('does not invent keys that were never in the form', () => {
        expect(coerceDeclaredBooleans({}, DECLARED)).toEqual({});
    });
});
