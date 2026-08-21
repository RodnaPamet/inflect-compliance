/**
 * Guardrail: HIBP coverage — password-handling routes.
 *
 * Invariant: every API route that ingests a user-chosen password MUST
 * import AND call `checkPasswordAgainstHIBP` from
 * `@/lib/security/password-check`. Skipping the call would allow a
 * breached password to be accepted by the API, defeating Epic A.3's
 * breach-screening protection.
 *
 * Failure mode: the test prints the exact file and password field that
 * slipped through, so the contributor knows exactly where to wire the
 * call in.
 *
 * How to extend: when a new password-accepting route ships (password
 * change, reset, recovery, admin-set, …):
 *   1. Import `checkPasswordAgainstHIBP` from
 *      `@/lib/security/password-check` in that route file.
 *   2. Await the call before persisting the password hash.
 *   3. Add an entry to `HIBP_REQUIRED_ROUTES` below with the file path
 *      and the Zod field name so failures are self-documenting.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

const HIBP_REQUIRED_ROUTES: ReadonlyArray<{
    /** Path relative to repo root. */
    file: string;
    /** Which password field this route accepts (for self-documenting failures). */
    field: string;
}> = [
    {
        file: 'src/app/api/auth/register/route.ts',
        field: 'password',
    },
    {
        file: 'src/app/api/auth/change-password/route.ts',
        field: 'newPassword',
    },
    {
        file: 'src/app/api/auth/reset-password/route.ts',
        field: 'newPassword',
    },
    // Future password-change / reset / recovery routes add themselves here.
];

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Import-presence regex.
 * Matches a static ES import of `checkPasswordAgainstHIBP` from the
 * canonical module path. A comment that merely mentions the name does NOT
 * match because it won't start with optional-whitespace + `import`.
 */
const IMPORT_RE =
    /^\s*import\s+\{[^}]*\bcheckPasswordAgainstHIBP\b[^}]*\}\s+from\s+['"]@\/lib\/security\/password-check['"]/m;

/**
 * Call-site regex.
 * Matches `checkPasswordAgainstHIBP(` anywhere in the file (after the
 * import line has been stripped), confirming the function is actually
 * invoked rather than dead-imported.
 */
const CALL_RE = /\bcheckPasswordAgainstHIBP\s*\(/;

/**
 * Password-field heuristic.
 * Detects Zod schema fields whose name looks like a password input.
 * Captures the field name for diagnostic messages.
 */
const PASSWORD_FIELD_RE =
    /\b(password|newPassword|currentPassword|confirmPassword)\s*:\s*z\./g;

/**
 * Shared-schema modules. The password-field heuristic above only sees
 * a Zod field DECLARED in the file it is scanning, so a route whose
 * body schema lives in one of these modules is invisible to it —
 * which is not hypothetical: `api/auth/register/route.ts`, the
 * flagship password route, parses `AuthActionSchema` from
 * `@/lib/schemas` and matches PASSWORD_FIELD_RE zero times. It is
 * covered only because a human put it on the curated list above.
 *
 * So the scan resolves one more hop: find the exported schemas in
 * these modules that carry a password-shaped field (transitively —
 * `AuthActionSchema` gets it from `AuthRegisterSchema.extend(...)`),
 * then treat a route that imports one of those names exactly like a
 * route that declares the field inline.
 */
const SHARED_SCHEMA_DIRS = ['src/lib/schemas', 'src/app-layer/schemas'];

function walkTsFiles(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkTsFiles(full));
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Exported schema names in the shared modules that (transitively)
 * carry a password-shaped field.
 *
 * Declaration bodies are sliced `export const X =` → next `export `,
 * which is coarse but safe in the direction that matters: over-wide
 * slices can only ADD names to the set, and a name in the set only
 * ever demands that an importing route be registered.
 */
function passwordBearingSharedSchemas(
    fileSources: readonly string[],
): Set<string> {
    const bodies = new Map<string, string>();
    for (const src of fileSources) {
        const decl = /export\s+const\s+(\w+)\s*[:=]/g;
        const starts: Array<{ name: string; at: number }> = [];
        for (const m of src.matchAll(decl)) {
            starts.push({ name: m[1], at: m.index ?? 0 });
        }
        for (let i = 0; i < starts.length; i++) {
            const end = i + 1 < starts.length ? starts[i + 1].at : src.length;
            bodies.set(starts[i].name, src.slice(starts[i].at, end));
        }
    }

    const bearing = new Set<string>();
    for (const [name, body] of bodies) {
        // Fresh regex per test — PASSWORD_FIELD_RE is /g and stateful.
        if (new RegExp(PASSWORD_FIELD_RE.source).test(body)) bearing.add(name);
    }

    // Fixpoint: a schema that references a bearing schema inherits it
    // (`.extend`, `.merge`, union members, `z.object({ inner: X })`).
    let grew = true;
    while (grew) {
        grew = false;
        for (const [name, body] of bodies) {
            if (bearing.has(name)) continue;
            for (const ref of bearing) {
                if (ref !== name && new RegExp(`\\b${ref}\\b`).test(body)) {
                    bearing.add(name);
                    grew = true;
                    break;
                }
            }
        }
    }
    return bearing;
}

/** Schema names a route file imports from a shared-schema module. */
function importedSchemaNames(routeSrc: string): Set<string> {
    const names = new Set<string>();
    const importRe =
        /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]@\/(?:lib|app-layer)\/schemas[^'"]*['"]/g;
    for (const m of routeSrc.matchAll(importRe)) {
        for (const raw of m[1].split(',')) {
            const name = raw.trim().split(/\s+as\s+/)[0].trim();
            if (name) names.add(name);
        }
    }
    return names;
}

function walkRouteFiles(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walkRouteFiles(full));
        } else if (entry.name === 'route.ts' || entry.name === 'route.tsx') {
            out.push(full);
        }
    }
    return out;
}

