/**
 * Docs accuracy ratchet.
 *
 * Keeps the docs honest about what has shipped. Backed by the
 * classification source of truth at `docs/_status/doc-classification.json`,
 * which buckets every `docs/**​/*.md` into one of four classes:
 *
 *   authoritative — describes shipped behaviour; every claim true today.
 *   living        — a partially-shipped design direction; future-tense intentional.
 *   historical    — pinned to a moment in time (dated audits, executed plans,
 *                   and the entire docs/implementation-notes/ subtree).
 *   deprecated    — superseded; body is a one-line redirect.
 *
 * What this enforces:
 *   - the classification file exists and round-trips with disk (bidirectional);
 *   - `living` docs carry the status banner + `Current state` + `Roadmap` H2s;
 *   - non-impl-note `historical` docs carry the historical banner (the
 *     implementation-notes subtree is historical-by-path and exempt — those
 *     files are READ-ONLY moment-in-time records);
 *   - `deprecated` docs carry the redirect banner;
 *   - `authoritative` docs contain NO future-tense markers outside an allowed
 *     context (fenced code, a Future-work/Roadmap tail section, a markdown-link
 *     target, or an explicit `<!-- docs-accuracy-allow: … -->` line).
 *
 * See the "Doc classifications" section of CLAUDE.md for the contributor
 * contract.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const DOCS_DIR = path.join(ROOT, 'docs');
const CLASSIFICATION_PATH = path.join(DOCS_DIR, '_status', 'doc-classification.json');
// Historical-by-path subtrees: dated, frozen records that are READ-ONLY and
// don't need an inline banner (their location IS the marker).
const BANNER_EXEMPT_HISTORICAL_PREFIXES = ['docs/implementation-notes/', 'docs/adr/'];

type DocClass = 'authoritative' | 'living' | 'historical' | 'deprecated';

/**
 * Classification derived from the PATH, for subtrees where the class is not a
 * decision anyone makes per file.
 *
 * `docs/implementation-notes/` was 549 of 675 map entries — 81% — and every
 * one said `historical`, which is what the subtree MEANS. Storing that
 * constant cost one map edit per note, and the shape of that edit is the
 * problem: a new key rewrites the previous entry's `}` into `},`, so two
 * PRs touch the same line and conflict. On 2026-08-19 that forced five
 * rebases in one night, each discarding a green CI run.
 *
 * The conflict was always LOUD, so this is friction rather than a
 * correctness hazard — but it is friction paid on every note, forever.
 *
 * ═══ NOT THE SAME LIST AS BANNER_EXEMPT_HISTORICAL_PREFIXES ═══
 *
 * They look identical and must not be merged. The banner list also contains
 * `docs/adr/`, and an ADR's class genuinely CHANGES over its life — a
 * superseded ADR becomes `deprecated`. Deriving ADRs as historical would
 * silently foreclose the normal ADR lifecycle. Two lists, adjacent, because
 * they answer different questions: "does this need a banner?" and "is this
 * doc's class a decision?".
 */
const PATH_DERIVED_CLASSES: ReadonlyArray<readonly [string, DocClass]> = [
    ['docs/implementation-notes/', 'historical'],
];

/**
 * Returns `undefined` outside the listed prefixes — deliberately, and this is
 * load-bearing. A global default would make `every doc on disk is classified`
 * unable to catch a new unclassified doc, and the whole ratchet decorative.
 */
function derivedClass(rel: string): DocClass | undefined {
    return PATH_DERIVED_CLASSES.find(([prefix]) => rel.startsWith(prefix))?.[1];
}
interface Classification {
    counts?: Partial<Record<DocClass, number>>;
    docs: Record<string, { class: DocClass } & Record<string, unknown>>;
}

const LIVING_BANNER = '> **Status: living design**';
const HISTORICAL_BANNER = '> **Status: historical record';
const DEPRECATED_BANNER = '> **Deprecated.**';

// Future-tense markers. `pending` is intentionally NOT ratcheted (too many
// legitimate status-noun uses like "pending approval"); it is reviewed during
// the audit but not hard-failed here.
const MARKER_RE = /coming soon|not yet|\bTODO\b|\bFIXME\b|\bWIP\b|will be|roadmap/i;
const TAIL_SECTION_RE = /^##\s+(Future work|Future scaling|Future direction|Roadmap)\b/i;
const ALLOW_MARKER = 'docs-accuracy-allow';

/** Recursively list every .md under docs/, repo-relative, posix slashes. */
function listDocs(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(abs);
            else if (entry.name.endsWith('.md')) out.push(path.relative(ROOT, abs).split(path.sep).join('/'));
        }
    };
    walk(DOCS_DIR);
    return out.sort();
}

function loadClassification(): Classification {
    return JSON.parse(fs.readFileSync(CLASSIFICATION_PATH, 'utf8')) as Classification;
}

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Find future-tense marker violations in an authoritative doc. Returns
 * `"<line>: <text>"` for each offending line. Allowed contexts are skipped.
 */
