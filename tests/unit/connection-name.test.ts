/**
 * The characters a connection name may not be saved with (#5317; owner
 * decision 2026-11-15): C0 controls, DEL, C1 controls and lone surrogates.
 *
 * Every refused value is written as an escape, so this file carries no control
 * character or unpaired surrogate of its own.
 */
import {
    CONNECTION_NAME_INVALID_CHARACTERS,
    connectionNameHasInvalidCharacters,
    savableConnectionName,
} from '@/lib/text/connection-name';
import {
    IntegrationConnectionNameSchema,
    SaveIntegrationConnectionSchema,
} from '@/app-layer/schemas/integration-connection.schemas';

const HIGH = '\uD83D'; // first half of U+1F600
const LOW = '\uDE00'; // second half of U+1F600
const EMOJI = `${HIGH}${LOW}`; // U+1F600, a valid pair

describe('connectionNameHasInvalidCharacters — refused', () => {
    it.each([
        ['NUL', 'Acme\u0000GitHub'],
        ['a C0 control at the start', '\u0001Acme'],
        ['tab', 'Acme\tGitHub'],
        ['newline', 'Acme\nGitHub'],
        ['unit separator U+001F', 'Acme\u001F'],
        ['DEL', 'Acme\u007FGitHub'],
        ['C1 U+0080', 'Acme\u0080GitHub'],
        ['C1 U+0085 (NEL)', 'Acme\u0085'],
        ['C1 U+009F', 'Acme\u009F'],
        ['a lone high surrogate', `Acme ${HIGH} GitHub`],
        ['a lone high surrogate at the end', `Acme ${HIGH}`],
        ['a lone low surrogate', `Acme ${LOW} GitHub`],
        ['a lone low surrogate at the start', `${LOW}Acme`],
        ['a reversed pair', `Acme ${LOW}${HIGH}`],
    ])('%s', (_label, name) => {
        expect(connectionNameHasInvalidCharacters(name)).toBe(true);
    });
});

describe('connectionNameHasInvalidCharacters — allowed', () => {
    it.each([
        ['an ordinary name', 'Acme GitHub Org'],
        ['a valid emoji pair', `Acme ${EMOJI} GitHub`],
        ['an astral CJK character', 'Acme \u{20000}'],
        ['Cyrillic', 'Връзка към Окта'],
        ['accented Latin', 'Société Générale — Zürich'],
        ['the first printable after C1 (U+00A0)', 'Acme GitHub'],
        ['punctuation and digits', 'A2A → peer (example.test/acme) #1'],
    ])('%s', (_label, name) => {
        expect(connectionNameHasInvalidCharacters(name)).toBe(false);
    });
});

describe('the route schema refuses with the stable code at path name', () => {
    it('refuses a name with a control character', () => {
        const r = IntegrationConnectionNameSchema.safeParse('Acme\u0007');
        expect(r.success).toBe(false);
        expect(r.error?.issues[0]?.message).toBe(CONNECTION_NAME_INVALID_CHARACTERS);
    });

    it('refuses it on a create and on an update', () => {
        for (const body of [
            { provider: 'github', name: `Acme ${HIGH}` },
            { id: 'conn-1', provider: 'github', name: 'Acme\u009B' },
        ]) {
            const r = SaveIntegrationConnectionSchema.safeParse(body);
            expect(r.success).toBe(false);
            expect(r.error?.issues).toEqual([
                expect.objectContaining({ path: ['name'], message: CONNECTION_NAME_INVALID_CHARACTERS }),
            ]);
        }
    });

    it('accepts an update that leaves the name out, and refuses a create that does', () => {
        expect(SaveIntegrationConnectionSchema.safeParse({ id: 'conn-1', provider: 'github' }).success).toBe(true);
        const create = SaveIntegrationConnectionSchema.safeParse({ provider: 'github' });
        expect(create.success).toBe(false);
        expect(create.error?.issues[0]?.path).toEqual(['name']);
    });

    it('accepts an emoji name', () => {
        expect(SaveIntegrationConnectionSchema.safeParse({ provider: 'github', name: `Acme ${EMOJI}` }).success).toBe(true);
    });
});

describe('savableConnectionName — a server-built name made savable', () => {
    it('drops every refused character and keeps the rest', () => {
        const out = savableConnectionName(`A2A → Ac\u0000me${LOW} ${EMOJI}\u0085`, 200);
        expect(out).toBe(`A2A → Acme ${EMOJI}`);
        expect(connectionNameHasInvalidCharacters(out)).toBe(false);
    });

    it('cuts without splitting a surrogate pair', () => {
        // 'ab' + emoji is 4 UTF-16 units; a plain slice(0, 3) leaves a lone high half.
        expect(connectionNameHasInvalidCharacters(`ab${EMOJI}`.slice(0, 3))).toBe(true);
        const out = savableConnectionName(`ab${EMOJI}`, 3);
        expect(out).toBe('ab');
        expect(connectionNameHasInvalidCharacters(out)).toBe(false);
        expect(savableConnectionName(`ab${EMOJI}`, 4)).toBe(`ab${EMOJI}`);
    });

    it('leaves an ordinary name as it is', () => {
        expect(savableConnectionName('Acme GitHub Org', 200)).toBe('Acme GitHub Org');
    });
});
