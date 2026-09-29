/**
 * Every `@tiptap/core` in the tree resists GHSA-cp6q-959q-f8rh.
 *
 * ═══ WHY THIS GUARD EXISTS ═══
 *
 * `security/audit-allowlist.json` exempts GHSA-cp6q-959q-f8rh. That exemption
 * is legitimate for exactly one reason — the advisory's affected range is
 * `>=2.0.0-alpha.0 <3.30.4`, and tiptap BACKPORTED the fix to the 2.x line in
 * **2.27.3** (published 2026-09-04, nine days AFTER 3.30.4 landed on
 * 2026-08-26). The advisory range was never amended to record it, so `npm
 * audit` reports a version that is, in fact, patched.
 *
 * That reasoning is only safe while the resolved version actually carries the
 * fix. `tldraw@3.x` declares `@tiptap/* ^2.9.1`, which admits 2.9.1 through
 * 2.27.x — and every 2.x BELOW 2.27.3 is genuinely vulnerable. So a lockfile
 * change, a dedupe, or a fresh resolve could quietly drop the tree onto a
 * version the allowlist then waves through. The exemption would be covering a
 * real hole rather than a stale advisory, and nothing else would notice:
 * `npm audit` reports the same advisory either way, and the gate would keep
 * passing because the entry matches.
 *
 * **The allowlist entry answers "is this advisory stale?". This answers "is
 * the code actually fixed?". Those are different questions and only the
 * second one is about our users.**
 *
 * ═══ WHY IT EXECUTES RATHER THAN GREPS ═══
 *
 * A grep for `__proto__` passes on a file that merely mentions it — including
 * one where the guard was refactored into something that no longer works. This
 * runs the published advisory's own attack shape through the real
 * `mergeAttributes` and checks the prototype afterwards, which is the property
 * the advisory is about.
 *
 * ═══ WHEN THIS GOES RED ═══
 *
 * A `@tiptap/core` below 2.27.3 has entered the tree. Do not weaken this file.
 * Either raise the resolved version (an `overrides` entry pinning
 * `@tiptap/core` to `^2.27.3` under tldraw is the smallest fix), or remove the
 * allowlist exemption and let the audit gate block the merge — which is the
 * correct outcome if the code really is vulnerable.
 *
 * @see security/audit-allowlist.json — the exemption this protects.
 * @see docs/dependency-risk-review.md — the verdict and its evidence.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/**
 * The packages that can each resolve their OWN `@tiptap/core`. Names, not
 * paths — `tests/guardrails/dependency-paths-are-resolved.test.ts` bans
 * spelling a filesystem route into an installed package, and it is right to:
 * a hand-built route encodes one hoisting outcome, while npm is free to nest
 * or dedupe differently on the next install.
 *
 * Asking Node's resolver instead is also the STRONGER question. A directory
 * walk finds copies that exist on disk; this finds the copy each consumer
 * would actually load, which is the one whose behaviour matters.
 */
const TIPTAP_CONSUMERS = ['tldraw', '@tldraw/editor'] as const;

/** The nearest `package.json` at or above a resolved entry point. */
function versionOf(entry: string): string {
    let dir = path.dirname(entry);
    for (let i = 0; i < 6; i++) {
        const pkg = path.join(dir, 'package.json');
        if (fs.existsSync(pkg)) {
            const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8')) as {
                name?: string;
                version?: string;
            };
            // Skip a nested dist/package.json that only carries `type`.
            if (parsed.name === '@tiptap/core' && parsed.version) return parsed.version;
        }
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return '(unknown)';
}

/**
 * Every `@tiptap/core` that something in this tree would actually load —
 * the root's own, plus whatever each consumer resolves for itself.
 */
