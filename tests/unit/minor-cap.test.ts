/**
 * Unit tests for the minor-version cap (scripts/lib/minor-cap.mjs) and
 * the semantic-release plugin wrapper (scripts/semrel-minor-cap.mjs).
 *
 * The pure decision logic is exercised through a Node subprocess: the
 * plugin's sibling import (@semantic-release/commit-analyzer) is
 * ESM-only, so importing it inside jest's CJS world is brittle. The
 * subprocess (`node --input-type=module`) evaluates the real modules
 * exactly as semantic-release will at release time.
 *
 * RUN: npx jest tests/unit/minor-cap.test.ts
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(__dirname, '..', '..');
const CAP_MOD = pathToFileURL(path.join(ROOT, 'scripts/lib/minor-cap.mjs')).href;
const PLUGIN_MOD = pathToFileURL(path.join(ROOT, 'scripts/semrel-minor-cap.mjs')).href;

type Case = { base: string | null; last: string };

/** Evaluate capMinor(base, last) for each case in a real ESM subprocess. */
function decide(cases: Case[]): Array<string | null> {
    const script = `
        const cases = JSON.parse(process.env.CASES);
        const { capMinor } = await import(process.env.MOD);
        process.stdout.write(JSON.stringify(cases.map((c) => capMinor(c.base, c.last)))); `;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, CASES: JSON.stringify(cases), MOD: CAP_MOD },
    });
    if (res.status !== 0) {
        throw new Error(`capMinor subprocess failed (status ${res.status}):\n${res.stderr}`);
    }
    return JSON.parse(res.stdout);
}

describe('capMinor — minor-version cap decision', () => {
    it('promotes a minor bump to major only when it would push the minor to 1000', () => {
        const [
            patchAt999,
            minorAt999,
            minorAt998,
            majorAt999,
            noRelease,
            recursAt2999,
            minorEarly,
        ] = decide([
            { base: 'patch', last: '1.999.4' }, // patch never touches the minor
            { base: 'minor', last: '1.999.4' }, // would be 1.1000.0 → roll major
            { base: 'minor', last: '1.998.0' }, // 999 is allowed (three digits)
            { base: 'major', last: '1.999.0' }, // already a major
            { base: null, last: '1.999.0' }, // no release
            { base: 'minor', last: '2.999.7' }, // rollover recurs per major line
            { base: 'minor', last: '1.5.0' }, // ordinary minor bump
        ]);

        expect(patchAt999).toBe('patch');
        expect(minorAt999).toBe('major');
        expect(minorAt998).toBe('minor');
        expect(majorAt999).toBe('major');
        expect(noRelease).toBeNull();
        expect(recursAt2999).toBe('major');
        expect(minorEarly).toBe('minor');
    });

    it('does not promote when the last version is unknown/malformed (fails open to minor)', () => {
        const [emptyLast, garbage] = decide([
            { base: 'minor', last: '' },
            { base: 'minor', last: 'not-a-version' },
        ]);
        // A missing/unparseable minor must NOT force a spurious major bump.
        expect(emptyLast).toBe('minor');
        expect(garbage).toBe('minor');
    });

    it('exposes MINOR_CAP = 999', () => {
        const res = spawnSync(
            process.execPath,
            ['--input-type=module', '-e', `const m = await import(process.env.MOD); process.stdout.write(String(m.MINOR_CAP));`],
            { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MOD: CAP_MOD } },
        );
        expect(res.status).toBe(0);
        expect(res.stdout).toBe('999');
    });
});

/**
 * Run the REAL plugin over synthetic commits, using the REAL releaseRules out of
 * `.releaserc.json`.
 *
 * The config is READ FROM THE SHIPPED FILE rather than restated here. A copy
 * would keep passing after somebody edited the real one, which is the whole
 * failure this file exists to prevent — the versioning scheme has no other
 * enforcement, and a wrong release type is only visible once a tag exists.
 */
function releaseTypeFor(messages: string[], lastVersion: string): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const releaserc = JSON.parse(readFileSync(path.join(ROOT, '.releaserc.json'), 'utf8'));
    const [pluginPath, pluginConfig] = releaserc.plugins[0];
    expect(pluginPath).toBe('./scripts/semrel-minor-cap.mjs');

    const script = `
        const { analyzeCommits } = await import(process.env.MOD);
        const commits = JSON.parse(process.env.COMMITS).map((m, i) => ({
            message: m, hash: 'h'.repeat(7) + i, subject: m.split('\\n')[0],
        }));
        const t = await analyzeCommits(JSON.parse(process.env.CFG), {
            commits, lastRelease: { version: process.env.LAST }, logger: { log() {} },
        });
        process.stdout.write(String(t)); `;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
            ...process.env,
            MOD: PLUGIN_MOD,
            CFG: JSON.stringify(pluginConfig),
            COMMITS: JSON.stringify(messages),
            LAST: lastVersion,
        },
    });
    if (res.status !== 0) {
        throw new Error(`plugin subprocess failed (status ${res.status}):\n${res.stderr}`);
    }
    return res.stdout;
}

