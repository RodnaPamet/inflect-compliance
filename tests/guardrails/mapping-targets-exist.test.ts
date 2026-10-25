/**
 * Every mapping reference names a node its library actually carries.
 *
 * ═══ THE DEFECT THIS EXISTS FOR (#2621) ═══
 *
 * `iso27001-to-nist-csf.yaml` mapped ISO 27001's A.5.2 onto `GV.RR-01`, a CSF
 * outcome IC's condensed CSF library does not model. The mapping-set importer
 * records an unresolvable reference as an error and CONTINUES, so the entry
 * reached no database and did nothing, silently, for its whole life — and
 * every test stayed green, because nothing compared a mapping's references
 * against the library it claims to reference.
 *
 * One reference in 976 was wrong. The cost of finding it was a full audit of
 * the subsystem; the cost of catching the next one is this file.
 *
 * ═══ WHAT THIS CHECKS ═══
 *
 * Two kinds of dead reference, and both fail:
 *
 *   • a node ABSENT FROM THE LIBRARY ENTIRELY — a typo, or an outcome from the
 *     real standard that IC's condensed subset does not carry;
 *   • a node that exists but is NON-ASSESSABLE — a heading. `library-importer.ts`
 *     writes a requirement row only for an assessable node, so an entry naming
 *     a heading resolves to nothing and is dropped exactly like the first kind.
 *
 * The second kind was a downward ratchet at 13 while the entries waited for a
 * per-entry decision. Ten entries in `iso27001-to-iso27701.yaml` and
 * `iso27701-to-gdpr.yaml` carried them. Five now resolve as written, because
 * ISO 27701 clause 6, which has no sub-clause in the outline, became the leaf
 * it is. Five were removed: three started from ISO 27001 management clauses,
 * which neither representation of ISO 27001 carries as an obligation, and two
 * named ISO 27701 clauses 7 and 8 as a whole. With the count at zero a ceiling
 * only lets the next one in, so the ratchet is gone.
 *
 * The distinction still matters when this goes red: an ABSENT node means
 * someone wrote a reference to something that was never there; a
 * NON-ASSESSABLE one means they aimed at a heading instead of a leaf, and the
 * fix is to name the leaf they meant. Making the node assessable is right only
 * when nothing sits under it and its catalogue ships it as an obligation, as
 * with ISO 27701 clause 6; a heading over leaves made assessable would count
 * its obligations twice.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import { parseLibraryFile, loadLibrary } from '@/app-layer/libraries';

const ROOT = path.resolve(__dirname, '../..');
const LIB_DIR = path.join(ROOT, 'src/data/libraries');
const MAP_DIR = path.join(LIB_DIR, 'mappings');

interface MappingSet {
    source_framework_ref?: string;
    target_framework_ref?: string;
    mapping_entries?: Array<{ source_ref?: string; target_ref?: string }>;
}

/**
 * ref_id -> { all node ids, assessable node ids }, read through the REPO'S OWN
 * LOADER rather than by parsing the YAML here.
 *
 * That is not tidiness. `assessable` is declared `z.boolean().default(true)` in
 * `libraries/schemas.ts`, so an ABSENT field means assessable — and a hand-
 * rolled parse that treats absent as false miscounts every library which omits
 * it. GDPR omits it on all 27 nodes and ISO 27701 on its leaves; the first
 * version of this file did exactly that and reported 103 dead references where
 * the real number is a fraction of it. Re-deriving a schema default beside the
 * schema is how the two drift.
 */
function librariesByRefId(): Map<string, { all: Set<string>; assessable: Set<string> }> {
    const out = new Map<string, { all: Set<string>; assessable: Set<string> }>();
    for (const file of fs.readdirSync(LIB_DIR)) {
        if (!file.endsWith('.yaml')) continue;
        const lib = loadLibrary(parseLibraryFile(path.join(LIB_DIR, file)), file);
        out.set(lib.refId, {
            all: new Set(lib.framework.nodes.map((n) => n.refId)),
            assessable: new Set(lib.framework.nodes.filter((n) => n.assessable).map((n) => n.refId)),
        });
    }
    return out;
}

function mappingSets(): Array<{ file: string; set: MappingSet }> {
    return fs
        .readdirSync(MAP_DIR)
        .filter((f) => f.endsWith('.yaml'))
        .map((f) => ({
            file: f,
            set: yaml.load(fs.readFileSync(path.join(MAP_DIR, f), 'utf8')) as MappingSet,
        }));
}

describe('cross-framework mappings reference nodes that exist', () => {
    const libs = librariesByRefId();
    const sets = mappingSets();

    it('discovers the libraries and the mapping sets', () => {
        // Positive control. Every assertion below is vacuous if either side is
        // empty — an absence proves nothing until the scan is known to work.
        expect(libs.size).toBeGreaterThanOrEqual(10);
        expect(sets.length).toBeGreaterThanOrEqual(20);
    });

    it('no reference names a node absent from its library entirely', () => {
        const absent: string[] = [];
        for (const { file, set } of sets) {
            const src = set.source_framework_ref ? libs.get(set.source_framework_ref) : undefined;
            const tgt = set.target_framework_ref ? libs.get(set.target_framework_ref) : undefined;
            for (const e of set.mapping_entries ?? []) {
                if (src && e.source_ref && !src.all.has(String(e.source_ref))) {
                    absent.push(`${file}: source_ref ${e.source_ref} not in ${set.source_framework_ref}`);
                }
                if (tgt && e.target_ref && !tgt.all.has(String(e.target_ref))) {
                    absent.push(`${file}: target_ref ${e.target_ref} not in ${set.target_framework_ref}`);
                }
            }
        }
        expect(absent).toEqual([]);
    });

    it('no reference names a NON-ASSESSABLE node (a heading)', () => {
        const dead: string[] = [];
        for (const { file, set } of sets) {
            const src = set.source_framework_ref ? libs.get(set.source_framework_ref) : undefined;
            const tgt = set.target_framework_ref ? libs.get(set.target_framework_ref) : undefined;
            for (const e of set.mapping_entries ?? []) {
                if (src && e.source_ref && src.all.has(String(e.source_ref)) && !src.assessable.has(String(e.source_ref))) {
                    dead.push(`${file}: source_ref ${e.source_ref}`);
                }
                if (tgt && e.target_ref && tgt.all.has(String(e.target_ref)) && !tgt.assessable.has(String(e.target_ref))) {
                    dead.push(`${file}: target_ref ${e.target_ref}`);
                }
            }
        }
        expect(dead).toEqual([]);
    });
});
