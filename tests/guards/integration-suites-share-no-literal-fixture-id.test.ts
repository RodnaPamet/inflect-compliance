import * as fs from 'fs';

import { repoFiles, repoRelative } from '../helpers/repo-files';

/**
 * #3336 tranche 1 — NO TWO INTEGRATION SUITES CREATE A `User` OR `Tenant` WITH
 * THE SAME LITERAL ID.
 *
 * `Tenant` and `User` deliberately survive `resetDatabase` so a `beforeAll`
 * fixture can (`tests/helpers/db.ts:951-960`), and `--shard=K/7` is a hash over
 * file paths, so which suites share a database changes whenever ANY test file
 * is added anywhere. Put those two together with a literal id and you get a
 * cross-suite dependency that nothing in the repo was checking:
 *
 *     await prisma.user.upsert({
 *         where:  { id: 'user-1' },        // <- six suites wrote this
 *         update: {},
 *         create: { id: 'user-1', email: 'reviewer@lra.test', … },
 *     });
 *
 * **`upsert` is what made it silent.** Whichever suite runs first on the shard
 * inserts the row; every later one matches it, takes the `update: {}` no-op
 * branch, and proceeds with a user it did not create — carrying the FIRST
 * suite's email, name, and whatever `AuditLog` rows hung off its activity. No
 * unique-constraint violation, no visible failure, right up until a teardown
 * hits `AuditLog_userId_fkey` for a user the suite never made. That is #3336's
 * own worked example.
 *
 * Six suites shared `'user-1'`: `legacy-access-mapping`, `-profile`, `-review`,
 * `legacy-adjudication-settings`, `legacy-reconcile`, `legacy-reviewer-actions`.
 * It was the ONLY colliding literal id in the directory, which is why this is a
 * flat prohibition rather than a ratchet with a baseline — there is nothing to
 * drain.
 *
 * ── WHAT THIS DOES NOT CLAIM ───────────────────────────────────────────────
 *
 * Seven further suites mention `'user-1'` and are NOT in scope: it is an opaque
 * string in a mock context, a JWT `sub`, or a SCIM payload, and none of them
 * holds a `prismaTestClient`. A guard that counted mentions would have reported
 * thirteen offenders and sent somebody to rename strings in files that never
 * open a database. The subject here is a row that OUTLIVES a suite, so the
 * detector looks for a create/upsert call and nothing else.
 *
 * It also makes no claim about suites that leak a UNIQUELY-named fixture. 86
 * integration suites create a `User`/`Tenant` and never delete it; they bloat
 * the shard's database but cannot be adopted by a sibling. That is #3336's
 * chronic half and wants its own ratchet, not this one.
 */

/** The argument object of a call, by brace matching — never a fixed window. */
function callArgs(source: string, start: number): string {
    let depth = 0;
    for (let i = start; i < source.length; i += 1) {
        const c = source[i];
        if (c === '(' || c === '{' || c === '[') depth += 1;
        else if (c === ')' || c === '}' || c === ']') {
            depth -= 1;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    return source.slice(start);
}

const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const CREATE = /\b(?:prisma|db|tx|client)\s*\.\s*(user|tenant)\s*\.\s*(?:create|createMany|upsert)\s*\(/g;
const LITERAL_ID = /\bid:\s*'([A-Za-z0-9][A-Za-z0-9._-]{1,60})'/g;

/** model:id → the suites that create it. */
const owners = new Map<string, Set<string>>();
/** Suites that create a `User`/`Tenant` AT ALL — the population that could collide. */
let creatingSuites = 0;

for (const file of repoFiles({ under: 'tests/integration', extensions: ['.ts'] })) {
    if (!file.endsWith('.test.ts')) continue;
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    if (!source.includes('prismaTestClient')) continue;
    const rel = repoRelative(file);
    let creates = false;
    for (const m of [...source.matchAll(CREATE)]) {
        creates = true;
        const model = m[1].toLowerCase();
        const args = callArgs(source, m.index! + m[0].length - 1);
        for (const id of [...args.matchAll(LITERAL_ID)].map((x) => x[1])) {
            const key = `${model}:${id}`;
            if (!owners.has(key)) owners.set(key, new Set());
            owners.get(key)!.add(rel);
        }
    }
    if (creates) creatingSuites += 1;
}

describe('integration suites do not share a literal fixture id', () => {
    it('found the creating suites and their ids, so the rule below ranges over something', () => {
        // TWO floors, because they fail for different reasons, and the first
        // set here were guesses that the test itself caught: I wrote 60 and 100
        // from intuition and measured 8 and 9.
        //
        // `creatingSuites` is the population the rule RANGES OVER — every suite
        // that creates a `User`/`Tenant` and could therefore collide with a
        // sibling. Measured 173 of 402 integration files (195 hold a
        // `prismaTestClient`). It is the floor that matters: if the CREATE
        // regex stops matching — a rename, a new client alias, a different
        // spelling of `prisma.user.upsert(` — this collapses and says so,
        // whereas the collision rule would simply report nothing wrong.
        expect(creatingSuites).toBeGreaterThanOrEqual(150);

        // Literal ids are RARE on purpose — 9 keys across 8 suites — so this
        // floor is low by nature. It is here to catch `LITERAL_ID` breaking
        // independently of CREATE; without it, a dead id regex and a clean
        // codebase are the same green.
        expect(owners.size).toBeGreaterThanOrEqual(5);
    });

    it('no User or Tenant literal id is created by two different suites', () => {
        const shared = [...owners]
            .filter(([, suites]) => suites.size > 1)
            .map(([key, suites]) => `${key} created by ${[...suites].sort().join(', ')}`)
            .sort();

        // Exact equality, and no baseline: `'user-1'` was the only one, so any
        // entry here is new. The fix is a suite-unique id -- and note the EMAIL
        // must move with it, because `emailHash` carries User's only unique
        // index and a row left under the old id still holds the old address.
        expect(shared).toEqual([]);
    });
});