function markerViolations(rel: string): string[] {
    const lines = read(rel).split('\n');
    const violations: string[] = [];
    let inFence = false;
    let tailReached = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
        if (inFence) continue;
        if (TAIL_SECTION_RE.test(line)) { tailReached = true; }
        if (tailReached) continue; // everything from the tail heading down is exempt
        if (line.includes(ALLOW_MARKER)) continue;
        if (i > 0 && lines[i - 1].includes(ALLOW_MARKER)) continue;
        // Strip markdown-link targets and inline code spans before testing, so a
        // cross-link to a roadmap doc or a literal `WIP` value doesn't trip.
        const stripped = line.replace(/\]\([^)]*\)/g, '](#)').replace(/`[^`]*`/g, '``');
        if (MARKER_RE.test(stripped)) {
            violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
    }
    return violations;
}

describe('docs accuracy', () => {
    it('classification file exists and parses', () => {
        expect(fs.existsSync(CLASSIFICATION_PATH)).toBe(true);
        expect(() => loadClassification()).not.toThrow();
    });

    const classification = fs.existsSync(CLASSIFICATION_PATH) ? loadClassification() : { docs: {} };
    const onDisk = listDocs();
    const classified = Object.keys(classification.docs);

    /** Derived class wins over the map — see `path-derived subtrees carry no map entries`. */
    const classOf = (rel: string): DocClass | undefined =>
        derivedClass(rel) ?? classification.docs[rel]?.class;

    /**
     * There is no `counts` header any more, and re-adding one is the thing
     * this now guards against.
     *
     * It was a DERIVED tally stored beside its own source, and the way it
     * drifted is the reason it had to go. Two PRs each add one doc and each
     * bump the same number 494 -> 495. Neither CONFLICTS: their entries land
     * in different places and the count line is IDENTICAL, so git takes it
     * once. Both PRs are green, main is wrong by one, and no reviewer sees a
     * suspicious diff — the header says exactly what each author intended.
     *
     * A clean merge is the dangerous case, which is why "just recount
     * carefully" never held. The drift is undetectable on either branch and
     * only appears on main, so it turns main red AFTER both PRs pass. It
     * happened between #1798 and #1803 (which prompted the original check),
     * and again across three branches in the 2026-08-16 batch, where every
     * one of them recomputed the tally correctly against its own map.
     *
     * Nothing outside this file ever read the header. Deleting it removes the
     * whole failure class rather than monitoring it; the tally is one
     * Object.values().length away for anyone who wants it.
     */
    it('carries no derived counts header', () => {
        expect({
            hasCounts: 'counts' in classification,
            why: 'derived data beside its own source merges cleanly to a wrong value',
        }).toEqual({
            hasCounts: false,
            why: 'derived data beside its own source merges cleanly to a wrong value',
        });
    });

    it('every doc on disk is classified', () => {
        // Through `classOf`, so a doc under a derived prefix counts as
        // classified — but a doc OUTSIDE those prefixes with no entry still
        // fails here. That is the property the whole ratchet rests on.
        const missing = onDisk.filter((d) => !classOf(d));
        expect(missing).toEqual([]);
    });

    it('path-derived subtrees carry no map entries', () => {
        // Without this the file grows back: the next author adds a note, adds
        // an entry out of habit, and the conflict returns one note at a time.
        // Also forecloses an in-subtree override — deliberately. An
        // implementation note is declared READ-ONLY and moment-in-time, so a
        // live-reference note inside it is a category error; such a doc
        // belongs at `docs/<name>.md`. Exactly one had drifted that way
        // (2026-07-14-ep1-evidence-review-gate, marked `authoritative` while
        // naming a source file that no longer exists).
        const redundant = classified.filter((d) => derivedClass(d) !== undefined);
        expect(redundant).toEqual([]);
    });

    it('every classified entry exists on disk', () => {
        const onDiskSet = new Set(onDisk);
        const stale = classified.filter((d) => !onDiskSet.has(d));
        expect(stale).toEqual([]);
    });

    it('every classification is one of the four valid classes', () => {
        const valid: DocClass[] = ['authoritative', 'living', 'historical', 'deprecated'];
        const bad = classified.filter((d) => !valid.includes(classification.docs[d].class));
        expect(bad).toEqual([]);
    });

    // Per-class structural checks. Generate one test per doc so a failure
    // names the exact file.
    for (const rel of onDisk) {
        const cls = classOf(rel);
        if (!cls) continue;

        if (cls === 'living') {
            it(`living doc has banner + Current state + Roadmap: ${rel}`, () => {
                const body = read(rel);
                expect(body.includes(LIVING_BANNER)).toBe(true);
                expect(/^##\s+Current state/m.test(body)).toBe(true);
                expect(/^##\s+Roadmap/m.test(body)).toBe(true);
            });
        } else if (cls === 'historical') {
            // Historical-by-path subtrees (implementation-notes, adr) are
            // READ-ONLY frozen records — no inline banner required.
            const bannerExempt = BANNER_EXEMPT_HISTORICAL_PREFIXES.some((p) => rel.startsWith(p));
            if (!bannerExempt) {
                it(`historical doc has the historical banner: ${rel}`, () => {
                    expect(read(rel).includes(HISTORICAL_BANNER)).toBe(true);
                });
            }
        } else if (cls === 'deprecated') {
            it(`deprecated doc has the redirect banner: ${rel}`, () => {
                expect(read(rel).includes(DEPRECATED_BANNER)).toBe(true);
            });
        } else {
            // authoritative
            it(`authoritative doc has no stray future-tense markers: ${rel}`, () => {
                expect(markerViolations(rel)).toEqual([]);
            });
        }
    }
});