function hasImport(src: string): boolean {
    return IMPORT_RE.test(src);
}

function hasCall(src: string): boolean {
    // Strip the import line first so the import itself doesn't count as a call.
    const importMatch = src.match(IMPORT_RE);
    const stripped = importMatch ? src.replace(importMatch[0], '') : src;
    return CALL_RE.test(stripped);
}

// ── Test 1 — curated list integrity ───────────────────────────────────────

describe('HIBP coverage guardrail — curated list integrity', () => {
    it('HIBP_REQUIRED_ROUTES is non-empty (sanity)', () => {
        expect(HIBP_REQUIRED_ROUTES.length).toBeGreaterThan(0);
    });

    test.each(HIBP_REQUIRED_ROUTES.map((r) => [r.file, r] as const))(
        '%s exists, imports, and calls checkPasswordAgainstHIBP',
        (relPath, entry) => {
            const abs = path.join(REPO_ROOT, relPath);
            expect(fs.existsSync(abs)).toBe(true);

            const src = fs.readFileSync(abs, 'utf8');

            if (!hasImport(src)) {
                throw new Error(
                    [
                        `Route missing checkPasswordAgainstHIBP import.`,
                        ``,
                        `  File:  ${relPath}`,
                        `  Field: ${entry.field}`,
                        `  Add:   import { checkPasswordAgainstHIBP } from '@/lib/security/password-check';`,
                    ].join('\n'),
                );
            }

            if (!hasCall(src)) {
                throw new Error(
                    [
                        `Route imports checkPasswordAgainstHIBP but never calls it.`,
                        ``,
                        `  File:  ${relPath}`,
                        `  Field: ${entry.field}`,
                        ``,
                        `A dangling import is a silent bypass. Await the call before`,
                        `hashing the password, then re-run this test.`,
                    ].join('\n'),
                );
            }
        },
    );
});

// ── Test 2 — structural scan ───────────────────────────────────────────────