function everyTiptapCore(): { version: string; entry: string; from: string }[] {
    const found: { version: string; entry: string; from: string }[] = [];
    const seen = new Set<string>();

    const add = (entry: string, from: string): void => {
        if (seen.has(entry)) return;
        seen.add(entry);
        found.push({ version: versionOf(entry), entry, from });
    };

    // The hoisted copy, as the repo's own source would load it.
    try {
        add(require.resolve('@tiptap/core'), '(root)');
    } catch {
        /* not installed at the root — the population assertion reports it */
    }

    // Each consumer's own copy, resolved FROM that consumer's directory so
    // Node applies the same nesting rules it would at runtime.
    for (const consumer of TIPTAP_CONSUMERS) {
        try {
            const consumerDir = path.dirname(require.resolve(consumer));
            add(require.resolve('@tiptap/core', { paths: [consumerDir] }), consumer);
        } catch {
            /* consumer absent, or resolves no tiptap of its own */
        }
    }

    return found;
}

/** Semver major.minor.patch compare, enough for the 2.27.3 floor. */
function below(version: string, floor: string): boolean {
    const a = version.split('-')[0].split('.').map(Number);
    const b = floor.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
    }
    return false;
}

const copies = everyTiptapCore();

describe('every @tiptap/core resists the mergeAttributes prototype attack', () => {
    it('the sweep reaches what tldraw resolves, not just the hoisted copy', () => {
        // The population control, and `length > 0` is NOT enough for it — the
        // root's hoisted @tiptap/core alone satisfies that while the copy
        // tldraw actually loads goes unchecked, and that copy is the only one
        // the allowlist entry is about.
        //
        // So the claim is specific: while tldraw is installed, its OWN
        // resolution must be among the copies swept. If tldraw ever stops
        // pulling a tiptap of its own, this fails and the exemption should be
        // re-examined rather than silently kept.
        expect(copies.length).toBeGreaterThan(0);

        let tldrawInstalled = true;
        try {
            require.resolve('tldraw');
        } catch {
            tldrawInstalled = false;
        }
        if (!tldrawInstalled) return;

        // Name the sources in the failure output — a bare count says nothing
        // about WHICH consumer went unchecked.
        expect(copies.map((c) => c.from)).toEqual(expect.arrayContaining(['tldraw']));
    });

    it('every resolved copy is at or above the 2.27.3 backport floor', () => {
        // The allowlist exemption rests on the resolved version carrying the
        // backport. Below 2.27.3 the advisory is REAL and the exemption is a
        // hole — this is the assertion that keeps those two cases apart.
        const stale = copies.filter((c) => below(c.version, '2.27.3'));
        expect(stale.map((c) => `${c.version} via ${c.from}`)).toEqual([]);
    });

    it.each(copies)('$version resolved from $from is not vulnerable', ({ entry }) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { mergeAttributes } = require(entry) as {
            mergeAttributes: (...objects: unknown[]) => Record<string, unknown>;
        };

        // The advisory's shape: an OWN `__proto__` key, which JSON.parse
        // produces and an object literal cannot.
        const payload = JSON.parse('{"__proto__":{"polluted":"yes"}}') as Record<string, unknown>;
        const merged = mergeAttributes({ class: 'x' }, payload);

        // 1. Object.prototype is untouched.
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        // 2. The key landed as an OWN property instead of walking the chain.
        expect(Object.prototype.hasOwnProperty.call(merged, '__proto__')).toBe(true);
        // 3. The merged object's own prototype is unchanged.
        expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    });

    it('the attack shape is real — a naive merge DOES pollute', () => {
        // The positive control, and the reason the three assertions above mean
        // something. Without it, a payload that could never pollute anything
        // would satisfy this file just as well.
        const naive: Record<string, unknown> = {};
        const payload = JSON.parse('{"__proto__":{"controlPollution":"boom"}}') as Record<string, unknown>;
        for (const [k, v] of Object.entries(payload)) naive[k] = v;

        const polluted =
            ({} as Record<string, unknown>).controlPollution === 'boom' ||
            Object.getPrototypeOf(naive) !== Object.prototype;
        expect(polluted).toBe(true);

        // Leave no residue for the assertions above, whichever way it went.
        delete (Object.prototype as Record<string, unknown>).controlPollution;
    });
});
