/**
 * CI Guardrails for file security:
 * 1. No code writes uploads into /public
 * 2. No API returns absolute filesystem paths
 * 3. Download endpoints accept fileId/evidenceId (not pathKey)
 * 4. FILE_STORAGE_ROOT is validated
 */
import fs from 'fs';
import path from 'path';

const SRC_ROOT = path.resolve('src');

function readFilesRecursive(dir: string): { path: string; content: string }[] {
    const results: { path: string; content: string }[] = [];
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
            if (item.name === 'node_modules' || item.name === '.next') continue;
            results.push(...readFilesRecursive(fullPath));
        } else if (/\.(ts|tsx|js|jsx)$/.test(item.name)) {
            results.push({ path: fullPath, content: fs.readFileSync(fullPath, 'utf-8') });
        }
    }
    return results;
}

describe('File Security Guardrails', () => {
    const allFiles = readFilesRecursive(SRC_ROOT);

    test('no upload code writes into /public directory', () => {
        const violations: string[] = [];
        for (const file of allFiles) {
            // Match patterns like writeFile('public/...' or path.join('public', ...)
            if (/(?:writeFile|createWriteStream|mkdir)\s*\([^)]*['"]public\//i.test(file.content)) {
                violations.push(file.path);
            }
            if (/path\.join\s*\([^)]*['"]public['"][^)]*upload/i.test(file.content)) {
                violations.push(file.path);
            }
        }
        expect(violations).toEqual([]);
    });

    test('no API route returns absolute filesystem paths in responses', () => {
        const apiRoutes = allFiles.filter(f => f.path.includes(`api${path.sep}`) && f.path.endsWith('route.ts'));
        const violations: string[] = [];
        for (const file of apiRoutes) {
            // Check for pathKey, finalPath, absPath, or filePath being returned in JSON responses
            if (/NextResponse\.json\([^)]*(?:finalPath|absPath|filePath|pathKey)/i.test(file.content)) {
                // Exception: pathKey is OK in internal form (it's relative), but finalPath/absPath are not
                if (/NextResponse\.json\([^)]*(?:finalPath|absPath|filePath)/i.test(file.content)) {
                    violations.push(file.path);
                }
            }
            // Check for fs.resolve appearing in response bodies
            if (/NextResponse\.json\([^)]*path\.resolve/i.test(file.content)) {
                violations.push(file.path);
            }
        }
        expect(violations).toEqual([]);
    });

    test('download endpoints use fileId not pathKey as URL parameter', () => {
        const downloadRoutes = allFiles.filter(
            f => f.path.includes('download') && f.path.includes('route.ts'),
        );
        const violations: string[] = [];
        for (const file of downloadRoutes) {
            // Check URL params: should use fileId, evidenceId, etc. — not pathKey
            if (/params\.pathKey/i.test(file.content) || /searchParams.*pathKey/i.test(file.content)) {
                violations.push(`${file.path}: accepts pathKey directly`);
            }
            // Should reference fileId or similar identifier, not raw path
            if (/req\.nextUrl\.searchParams\.get\(['"]path/i.test(file.content)) {
                violations.push(`${file.path}: accepts path parameter`);
            }
        }
        expect(violations).toEqual([]);
    });

    // ── WHY THESE TWO LOOKUPS ARE ANCHORED TO AN EXACT PATH ─────────────────
    //
    // They used to be `endsWith('env.ts')` and `endsWith('storage.ts')` with a
    // `.find`, which returns the FIRST match in `readdirSync` order — so each
    // silently graded whichever file happened to sort first, not the one it
    // names. Both were already ambiguous:
    //
    //   • `endsWith('env.ts')` also matches
    //     `src/app-layer/integrations/collector-child-env.ts`, which sorts
    //     BEFORE `src/env.ts`. So the env assertion ran against that file and
    //     failed on a correct tree — that is what surfaced this.
    //   • `endsWith('storage.ts')` also matches `src/lib/ui-storage.ts`, which
    //     exists today and sorts AFTER `src/lib/storage.ts`. That one grades
    //     the right file purely by alphabetical luck, and a rename on either
    //     side would move it onto the wrong file with no test going red.
    //
    // A `.find` whose predicate can match two files is a guard that grades the
    // wrong thing, so both now name the file they mean.
    const fileAt = (...rel: string[]) => {
        const want = path.join(SRC_ROOT, ...rel);
        return allFiles.find(f => f.path === want);
    };

    test('FILE_STORAGE_ROOT is validated via env.ts', () => {
        const envFile = fileAt('env.ts');
        expect(envFile).toBeDefined();
        // Should reference FILE_STORAGE_ROOT or UPLOAD_DIR
        expect(envFile!.content).toMatch(/UPLOAD_DIR|FILE_STORAGE_ROOT/);
    });

    test('storage driver does not use raw process.env in src/', () => {
        const storageFile = fileAt('lib', 'storage.ts');
        expect(storageFile).toBeDefined();
        // Should NOT contain process.env for storage config (should use @/env)
        const lines = storageFile!.content.split('\n');
        const violations: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('process.env.FILE_') || lines[i].includes('process.env.UPLOAD_DIR')) {
                violations.push(`Line ${i + 1}: ${lines[i].trim()}`);
            }
        }
        expect(violations).toEqual([]);
    });

    test('file uploads go through mulitpart endpoints, not direct DB writes', () => {
        // Verify that Evidence create with type=FILE goes through uploadEvidenceFile
        // No route should create FILE evidence via plain JSON POST
        const evidenceRoutes = allFiles.filter(
            f => f.path.includes(`evidence${path.sep}`) && f.path.endsWith('route.ts') && !f.path.includes('uploads'),
        );
        const violations: string[] = [];
        for (const file of evidenceRoutes) {
            // Check if any route creates evidence of type FILE without going through upload
            if (/type.*['"]FILE['"].*createEvidence/i.test(file.content)) {
                violations.push(`${file.path}: creates FILE evidence without upload flow`);
            }
        }
        expect(violations).toEqual([]);
    });
});
