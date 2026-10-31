/**
 * Async-params route-typing ratchet.
 *
 * Next 15+ delivers a route handler's dynamic params as a Promise.
 * Roadmap-6 P3 migrated every handler under src/app/api to the
 * correct contract (params typed Promise + an explicit await) and
 * removed the transparent-await shim that withApiErrorHandling once
 * carried.
 *
 * This guard locks that completion in. A handler that types params
 * synchronously compiles fine -- tsc cannot tell the difference --
 * but at runtime params is a Promise, so a synchronous property
 * access is silently undefined. With the shim gone there is no
 * safety net; this scan IS the safety net.
 *
 * Pure static analysis -- scans src/app/api for route.ts files.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const API_DIR = path.resolve(__dirname, '../../src/app/api');

/** Every route.ts under src/app/api. */
function routeFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...routeFiles(abs));
        else if (entry.name === 'route.ts') out.push(abs);
    }
    return out;
}

/**
 * Flag a synchronously-typed params. A migrated handler reads
 * `params: Promise<...>` (or destructures `{ params: paramsPromise }`,
 * i.e. `params:` followed by an identifier). A sync annotation is
 * `params:` immediately followed by an object-type open-brace -- that
 * is the regression.
 */
const REPO_ROOT = path.resolve(__dirname, '../..');

const SYNC_PARAMS = /\bparams\s*:\s*\{/;

function syncParamHits(src: string): number[] {
    const hits: number[] = [];
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const stripped = lines[i].trim();
        if (stripped.startsWith('//') || stripped.startsWith('*')) continue;
        if (SYNC_PARAMS.test(lines[i])) hits.push(i + 1);
    }
    return hits;
}

/**
 * The WRAPPER TYPES a route's params too, and this guard could not see it.
 *
 * `SYNC_PARAMS` above flags `params:` followed by an object-type brace and
 * deliberately allows `params:` followed by an IDENTIFIER, so a destructure
 * passes. `src/lib/security/permission-middleware.ts` declared
 *
 *     routeArgs: { params: TParams },
 *
 * which is `params:` + an identifier — so it read as migrated while the generic
 * was instantiated SYNCHRONOUSLY, on all 368 routes that go through
 * `requirePermission`. The file's own docblock said the opposite one function
 * below ("the route export receives `params` as a Promise"), so the comment and
 * the type disagreed and nothing adjudicated.
 *
 * Nothing else covers it either. The only check that DOES see it is `tsc` over
 * `.next/types/validator.ts`, where Next asserts each route module against
 * `RouteHandlerConfig` — and CI never runs that combination: the `Typecheck`
 * job has no build step, so the generated file does not exist there, and
 * `next build` passed with the bug. It surfaced only from a local build.
 *
 * So this block checks the TYPES THE WRAPPERS DECLARE, by name. It is a source
 * scan rather than a build, because the point is to catch it in `Ratchets`
 * without adding ~20 minutes to a required check.
 */
const PARAM_TYPING_WRAPPERS: ReadonlyArray<{ readonly file: string; readonly type: string }> = [
    { file: 'src/lib/security/permission-middleware.ts', type: 'RouteHandler' },
];

describe('the wrappers that type a route\'s params accept a Promise', () => {
    it('names a real population (an empty list passes everything below)', () => {
        expect(PARAM_TYPING_WRAPPERS.length).toBeGreaterThanOrEqual(1);
    });

    it.each(PARAM_TYPING_WRAPPERS)(
        '$file: $type accepts a Promise for params',
        ({ file, type }) => {
            const src = fs.readFileSync(path.resolve(REPO_ROOT, file), 'utf8');
            const decl = src.slice(src.indexOf(`export type ${type}<`));
            expect(decl).not.toBe('');

            // The declaration up to its closing `=> ` — the parameter list.
            const params = decl.slice(0, decl.indexOf('=>'));
            // `params:` must reach a Promise. Sync-only is the regression, and
            // `params: TParams` is exactly how it hid: an identifier, so the
            // route-file regex above cannot judge it.
            expect(params).toMatch(/params\s*:[^,;]*Promise</);
        },
    );

    it('the detector would SEE the shape that shipped', () => {
        // The positive control, and it is not optional here: the assertion
        // above is a `toMatch` over a slice, which passes on any string that
        // happens to contain `Promise<`. This pins that the SYNC form fails.
        const sync = 'export type RouteHandler<T> = (\n    req: NextRequest,\n'
            + '    routeArgs: { params: T },\n) => Promise<Response>;';
        const params = sync.slice(0, sync.indexOf('=>'));
        expect(params).not.toMatch(/params\s*:[^,;]*Promise</);

        const fixed = sync.replace('params: T }', 'params: T | Promise<T> }');
        const fixedParams = fixed.slice(0, fixed.indexOf('=>'));
        expect(fixedParams).toMatch(/params\s*:[^,;]*Promise</);
    });
});

describe('async-params route typing', () => {
    const files = routeFiles(API_DIR);

    it('the scan actually found route handlers (not vacuous)', () => {
        expect(files.length).toBeGreaterThan(250);
    });

    it('no route handler types params synchronously', () => {
        const offenders: string[] = [];
        for (const abs of files) {
            const src = fs.readFileSync(abs, 'utf8');
            for (const line of syncParamHits(src)) {
                offenders.push(`${path.relative(API_DIR, abs)}:${line}`);
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                'Route handler(s) type params synchronously. Next 15+ ' +
                    'delivers params as a Promise -- type it ' +
                    'params: Promise<{ ... }> and await it. A sync ' +
                    'annotation compiles but the access is undefined at ' +
                    'runtime:\n' +
                    offenders.map((o) => '  - ' + o).join('\n'),
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('detects a synchronously-typed params (regression proof)', () => {
        const sample = [
            'async (req, { params }: { params: { id: string } }) => {',
            '    return ok(params.id);',
        ].join('\n');
        expect(syncParamHits(sample)).toEqual([1]);
    });

    it('accepts the migrated Promise-typed form', () => {
        const sample = [
            'async (req, { params: paramsPromise }: { params: Promise<{ id: string }> }) => {',
            '    const params = await paramsPromise;',
            '    return ok(params.id);',
        ].join('\n');
        expect(syncParamHits(sample)).toEqual([]);
    });
});
