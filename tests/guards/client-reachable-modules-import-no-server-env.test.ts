/**
 * A module a client component can reach does not import `@/env`.
 *
 * `src/env.ts` declares ~90 server variables. A server variable's VALUE never
 * reaches a browser — t3-env throws on a server key read from the client — but
 * its SCHEMA is ordinary module code: the key names, the `z.string()…` calls
 * and the whole `runtimeEnv` mapping. `next build` bundles everything a
 * `'use client'` file statically reaches, so ONE import edge puts all of it
 * into a route's First Load JS.
 *
 * MEASURED, #4759 against main (#4764 is the fix): that PR's only
 * client-reachable change was four optional server strings added to
 * `src/env.ts`.
 *
 *     124 of 183 routes   +0.1 KB First Load JS
 *      59 of 183 routes    unchanged
 *     controls/[controlId]/tests/[planId]/page   668.9 -> 669.0 KB   (budget 669)
 *
 * Four strings taxed two thirds of the app and failed the per-route bundle
 * budget on a page that has nothing to do with them. The edge was
 * `notifications-bell.tsx` — a `'use client'` component the top chrome mounts
 * on every workspace page — importing `@/env` for a single feature flag.
 *
 * WHY A GUARD AND NOT THE BUDGET. The budget already failed, and that is the
 * problem: it failed on a route nobody had touched, for a reason in no route,
 * in a PR about a gRPC transport. The attribution took an hour and the cheap
 * way out was raising the line — which is what the `controls` bucket's history
 * records four times in nine days (655 -> 662 -> 668 -> 669 -> 670), on changes
 * that added no route code. This guard fails in the diff that adds the edge,
 * names the import path, and costs nothing to read.
 *
 * NO ALLOWLIST. A client-reachable module that needs a variable adds it to
 * `src/env-client.ts`, which is the only kind of variable it may read anyway:
 * anything without the `NEXT_PUBLIC_` prefix is unreadable in a browser, so
 * "I need `@/env` here" always means either "I need a `NEXT_PUBLIC_` variable"
 * (declare it in the client module) or "this module is not really client-side"
 * (move the server need behind a server-only module, as the Node-built-in
 * guard beside this one already requires).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { clientRoots, reachFrom } from '../helpers/client-import-graph';
import { REPO_ROOT, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

const SERVER_ENV = path.join(REPO_ROOT, 'src/env.ts');
const CLIENT_ENV = path.join(REPO_ROOT, 'src/env-client.ts');

describe('a module a client component can reach imports no server env', () => {
    const clientFiles = clientRoots();
    const { reached, via } = reachFrom(clientFiles);

    it('src/env.ts is not reachable from any `use client` file', () => {
        const reachable = reached.has(SERVER_ENV);
        expect({
            reachable,
            path: reachable ? via(SERVER_ENV) : 'none',
            hint: reachable
                ? 'Importing @/env from a client-reachable module ships ~90 server variable '
                  + 'declarations in every route that mounts it. Read the NEXT_PUBLIC_ flag from '
                  + '@/env-client instead, declaring it there if it is new.'
                : 'none',
        }).toEqual({ reachable: false, path: 'none', hint: 'none' });
    });

    /*
        THE POSITIVE COMPANION. "src/env.ts was not reached" is satisfied just
        as well by a walk that reached nothing — a moved directory, a renamed
        helper, a `clientRoots()` that silently returns [] — and that state
        reports as a pass. So the walk has to be shown to WORK, on this very
        question, by finding the module the fix moved the edge to.
    */
    it('actually walked a client graph, and reaches the client env module', () => {
        expect(clientFiles.length).toBeGreaterThan(100);
        expect(reached.size).toBeGreaterThan(clientFiles.length);
        expect(reached.has(CLIENT_ENV)).toBe(true);
        expect(via(CLIENT_ENV)).toContain('src/env-client.ts');
    });

    /*
        BOTH MODULE CLAIMS PARSE A VALUE AND COMPARE IT, rather than matching a
        needle against a whole-file read. Class D
        (`assertion-needle-uniqueness-ratchet`) caps how many whole-file
        assertions its analyser cannot read, and a read through a `path.join`
        constant is one of them — so the first draft of this file pushed that
        ceiling from 1370 to 1372. Parsing is also the better assertion: it
        reports WHICH key offends instead of that some needle matched.
    */
    it('the client env module declares only NEXT_PUBLIC_ variables', () => {
        // t3-env refuses a non-prefixed `client` key at build time; this says
        // the same thing in English, in the diff that would add one, and keeps
        // the module's purpose legible: it exists to be bundled.
        const src = codeOf(fs.readFileSync(CLIENT_ENV, 'utf8'));
        const block = src.slice(src.indexOf('client: {'), src.indexOf('runtimeEnv'));
        const keys = [...block.matchAll(/^\s{8}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
        expect({
            declared: keys.length > 0,
            notPublic: keys.filter((k) => !k.startsWith('NEXT_PUBLIC_')),
        }).toEqual({ declared: true, notPublic: [] });
    });

    it('the server env module declares no client block', () => {
        // The other half of the split: a `client:` key here would re-create a
        // reason for a client file to import this module.
        const src = codeOf(fs.readFileSync(SERVER_ENV, 'utf8'));
        expect({
            clientBlocks: [...src.matchAll(/^\s*client:\s*\{/gm)].length,
            nextPublic: [...new Set([...src.matchAll(/NEXT_PUBLIC_[A-Z0-9_]*/g)].map((m) => m[0]))],
        }).toEqual({ clientBlocks: 0, nextPublic: [] });
    });

    it('names the file it is about, so a rename cannot make it vacuous', () => {
        expect(fs.existsSync(SERVER_ENV)).toBe(true);
        expect(fs.existsSync(CLIENT_ENV)).toBe(true);
        expect(repoRelative(SERVER_ENV)).toBe('src/env.ts');
        expect(repoRelative(CLIENT_ENV)).toBe('src/env-client.ts');
    });
});
