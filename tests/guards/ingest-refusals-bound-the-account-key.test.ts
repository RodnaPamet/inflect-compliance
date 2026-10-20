import fs from 'node:fs';

import { repoFiles } from '../helpers/repo-files';

/**
 * A refusal in `ingest.ts` may name the account — it must not interpolate the
 * key RAW.
 *
 * #3795 established that naming the account is deliberate: all three row-level
 * refusals do it, and an operator fixing a spreadsheet needs to know which row.
 * #3800 is the other half — `accountKey` is a cell from an untrusted upload,
 * and `ROW_SCHEMA_INVALID` is thrown exactly when the canonical schema REJECTED
 * the row, so the key it quotes has never been through that schema's `max` and
 * can be any length the file cared to make it.
 *
 * The fix is one helper, `keyForMessage`, and the thing that rots is the
 * convention: a fourth refusal added later writes `${accountKey}` because the
 * three above it look like they do. This fails that.
 *
 * It is a source-text rule because the property is not reachable from
 * behaviour. The two post-parse refusals cannot be made to elide by any input
 * — their key is already schema-bounded — so no test can observe whether they
 * route through the helper. Only the text can say.
 */

const INGEST = 'src/lib/legacy-access/ingest.ts';

function ingestSource(): string {
    const abs = repoFiles({ under: 'src/lib/legacy-access' }).find((f) => f.endsWith('/ingest.ts'));
    expect(abs).toBeDefined();
    return fs.readFileSync(abs!, 'utf8');
}

/** Template-literal interpolations of the bare identifier, comments stripped. */
function rawInterpolations(src: string): string[] {
    const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/[^\n]*$/gm, '');
    return [...code.matchAll(/\$\{\s*accountKey\s*\}/g)].map((m) => m[0]);
}

describe('ingest refusals bound the account key they quote', () => {
    it('interpolates the key only through keyForMessage', () => {
        const src = ingestSource();
        expect(rawInterpolations(src)).toEqual([]);
        // The positive control: the bounded form is what is there instead, at
        // every refusal that names an account. Three today.
        const bounded = [...src.matchAll(/\$\{\s*keyForMessage\(accountKey\)\s*\}/g)];
        expect(bounded.length).toBeGreaterThanOrEqual(3);
    });

    it('bounds it by the schema constant, not a number of its own', () => {
        const src = ingestSource();
        // A literal here would drift from `CanonicalAccountSchema` silently,
        // and the whole argument for never eliding a legitimate key rests on
        // the two being the same number.
        expect(src).toMatch(/accountKey\.length\s*<=\s*ACCOUNT_KEY_MAX_LENGTH/);
        expect(src).toMatch(/import\s*\{[^}]*ACCOUNT_KEY_MAX_LENGTH/);
    });

    it('detects a raw interpolation when there is one', () => {
        // The detector's own control. Written against a synthesised sample
        // rather than the file, because a sample typed into this file would be
        // read by the scan above and fail it. Assembled so the literal never
        // appears here either.
        const needle = '${' + 'accountKey' + '}';
        expect(rawInterpolations(`throw new E('X', \`account "${needle}" is bad\`)`)).toHaveLength(1);
        // And it ignores the same text in a comment, which is how the file
        // discusses its own history.
        expect(rawInterpolations(`// the template was \`${needle}\` before #3800`)).toEqual([]);
    });

    it('reads the file it means to', () => {
        const src = ingestSource();
        expect(src).toContain('LegacyIngestError');
        expect(src.length).toBeGreaterThan(5_000);
        expect(INGEST).toBe('src/lib/legacy-access/ingest.ts');
    });
});
