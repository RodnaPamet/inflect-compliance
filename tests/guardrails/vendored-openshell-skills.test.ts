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
 * `identity-chain-diagnostic/`, `steward/` and `babysit/` are this
 * repository's OWN skills, written here, and are excluded by name rather than
 * by pattern: a pattern that happened to exclude a vendored directory would
 * silently stop checking it.
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
    'steward/SKILL.md',
    'babysit/SKILL.md',
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

    /*
        ASSERTED ON PARSED FIELDS, NOT ON THE RAW TEXT, and the raw-source
        ratchet is right to push for that here rather than it being a dodge.
        `expect(md).toContain('<commit>')` is satisfied by ANY mention of the
        commit anywhere in the file — including the prose paragraph two lines
        above the table that explains why the commit is pinned. So it would
        stay green with a wrong value in the row that matters. Pulling the
        field out of its own row first makes the assertion about the field.
    */
    const field = (md: string, label: string): string | null => {
        const m = new RegExp(`^\\|\\s*${label}\\s*\\|\\s*(.+?)\\s*\\|$`, 'm').exec(md);
        return m ? m[1] : null;
    };

    it('records the pinned commit in its own row, and the local notes sit beside it', () => {
        const md = fs.readFileSync(MANIFEST, 'utf8');
        expect(field(md, 'Commit')).toBe('`bdb956f2cd65a635f1294fccf1d138d263bf650f`');
        expect(field(md, 'Tag')).toContain('v0.1.5');
        expect(field(md, 'Licence')).toContain('Apache License 2.0');
        expect(fs.existsSync(path.join(SKILLS, 'LICENSE-Apache-2.0.txt'))).toBe(true);
        // The read #3968 requires is evidenced by the notes, not by this guard.
        expect(fs.existsSync(path.join(SKILLS, 'OPENSHELL-LOCAL-NOTES.md'))).toBe(true);
    });

    it('is attributed in NOTICE as redistribution, not as a blueprint', () => {
        const notice = fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8');
        // The whole attribution block, isolated from the rest of the file, so
        // neither assertion can be satisfied by an unrelated section. pipelock's
        // entry says the OPPOSITE — "no pipelock code is imported, linked, or
        // redistributed" — and the two must not be mistaken for each other.
        // NOTICE puts a rule BETWEEN each section's title and its body, so a
        // naive split yields the title alone and the body in the next part.
        // Take the part after the titled one.
        const parts = notice.split(/^-{20,}$/m);
        const titleAt = parts.findIndex((s) => s.includes('OpenShell Agent Skills'));
        expect(titleAt).toBeGreaterThanOrEqual(0);
        const block = parts[titleAt + 1];
        expect(block).toBeDefined();
        const lines = (block ?? '').split('\n').map((l) => l.trim());
        expect(lines).toContain('Commit: bdb956f2cd65a635f1294fccf1d138d263bf650f (tag v0.1.5, 2026-10-20)');
        expect(lines.some((l) => l.includes('REDISTRIBUTED COPIES'))).toBe(true);
        expect(lines.some((l) => l.includes('no pipelock code'))).toBe(false);
    });
});
