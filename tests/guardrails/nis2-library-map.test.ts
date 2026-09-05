/**
 * The NIS2 template -> library-node join resolves.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * A NIS2 control template names its requirement as `Art.21(2)(a)`; the node in
 * `src/data/libraries/nis2-2022.yaml` that carries the obligation text names
 * itself `NIS2-RM`. Two naming schemes, no join, so ZERO of 20 templates
 * resolved to their own source material — and nothing said so, because nothing
 * had ever tried to resolve them.
 *
 * DORA has the same relationship and does not need a map: its template
 * requirement IS the library `ref_id`, so all 24 resolve by equality and a
 * typo fails loudly. NIS2's join lives in data instead, and data with nothing
 * checking it rots exactly the way the missing join did. Hence this file.
 *
 * The map was DERIVED, not judged: every node in the library cites its own
 * article in its description (`(Paraphrase — Art. 21(2)(a))`), and eleven
 * entries match on the exact article. `Art.20` and `Art.23` match at article
 * level because the library carries one node for each of those whole articles,
 * which three and two templates respectively subdivide.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/repo-files';

const LIBRARY = path.join(REPO_ROOT, 'src/data/libraries/nis2-2022.yaml');
const FIXTURE = path.join(REPO_ROOT, 'prisma/fixtures/nis2-control-templates.json');
const MAP_FILE = path.join(REPO_ROOT, 'prisma/fixtures/nis2-library-map.json');

interface MapFile {
    map: Record<string, string>;
    unmapped: Record<string, string>;
}

function readJson<T>(p: string): T {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

const mapFile = readJson<MapFile>(MAP_FILE);
const templates = (() => {
    const raw = readJson<unknown>(FIXTURE);
    const list = Array.isArray(raw)
        ? raw
        : ((raw as { templates?: unknown[] }).templates ?? []);
    return (list as Array<{ code?: string }>).filter((t) => typeof t.code === 'string');
})();

/** Every `ref_id:` in the library. */
const libraryRefIds = new Set(
    [...fs.readFileSync(LIBRARY, 'utf8').matchAll(/^\s*ref_id:\s*(\S+)\s*$/gm)].map((m) => m[1]!),
);

/** Keys in `unmapped` that are template codes rather than the `_why` preamble. */
const unmappedCodes = Object.keys(mapFile.unmapped).filter((k) => !k.startsWith('_'));

describe('the NIS2 template -> library join resolves', () => {
    it('the library actually parsed (the test is not vacuous)', () => {
        // Every assertion below is satisfiable by an empty set. If the ref_id
        // regex ever stops matching — a reformat, a quoting change — this test
        // is the one that notices, rather than the suite going quietly green.
        expect(libraryRefIds.size).toBeGreaterThan(10);
        expect(templates.length).toBeGreaterThan(10);
    });

    it('every mapped node exists in the library', () => {
        const missing = Object.entries(mapFile.map)
            .filter(([, refId]) => !libraryRefIds.has(refId))
            .map(([code, refId]) => `${code} -> ${refId}`);
        expect(missing).toEqual([]);
    });

    it('every shipped template is classified — mapped or explicitly unmapped', () => {
        // The state being prevented is a template that is neither, which is
        // what all 20 were: not grounded, and not recorded as ungrounded, so
        // "no authored tasks" and "no source to author from" looked identical.
        const classified = new Set([...Object.keys(mapFile.map), ...unmappedCodes]);
        const unclassified = templates.map((t) => t.code!).filter((c) => !classified.has(c));
        expect(unclassified).toEqual([]);
    });

    it('no entry names a template that does not ship (no stale entries)', () => {
        const shipped = new Set(templates.map((t) => t.code!));
        const stale = [...Object.keys(mapFile.map), ...unmappedCodes].filter(
            (c) => !shipped.has(c),
        );
        expect(stale).toEqual([]);
    });

    it('every unmapped template carries a written reason', () => {
        // An unmapped entry is a claim that the DIRECTIVE does not place this
        // obligation on an entity — Art.7 and Art.25 address Member States,
        // Art.28 addresses TLD registries. That claim has to be readable and
        // arguable, not a blank.
        const thin = unmappedCodes.filter((c) => (mapFile.unmapped[c] ?? '').trim().length < 40);
        expect(thin).toEqual([]);
    });

    it('a template is not both mapped and unmapped', () => {
        const both = Object.keys(mapFile.map).filter((c) => unmappedCodes.includes(c));
        expect(both).toEqual([]);
    });
});