describe('HIBP coverage guardrail — structural scan', () => {
    const sharedSources = SHARED_SCHEMA_DIRS.flatMap((d) =>
        walkTsFiles(path.join(REPO_ROOT, d)).map((f) => fs.readFileSync(f, 'utf8')),
    );
    const bearingSchemas = passwordBearingSharedSchemas(sharedSources);

    it('finds password-bearing schemas in the shared modules (sanity)', () => {
        // Without this the widened scan below could pass by finding
        // nothing at all — which is exactly the shape of failure it
        // exists to close.
        expect(sharedSources.length).toBeGreaterThan(0);
        expect(bearingSchemas.size).toBeGreaterThan(0);
        expect(bearingSchemas.has('AuthRegisterSchema')).toBe(true);
        // Transitive: AuthActionSchema is a union over AuthRegisterSchema.
        expect(bearingSchemas.has('AuthActionSchema')).toBe(true);
    });

    it('every route.ts that parses a password field is registered', () => {
        const apiDir = path.join(REPO_ROOT, 'src/app/api');
        const allRoutes = walkRouteFiles(apiDir);

        // POSITIVE CONTROL for the walker itself, and the audit that produced
        // this file is the reason it is here. The sibling block above guards
        // the shared-schema half the same way; this half had no such guard, so
        // if `src/app/api` ever moves or `walkRouteFiles` breaks, the loop
        // below would iterate ZERO routes, find zero violations, and pass —
        // reporting full coverage of an empty set. That is precisely the
        // failure this guard was widened to close, left standing inside the
        // widening. A "nothing found" needs something proving the finder ran.
        expect(allRoutes.length).toBeGreaterThan(400);
        const registeredFiles = new Set(
            HIBP_REQUIRED_ROUTES.map((r) => path.join(REPO_ROOT, r.file)),
        );

        const violations: string[] = [];

        for (const absFile of allRoutes) {
            const src = fs.readFileSync(absFile, 'utf8');
            const inline = [...src.matchAll(PASSWORD_FIELD_RE)].map((m) => m[1]);
            const viaImport = [...importedSchemaNames(src)].filter((n) =>
                bearingSchemas.has(n),
            );
            if (inline.length === 0 && viaImport.length === 0) continue;

            if (!registeredFiles.has(absFile)) {
                const how =
                    inline.length > 0
                        ? `parses a password field \`${[...new Set(inline)].join(', ')}\``
                        : `parses a password-bearing shared schema \`${viaImport.join(', ')}\``;
                const rel = path.relative(REPO_ROOT, absFile);
                violations.push(
                    `Route \`${rel}\` ${how} but is not` +
                        ` registered in HIBP_REQUIRED_ROUTES. Add an entry so the HIBP check is` +
                        ` enforced on this route, or document why it's exempt.`,
                );
            }
        }

        if (violations.length > 0) {
            throw new Error(violations.join('\n\n'));
        }
    });
});

// ── Test 3 — regression proof ──────────────────────────────────────────────

describe('HIBP coverage guardrail — regression proof', () => {
    it('guardrail catches a mutated register/route.ts that lacks the HIBP import/call', () => {
        const entry = HIBP_REQUIRED_ROUTES.find(
            (r) => r.file === 'src/app/api/auth/register/route.ts',
        );
        expect(entry).toBeDefined();

        const abs = path.join(REPO_ROOT, entry!.file);
        const realSrc = fs.readFileSync(abs, 'utf8');

        // Strip the import line and any call site — simulate a PR that forgot both.
        const importMatch = realSrc.match(IMPORT_RE);
        const mutated = importMatch
            ? realSrc.replace(importMatch[0], '').replace(CALL_RE, '/* hibp-removed */')
            : realSrc.replace(CALL_RE, '/* hibp-removed */');

        // The helpers MUST flag the mutated copy.
        expect(hasImport(mutated)).toBe(false);
        expect(hasCall(mutated)).toBe(false);

        // And confirm the real file still passes (self-check).
        expect(hasImport(realSrc)).toBe(true);
        expect(hasCall(realSrc)).toBe(true);
    });
});
