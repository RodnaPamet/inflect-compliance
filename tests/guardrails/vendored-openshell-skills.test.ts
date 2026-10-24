/**
 * The vendored OpenShell Agent Skills must be the bytes NVIDIA published at
 * the pinned commit — and the manifest must cover all of them.
 *
 * `.claude/skills/` holds four skills copied from NVIDIA/OpenShell at commit
 * `bdb956f2…` (tag v0.1.5). They are developer tooling: the product runtime
 * never loads them. But once merged they are INSTRUCTIONS TO EVERY CLAUDE CODE
 * SESSION working on this repository, which makes them an injection surface for
 * the tools we develop with — the same concern the product's AI guard exists
 * for, arriving by a path the product's text scan does not cover.
 *
 * #3968 therefore requires they be vendored byte-for-byte and read in full
 * before merge. This guard holds the first half mechanically. The read is
 * recorded in `.claude/skills/OPENSHELL-LOCAL-NOTES.md`, with the three
 * findings it produced.
 *
 * ── WHY BOTH DIRECTIONS ─────────────────────────────────────────────────
 *
 * Hashing the manifest's entries catches an edit to a vendored file. It does
 * NOT catch a file ADDED under `.claude/skills/` that no manifest row names —
 * and an unlisted file is the more useful place to hide something, because it
 * is unchecked by construction while the suite stays green. So the test also
 * walks the tree and asserts every vendored path appears in the manifest.
 *
 * `identity-chain-diagnostic/` is this repository's OWN skill, written here,
 * and is excluded by name rather than by pattern: a pattern that happened to
 * exclude a vendored directory would silently stop checking it.
 *
 * ── NETWORK-FREE, DELIBERATELY ──────────────────────────────────────────
 *
 * Nothing here fetches. A guard that re-downloaded from GitHub would be
 * testing NVIDIA's availability, would pass against a force-pushed tag, and
 * could not run in the offline Ratchets job at all. The manifest in
 * `VENDORED.md` is the committed baseline; `git log` is the audit trail for
 * changing it. The downloads WERE verified against GitHub's own git blob SHAs
 * at vendoring time, which is recorded in `VENDORED.md`.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SKILLS = path.join(ROOT, '.claude/skills');
const MANIFEST = path.join(SKILLS, 'VENDORED.md');

/** This repository's own skills, which carry no upstream hash. Named, not matched. */
const LOCALLY_AUTHORED = new Set([
    'identity-chain-diagnostic/SKILL.md',
    'VENDORED.md',
    'OPENSHELL-LOCAL-NOTES.md',
]);

const sha256 = (file: string): string =>
    createHash('sha256').update(fs.readFileSync(file)).digest('hex');

interface Row {
    hash: string;
    bytes: number;
    file: string;
}

function manifestRows(): Row[] {
    const md = fs.readFileSync(MANIFEST, 'utf8');
    const rows: Row[] = [];
    for (const line of md.split('\n')) {
        const m = /^\|\s*`([0-9a-f]{64})`\s*\|\s*(\d+)\s*\|\s*`([^`]+)`\s*\|$/.exec(line.trim());
        if (m) rows.push({ hash: m[1], bytes: Number(m[2]), file: m[3] });
    }
    return rows;
}

/** Every file under `.claude/skills/`, relative to it. */
function vendoredTree(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else out.push(path.relative(SKILLS, full));
        }
    };
    walk(SKILLS);
    return out.sort();
}

describe('the vendored OpenShell skills match their manifest', () => {
    const rows = manifestRows();

    it('reads a manifest with rows in it', () => {
        // The denominator. Every per-file assertion below passes vacuously
        // against an empty manifest, and a regex that stopped matching the
        // table's shape would empty it without failing anything else.
        expect(rows.length).toBeGreaterThanOrEqual(7);
        expect(new Set(rows.map((r) => r.file)).size).toBe(rows.length);
    });

    it.each(rows.map((r) => [r.file, r] as const))('%s is unmodified', (_file, row) => {
        const abs = path.join(SKILLS, row.file);
        expect(fs.existsSync(abs)).toBe(true);
        // Bytes first: a size mismatch names the problem more usefully than a
        // hash mismatch does, and it cannot be satisfied by a collision.
        expect(fs.statSync(abs).size).toBe(row.bytes);
        expect(sha256(abs)).toBe(row.hash);
    });

    it('the manifest covers every vendored file — nothing unlisted', () => {
        const listed = new Set(rows.map((r) => r.file));
        const unlisted = vendoredTree().filter(
            (f) => !listed.has(f) && !LOCALLY_AUTHORED.has(f),
        );
        expect(unlisted).toEqual([]);
    });

    it('records the pinned commit, and the local notes exist beside it', () => {
        const md = fs.readFileSync(MANIFEST, 'utf8');
        expect(md).toMatch(/\bbdb956f2cd65a635f1294fccf1d138d263bf650f\b/);
        expect(md).toContain('Apache License 2.0');
        expect(fs.existsSync(path.join(SKILLS, 'LICENSE-Apache-2.0.txt'))).toBe(true);
        // The read #3968 requires is evidenced by the notes, not by this guard.
        expect(fs.existsSync(path.join(SKILLS, 'OPENSHELL-LOCAL-NOTES.md'))).toBe(true);
    });

    it('is attributed in NOTICE as redistribution, not as a blueprint', () => {
        const notice = fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8');
        expect(notice).toContain('bdb956f2cd65a635f1294fccf1d138d263bf650f');
        // pipelock's entry says the opposite — "no pipelock code is imported,
        // linked, or redistributed". Copying files in IS redistribution, and
        // the two entries must not be confused for each other.
        expect(notice).toMatch(/REDISTRIBUTED COPIES/);
    });
});
