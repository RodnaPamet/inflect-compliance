/**
 * THE TWO DECISIONS THE CONNECTION FORM MAKES (#4008).
 *
 * `buildConnectionBody` was extracted from `handleSave` in an 827-line client
 * component precisely so these could be asserted. A page-level attempt needed
 * eight mocks and shims — `next-intl`, `next/navigation`, a spread of
 * `tenant-context-provider`, four child cards, two fixtures rebuilt from their
 * real types, an `act()` wrapper, a `scrollIntoView` shim — and still timed out.
 * The blockers are on #4008. Here it is a pure function and the cases are plain.
 */
import { buildConnectionBody } from '@/lib/integrations/config-form-values';

const base = {
    provider: 'mcp-server',
    name: 'sap stub',
    config: { url: 'https://stub.example.test/mcp' },
    secrets: {},
    editingId: null as string | null,
    configFields: [{ key: 'url', type: 'string' }],
};

describe('decision 1 — `secrets` is omitted unless something was typed', () => {
    it('omits it for an untouched form', () => {
        const body = buildConnectionBody(base);
        expect(body).not.toHaveProperty('secrets');
        // The positive half: everything else IS there, so "no secrets" is not
        // "nothing was built".
        expect(body).toMatchObject({ provider: 'mcp-server', name: 'sap stub' });
    });

    it('sends it when a value is typed', () => {
        const body = buildConnectionBody({ ...base, secrets: { authorization: 'Bearer x' } });
        expect(body.secrets).toEqual({ authorization: 'Bearer x' });
    });

    it('OMITS it when a value is typed and then cleared — the wipe path', () => {
        // The case with teeth. `{ authorization: '' }` is a key with an empty
        // value, which the server encrypts OVER the stored credential; only
        // `.trim().length > 0` stops it. An untouched form holds `{}` and is
        // safe twice over, so this sequence — start replacing a credential,
        // change your mind, clear the box — is the one that reaches the wipe.
        expect(buildConnectionBody({ ...base, secrets: { authorization: '' } }))
            .not.toHaveProperty('secrets');
        // Whitespace only, which `.trim()` is what catches.
        expect(buildConnectionBody({ ...base, secrets: { authorization: '   ' } }))
            .not.toHaveProperty('secrets');
    });

    it('sends the WHOLE bag when any one field has a value', () => {
        // `some`, not `every`: a provider with two secret fields where the
        // operator fills one must still send both, or the untouched one arrives
        // as an empty string over a stored value — the same wipe, one field
        // along. Swapping `some` for `every` fails this.
        const body = buildConnectionBody({
            ...base,
            secrets: { clientId: 'abc', clientSecret: '' },
        });
        expect(body.secrets).toEqual({ clientId: 'abc', clientSecret: '' });
    });
});

describe('decision 2 — declared booleans go out as booleans', () => {
    it('converts only keys the provider DECLARES boolean', () => {
        const body = buildConnectionBody({
            ...base,
            config: { writesEnabled: 'true', label: 'true' },
            configFields: [
                { key: 'writesEnabled', type: 'boolean' },
                { key: 'label', type: 'string' },
            ],
        });
        // The declared one becomes a real boolean; the string field keeps the
        // word. The Entra writer's `config.writesEnabled !== true` is strict, so
        // the first being `'true'` leaves the feature off with no error.
        expect(body.configJson).toEqual({ writesEnabled: true, label: 'true' });
    });

    it('converts false as well as true', () => {
        const body = buildConnectionBody({
            ...base,
            config: { writesEnabled: 'false' },
            configFields: [{ key: 'writesEnabled', type: 'boolean' }],
        });
        expect(body.configJson).toEqual({ writesEnabled: false });
    });

    it('passes through a value the checkbox could not have produced', () => {
        // `'yes'` did not come from this form, and guessing at it is what the
        // strict comparison exists to refuse.
        const body = buildConnectionBody({
            ...base,
            config: { writesEnabled: 'yes' },
            configFields: [{ key: 'writesEnabled', type: 'boolean' }],
        });
        expect(body.configJson).toEqual({ writesEnabled: 'yes' });
    });
});

describe('the id', () => {
    it('is present when editing and absent when creating', () => {
        expect(buildConnectionBody({ ...base, editingId: 'conn-1' }).id).toBe('conn-1');
        expect(buildConnectionBody(base)).not.toHaveProperty('id');
        // An empty string is not an id — the original wrote `if (editingId)`,
        // and a falsy value must not produce `id: ''`, which the server would
        // read as an update of a connection that does not exist.
        expect(buildConnectionBody({ ...base, editingId: '' })).not.toHaveProperty('id');
    });
});
