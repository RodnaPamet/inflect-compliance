/**
 * ONE PROVIDER-NAME DERIVATION, TWO SPELLINGS — held equal by running them.
 *
 * The product attaches by the name `postureProviderName` returns. The operator
 * provisions by the name the `posture-provider-names` VM check prints. If those
 * two ever disagree, every posture collection refuses: the operator will have
 * created a provider under one name and the product will attach another, and the
 * refusal will name a provider nobody can find.
 *
 * They are two spellings because they cannot be one. The app container runs plain
 * `node`, so the check cannot import a TypeScript module by path; the recipe lives
 * in `deploy/vm-check/remote.sh` as a `node -e` program.
 *
 * ── Why this EXECUTES the recipe instead of matching its text ────────────
 *
 * A guard that asserts the shell file contains some expected string proves that
 * somebody typed a string. It cannot tell `slice(0, 32)` from `slice(0, 31)`, and
 * it cannot see that a refactor of the TypeScript moved the name while the shell
 * stayed put. So this extracts the recipe, runs it in a real node process, and
 * compares what it prints to what the function returns for the same inputs. The
 * only way to pass is for both to compute the same name.
 *
 * It is also the guard that enforces the public-log discipline on that check: the
 * tenant id goes in on stdin and the last case asserts it does not come out.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { postureProviderName } from '@/app-layer/integrations/cloud-posture/provider-name';

const REPO_ROOT = path.resolve(__dirname, '../..');
const REMOTE_SH = 'deploy/vm-check/remote.sh';

/** The recipe exactly as the VM check would run it. */
function recipe(): string {
    const src = fs.readFileSync(path.join(REPO_ROOT, REMOTE_SH), 'utf8');
    const match = src.match(/POSTURE_NAME_RECIPE='\n([\s\S]*?)\n'\n/);
    if (!match) {
        throw new Error(
            `POSTURE_NAME_RECIPE was not found in ${REMOTE_SH}. If it was renamed or `
                + 'reshaped, this guard must be taught the new shape in the same diff — it '
                + 'is the only thing holding the deploy recipe equal to postureProviderName.',
        );
    }
    return match[1];
}

/** Run it over `tenantId|connectionId|enabled` lines and read back its table. */
function runRecipe(lines: readonly string[]): { out: string; rows: Array<{ connectionId: string; enabled: string; name: string }> } {
    const out = execFileSync(process.execPath, ['-e', recipe()], {
        input: `${lines.join('\n')}\n`,
        encoding: 'utf8',
    });
    const rows = [...out.matchAll(/^\| (\S+) \| (\S+) \| (inflect-posture-\S+) \|$/gm)].map((m) => ({
        connectionId: m[1],
        enabled: m[2],
        name: m[3],
    }));
    return { out, rows };
}

const PAIRS = [
    { tenantId: 'clz1aaaaaaaaaaaaaaaaaaaa', connectionId: 'clz1bbbbbbbbbbbbbbbbbbbb' },
    { tenantId: 'clz1aaaaaaaaaaaaaaaaaaaa', connectionId: 'clz1cccccccccccccccccccc' },
    { tenantId: 'clz1dddddddddddddddddddd', connectionId: 'clz1bbbbbbbbbbbbbbbbbbbb' },
    // The pair a bare concatenation merges, and the pair a colon separator merges.
    { tenantId: 'ab', connectionId: 'c' },
    { tenantId: 'a', connectionId: 'bc' },
    { tenantId: 'a', connectionId: 'b:c' },
    { tenantId: 'a:b', connectionId: 'c' },
];

describe('the VM check recipe and postureProviderName agree', () => {
    it('derives the same name for every pair, by running both', () => {
        const { rows } = runRecipe(PAIRS.map((p) => `${p.tenantId}|${p.connectionId}|t`));
        expect(rows.map((r) => r.name)).toEqual(PAIRS.map((p) => postureProviderName(p)));
    });

    it('agrees on the pairs that a weaker join would merge', () => {
        // Asserted as a property of the AGREEMENT, not just of the function: a
        // shell recipe that joined with a colon would pass the case above (every
        // pair distinct) and fail here, which is where the real risk lies.
        const { rows } = runRecipe([
            'a|b:c|t',
            'a:b|c|t',
        ]);
        expect(rows[0].name).not.toBe(rows[1].name);
        expect(rows[0].name).toBe(postureProviderName({ tenantId: 'a', connectionId: 'b:c' }));
        expect(rows[1].name).toBe(postureProviderName({ tenantId: 'a:b', connectionId: 'c' }));
    });

    it('prints one row per connection, with the connection id and its enabled state', () => {
        const { out, rows } = runRecipe([
            'tenant-1|conn-1|t',
            'tenant-1|conn-2|f',
        ]);
        expect(rows.map((r) => [r.connectionId, r.enabled])).toEqual([
            ['conn-1', 't'],
            ['conn-2', 'f'],
        ]);
        expect(out).toContain('posture connections: 2');
    });

    it('NEVER prints a tenant id — the run log is public', () => {
        const { out } = runRecipe([
            'tenant-secret-slug|conn-1|t',
            'another-tenant-id|conn-2|t',
        ]);
        // The id is read, hashed and dropped. A check that printed it would put a
        // customer's identifier in a public GitHub Actions log.
        expect(out).not.toContain('tenant-secret-slug');
        expect(out).not.toContain('another-tenant-id');
        expect(out).toContain('conn-1');
    });

    it('reports an empty estate as zero rather than printing nothing', () => {
        const { out, rows } = runRecipe([]);
        expect(rows).toEqual([]);
        // An operator must be able to tell "no posture connections" from "the
        // check produced no output", which look identical without this line.
        expect(out).toContain('posture connections: 0');
    });

    it('skips a malformed line instead of deriving a name from half of one', () => {
        const { rows } = runRecipe([
            'tenant-1|conn-1|t',
            'no-pipes-at-all',
            '|conn-missing-tenant|t',
            'tenant-missing-conn||t',
            'tenant-2|conn-2|t',
        ]);
        // A name derived from an empty tenant id would be one name shared by every
        // row that failed to parse — the #5251 shape, arrived at by a typo.
        expect(rows.map((r) => r.connectionId)).toEqual(['conn-1', 'conn-2']);
    });
});
