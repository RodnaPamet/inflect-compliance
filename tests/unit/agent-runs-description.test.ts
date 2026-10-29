/**
 * The agent runs page's description is true of every write a run can make
 * (#4472).
 *
 * It said every write a run makes is a proposal a person approves and that the
 * engine commits nothing directly. That holds for changes to this workspace,
 * and not for an external write on a connection at the Automatic rung, which
 * `external-write-automatic.ts` opens with no per-write approval and the
 * dispatch job sends. The description now names that rung by the label the
 * connection's own ladder shows, in both locales.
 */
type Catalogue = Record<string, unknown>;
const EN = jest.requireActual('../../messages/en.json') as Catalogue;
const BG = jest.requireActual('../../messages/bg.json') as Catalogue;

const at = (c: Catalogue, dotted: string): unknown =>
    dotted.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        c,
    );

describe('the runs page description', () => {
    it.each([
        ['en', EN],
        ['bg', BG],
    ] as const)('%s names the Automatic external-write rung', (_locale, c) => {
        const description = at(c, 'agents.runs.description') as string;
        const automatic = at(c, 'admin.externalWriteLadder.mode.AUTOMATIC') as string;
        expect(typeof automatic).toBe('string');
        expect(description).toContain(automatic);
    });

    it('no longer claims that every write is approved or that nothing is committed directly', () => {
        expect(at(EN, 'agents.runs.description')).not.toMatch(/every write|commits nothing/i);
    });
});
