/**
 * `HostAllowlist.allowInsecure` / `.allowPort` must never be set in `src/`.
 *
 * ═══ WHY THIS TEST IS THE PRICE OF THOSE TWO FIELDS ═══
 *
 * The fields exist so a stress harness can drive the REAL request stack at a
 * local fake — `http://127.0.0.1:<random>` — without injecting `fetchImpl` and
 * thereby asserting against a mock of the code under test.
 *
 * The obvious alternative was a `deps.baseUrl` that skips `oktaBaseUrl`
 * entirely. It was rejected for one reason: a bypass in a security boundary
 * erodes, and an ABSENT call is invisible. Nothing fails when someone adds a
 * second caller.
 *
 * These flags were chosen instead precisely because the erosion is
 * DETECTABLE — which is only true while this test exists. Delete it and the
 * design argument for the flags collapses, so they should be deleted too.
 *
 * Two layers, because each misses what the other catches:
 *
 *   RUNTIME  — every HostAllowlist actually exported from allowed-host.ts,
 *              including ones added after this test was written. Catches a
 *              flag set on a real production allowlist.
 *   TEXTUAL  — the whole `src/` tree, catching an allowlist defined somewhere
 *              other than allowed-host.ts, or a flag set dynamically.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as allowedHost from '@/app-layer/integrations/allowed-host';
import type { HostAllowlist } from '@/app-layer/integrations/allowed-host';

const SRC = path.resolve(__dirname, '../../src');

/** The interface declaration itself, which necessarily names the fields. */
const DECLARATION_FILE = path.join(SRC, 'app-layer/integrations/allowed-host.ts');

function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
}

function isAllowlist(v: unknown): v is HostAllowlist {
    if (typeof v !== 'object' || v === null) return false;
    const o = v as Record<string, unknown>;
    return typeof o.label === 'string' && Array.isArray(o.suffixes) && Array.isArray(o.exact);
}

describe('no production allowlist carries a test-only relaxation', () => {
    it('exports at least one allowlist — otherwise the runtime layer proves nothing', () => {
        // A rename or a barrel change could leave the loop below iterating an
        // empty set, which passes while checking nothing.
        const found = Object.values(allowedHost).filter(isAllowlist);
        expect(found.length).toBeGreaterThanOrEqual(3);
    });

    it.each(
        Object.entries(allowedHost)
            .filter(([, v]) => isAllowlist(v))
            .map(([name, v]) => [name, v as HostAllowlist] as const),
    )('%s sets neither allowInsecure nor allowPort', (_name, list) => {
        expect(list.allowInsecure).toBeFalsy();
        expect(list.allowPort).toBeFalsy();
    });
});

describe('and nothing in src/ sets one anywhere else', () => {
    it('no file outside the interface declaration mentions the flags', () => {
        const offenders: string[] = [];
        for (const file of walk(SRC)) {
            if (path.resolve(file) === path.resolve(DECLARATION_FILE)) continue;
            const src = fs.readFileSync(file, 'utf8');
            if (/\ballow(Insecure|Port)\b/.test(src)) {
                offenders.push(path.relative(SRC, file));
            }
        }
        expect(offenders).toEqual([]);
    });

    it('the declaration file names them ONLY in the interface, never on a value', () => {
        // Guards the carve-out above: allowed-host.ts is skipped by the scan,
        // so without this it would be the one place a flag could be set.
        const src = fs.readFileSync(DECLARATION_FILE, 'utf8');
        // `allowInsecure?: boolean` (declaration) is fine.
        // `allowInsecure: true` (assignment) is not.
        expect(src).not.toMatch(/\ballow(Insecure|Port)\s*:\s*(true|false|[A-Za-z_$])/);
    });
});
