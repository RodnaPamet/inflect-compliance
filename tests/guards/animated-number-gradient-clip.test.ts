/**
 * An ANIMATED `<AnimatedNumber>` must never sit inside a
 * `bg-clip-text` gradient wrapper.
 *
 * `<AnimatedNumber animate>` (the default) mounts `@number-flow/react`,
 * which renders the `<number-flow>` CUSTOM ELEMENT. Its shadow root sets
 * `isolation: isolate` on `:host`, and its symbol spans additionally
 * carry `mix-blend-mode: plus-lighter`. Both make the subtree its own
 * paint group — so an ancestor's `background-clip: text` background is
 * never painted into it. The glyphs keep the `text-transparent`
 * colour they inherited and the number renders INVISIBLE in Chrome.
 *
 * This shipped: the dashboard's CONTROLS KPI tile wrapped the animated
 * value in `bg-gradient-to-r … bg-clip-text text-transparent`. A healthy
 * 11.2% control-coverage figure (14 of 125 implemented, verified against
 * the production database) reached users as bare punctuation — the digit
 * stacks were transparent, only the separators survived.
 *
 * The fix is `animate={false}`: the static branch renders ordinary text
 * in an ordinary `<span>`, which `bg-clip-text` clips correctly. Nothing
 * observable is lost, because an animation of invisible digits was never
 * observable.
 *
 * Where you WANT the roll animation, give the number a solid token
 * colour instead of a clipped gradient (`<HeroMetric>` does exactly
 * this, which is why the masthead was never affected).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = path.join(ROOT, 'src');

const EXEMPT_DIR_NAMES = new Set<string>(['node_modules', '__tests__', '__mocks__']);

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (EXEMPT_DIR_NAMES.has(entry.name)) continue;
            out.push(...walk(full));
            continue;
        }
        if (!/\.tsx$/.test(entry.name)) continue;
        if (/\.(test|spec|stories)\.tsx$/.test(entry.name)) continue;
        out.push(full);
    }
    return out;
}

/**
 * Given the index of a `bg-clip-text` occurrence, return the source
 * range of the JSX element that carries it — from the end of its opening
 * tag to the start of its closing tag. Returns null for a self-closing
 * element (nothing can be nested inside it).
 */
function clippedElementBody(
    source: string,
    clipIndex: number,
): { start: number; end: number } | null {
    // Nearest `<Tag` at or before the className.
    const openTagRe = /<([A-Za-z][A-Za-z0-9.]*)/g;
    let tagStart = -1;
    let tagName = '';
    let m: RegExpExecArray | null;
    while ((m = openTagRe.exec(source)) !== null) {
        if (m.index > clipIndex) break;
        tagStart = m.index;
        tagName = m[1]!;
    }
    if (tagStart < 0) return null;

    // End of the opening tag: first `>` at brace-depth 0 after the name.
    let depth = 0;
    let i = tagStart + 1 + tagName.length;
    for (; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === '>' && depth === 0) break;
    }
    if (i >= source.length) return null;
    if (source[i - 1] === '/') return null; // self-closing

    const bodyStart = i + 1;

    // Matching close tag, counting same-named nested opens.
    let nesting = 1;
    const tagRe = new RegExp(`<(/?)${tagName.replace('.', '\\.')}[\\s/>]`, 'g');
    tagRe.lastIndex = bodyStart;
    while ((m = tagRe.exec(source)) !== null) {
        if (m[1] === '/') {
            nesting--;
            if (nesting === 0) return { start: bodyStart, end: m.index };
        } else if (!source.slice(m.index, tagRe.lastIndex).includes('/>')) {
            nesting++;
        }
    }
    return null;
}

/** Attribute text of each `<AnimatedNumber …>` in `region`. */
function animatedNumberAttrs(region: string): string[] {
    const out: string[] = [];
    const re = /<AnimatedNumber\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(region)) !== null) {
        let depth = 0;
        let i = m.index + m[0].length;
        for (; i < region.length; i++) {
            const ch = region[i];
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            else if (ch === '>' && depth === 0) break;
        }
        out.push(region.slice(m.index, i));
    }
    return out;
}

const ANIMATE_DISABLED_RE = /animate\s*=\s*\{\s*false\s*\}/;

interface Violation {
    file: string;
    line: number;
}

function scanSource(source: string): number[] {
    const bad: number[] = [];
    let from = 0;
    for (;;) {
        const clipIndex = source.indexOf('bg-clip-text', from);
        if (clipIndex < 0) break;
        from = clipIndex + 1;
        const body = clippedElementBody(source, clipIndex);
        if (!body) continue;
        const region = source.slice(body.start, body.end);
        for (const attrs of animatedNumberAttrs(region)) {
            if (!ANIMATE_DISABLED_RE.test(attrs)) bad.push(clipIndex);
        }
    }
    return bad;
}

describe('AnimatedNumber is never animated inside a bg-clip-text gradient', () => {
    const files = walk(SCAN_DIR);
    const candidates = files.filter((f) => {
        const s = fs.readFileSync(f, 'utf8');
        return s.includes('bg-clip-text') && s.includes('AnimatedNumber');
    });

    it('scans real files (scan is not vacuous)', () => {
        expect(files.length).toBeGreaterThan(200);
        // KpiCard is the canonical clipped-gradient metric surface. If it
        // ever stops matching, the scan below has lost its subject and the
        // ratchet would pass on nothing.
        expect(
            candidates.map((f) => path.relative(ROOT, f)),
        ).toContain('src/components/ui/KpiCard.tsx');
    });

    it('has no animated AnimatedNumber under a clipped gradient', () => {
        const violations: Violation[] = [];
        for (const file of candidates) {
            const source = fs.readFileSync(file, 'utf8');
            for (const idx of scanSource(source)) {
                violations.push({
                    file: path.relative(ROOT, file),
                    line: source.slice(0, idx).split('\n').length,
                });
            }
        }
        const message = violations
            .map(
                (v) =>
                    `  ${v.file}:${v.line} — an <AnimatedNumber> without ` +
                    `animate={false} sits inside a bg-clip-text wrapper.\n` +
                    `      The number-flow custom element's shadow root is an ` +
                    `isolated paint group, so the clipped gradient never reaches ` +
                    `its glyphs and the value renders invisible.`,
            )
            .join('\n');
        expect(violations.length === 0 ? '' : `\n${message}\n`).toBe('');
    });

    it('flags an animated number under a clipped gradient (detector proof)', () => {
        const bad = `
            <span className="bg-gradient-to-r from-a to-b bg-clip-text text-transparent">
                <AnimatedNumber value={v} format={f} />
            </span>
        `;
        expect(scanSource(bad)).toHaveLength(1);

        const fixed = bad.replace('format={f} />', 'format={f} animate={false} />');
        expect(scanSource(fixed)).toHaveLength(0);

        // An animated number OUTSIDE the clipped element is fine — this is
        // the KpiCard trend-magnitude case, which uses a solid token colour.
        const sibling = `
            <span className="bg-gradient-to-r from-a to-b bg-clip-text text-transparent">
                <AnimatedNumber value={v} animate={false} />
            </span>
            <span className="text-content-success">
                <AnimatedNumber value={delta} />
            </span>
        `;
        expect(scanSource(sibling)).toHaveLength(0);
    });
});