/**
 * The odometer is the ONLY source of a major bump.
 *
 * Both majors this repo has ever cut came from a `!` commit, not the odometer:
 * `fix(authz)!` took 1.903.12 to 2.0.0 and `chore(infra)!` took 2.0.5 to 3.0.0.
 * The rule that a breaking change climbs like anything else is what keeps the
 * minor running to 999, and it lives in one word of `.releaserc.json`.
 */
describe('a breaking change does NOT bump the major', () => {
    it.each([
        ['chore(infra)!: drop it\n\nBREAKING CHANGE: gone', 'the #2272 shape — a type absent from releaseRules'],
        ['fix(authz)!: gate writes\n\nBREAKING CHANGE: gone', 'the #2254 shape'],
        ['feat!: reshape it\n\nBREAKING CHANGE: gone', 'subject marker AND footer'],
        ['feat!: reshape it', 'subject marker alone, no footer'],
    ])('yields minor, not major — %s', (message) => {
        expect(releaseTypeFor([message], '3.1.3')).toBe('minor');
    });

    it('still climbs normally for ordinary commits', () => {
        expect(releaseTypeFor(['feat: add a thing'], '3.1.3')).toBe('minor');
        expect(releaseTypeFor(['fix: mend a thing'], '3.1.3')).toBe('patch');
    });

    it('rolls the major ONLY at the odometer boundary', () => {
        // 999 is the last legal minor, so the next feat is the rollover — and a
        // breaking change reaches it by the same road as any other feature.
        expect(releaseTypeFor(['feat: add a thing'], '3.999.4')).toBe('major');
        expect(releaseTypeFor(['chore(infra)!: drop it\n\nBREAKING CHANGE: gone'], '3.999.4')).toBe('major');
        // A patch never moves the minor, so it never rolls over.
        expect(releaseTypeFor(['fix: mend a thing'], '3.999.4')).toBe('patch');
    });

    it('closes the default-rule fallthrough the config cannot reach', () => {
        // The `breaking` rule shadows DEFAULT_RELEASE_RULES[0] ({breaking:true})
        // because the predicate is identical. It does NOT shadow
        // default-release-rules.js:24, {tag:'Breaking', release:'major'}, which
        // keys on `commit.tag` — a field no custom rule mentions, and one
        // conventional-commits-parser fills from an ordinary body via
        // `fieldPattern: /^-(.*?)-$/`. Measured against the config alone, this
        // commit returned `major` and took 3.1.3 to 4.0.0.
        //
        // The wrapper's demotion is what closes it, which is why the invariant
        // lives there rather than in the rule table.
        const sneaky = 'chore: tidy up\n\n-tag-\nBreaking';
        expect(releaseTypeFor([sneaky], '3.1.3')).toBe('minor');
        expect(releaseTypeFor(['docs: note\n\n-tag-\nBreaking'], '3.1.3')).toBe('minor');
        // ...and it must not cost the odometer its own promotion.
        expect(releaseTypeFor([sneaky], '3.999.4')).toBe('major');
    });

    it('demotes BEFORE capping, so the guard cannot defeat the odometer', () => {
        // Order is load-bearing. capMinor passes an existing `major` straight
        // through, so demoting AFTER it would undo the odometer's own promotion
        // — and semver.inc('3.999.4', 'minor') is '3.1000.0', a four-digit minor.
        // This asserts the observable consequence: at the boundary the result is
        // `major`, which is only reachable if the demotion ran first.
        expect(releaseTypeFor(['feat: add a thing'], '3.999.4')).toBe('major');
        expect(releaseTypeFor(['chore: tidy\n\n-tag-\nBreaking'], '3.999.4')).toBe('major');
    });

    it('keeps the breaking rule PRESENT — deleting it is not the same as setting it', () => {
        // commit-analyzer consults its own DEFAULT rules whenever no custom rule
        // matches (index.js:57-66), and default rule 0 is
        // {breaking: true, release: 'major'}. So an absent rule does not mean
        // "breaking is unremarkable" — it means the default decides, and the
        // default disagrees. Measured, with the rule removed: `chore!` → major,
        // `feat!` → minor, `fix!` → patch. Three answers, none of them wanted.
        const releaserc = JSON.parse(readFileSync(path.join(ROOT, '.releaserc.json'), 'utf8'));
        const rules = releaserc.plugins[0][1].releaseRules;
        const breaking = rules.filter((r: { breaking?: boolean }) => r.breaking === true);
        expect(breaking).toHaveLength(1);
        expect(breaking[0].release).toBe('minor');
    });
});

describe('semrel-minor-cap plugin wiring', () => {
    it('loads and exports an analyzeCommits function (commit-analyzer import resolves)', () => {
        const res = spawnSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `const m = await import(process.env.MOD); process.stdout.write(typeof m.analyzeCommits);`,
            ],
            { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MOD: PLUGIN_MOD } },
        );
        if (res.status !== 0) {
            throw new Error(`plugin import failed:\n${res.stderr}`);
        }
        expect(res.stdout).toBe('function');
    });
});
