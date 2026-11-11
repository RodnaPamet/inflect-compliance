/**
 * `local/vector-store-single-seam` — RuleTester, plus the repo config's wiring.
 *
 * The valid cases are the load-bearing half: the repository's own path, a
 * directory that merely shares the prefix (`vectors/`, `vector-search/`), a
 * relative import that does NOT resolve into the backends, and a comment
 * naming the table. An invalid-only suite would pass against a rule that
 * flags every import.
 *
 * The last case lints planted files with `eslint.config.mjs` itself, in a
 * child process (Jest cannot load the ESM config), so a config edit that
 * drops the rule or widens the exemption fails here, not only the rule.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';
import { RuleTester } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';

const rule = require('../rules/vector-store-single-seam');

const ROOT = path.resolve(__dirname, '../..');
const USECASE = path.join(ROOT, 'src/app-layer/usecases/knowledge-search.ts');
const REPO_DIR_FILE = path.join(ROOT, 'src/app-layer/repositories/SomethingRepository.ts');

const ruleTester = new RuleTester({
    languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
});

describe('local/vector-store-single-seam', () => {
    ruleTester.run('vector-store-single-seam', rule, {
        valid: [
            {
                name: 'the repository seam itself, by alias',
                filename: USECASE,
                code: `import { getVectorRepository } from '@/app-layer/repositories/VectorRepository';`,
            },
            {
                name: 'a directory that only shares the prefix',
                filename: USECASE,
                code: `import { x } from '@/app-layer/repositories/vectors/thing';\nimport { y } from '@/app-layer/repositories/vector-search';`,
            },
            {
                name: 'a relative import that resolves outside the backends',
                filename: REPO_DIR_FILE,
                code: `import { getVectorRepository } from './VectorRepository';`,
            },
            {
                name: 'a comment naming the table is prose, not a query',
                filename: USECASE,
                code: `// KnowledgeVector rows are reached through the repository.\nexport const a = 1;`,
            },
        ],
        invalid: [
            {
                name: 'a backend by alias',
                filename: USECASE,
                code: `import { createPgvectorStore } from '@/app-layer/repositories/vector/pgvector-store';`,
                errors: [{ messageId: 'backendLoad' }],
            },
            {
                name: 'a type-only import of the backend contract',
                filename: USECASE,
                code: `import type { VectorStoreBackend } from '@/app-layer/repositories/vector/types';`,
                errors: [{ messageId: 'backendLoad' }],
            },
            {
                name: 'a backend by a relative path from the repositories directory',
                filename: REPO_DIR_FILE,
                code: `import { createInProcessVectorStore } from './vector/in-process-store';`,
                errors: [{ messageId: 'backendLoad' }],
            },
            {
                name: 'a re-export of a backend',
                filename: USECASE,
                code: `export * from '@/app-layer/repositories/vector/pgvector-store';`,
                errors: [{ messageId: 'backendLoad' }],
            },
            {
                name: 'a dynamic import and a require',
                filename: USECASE,
                code: `const a = import('@/app-layer/repositories/vector/pgvector-store');\nconst b = require('@/app-layer/repositories/vector');`,
                errors: [{ messageId: 'backendLoad' }, { messageId: 'backendLoad' }],
            },
            {
                name: 'a raw query naming the table, in a string and in a template',
                filename: USECASE,
                code: `const q = 'SELECT 1 FROM "KnowledgeVector"';\nconst r = \`DELETE FROM "KnowledgeVector" WHERE x = \${1}\`;`,
                errors: [{ messageId: 'tableName' }, { messageId: 'tableName' }],
            },
        ],
    });

    it('is applied by the repo config everywhere under src/ except the seam and its backends', () => {
        const planted = `import { createPgvectorStore } from '@/app-layer/repositories/vector/pgvector-store';\nexport const s = createPgvectorStore;\n`;
        const sites = [
            'src/app-layer/usecases/planted-vector-backdoor.ts',
            'src/lib/mcp/tools/planted-vector-backdoor.ts',
            'src/app-layer/jobs/planted-vector-backdoor.ts',
        ];
        const exempt = ['src/app-layer/repositories/VectorRepository.ts', 'src/app-layer/repositories/vector/other-backend.ts'];
        const script = `
            const { ESLint } = require('eslint');
            (async () => {
                const eslint = new ESLint({
                    cwd: ${JSON.stringify(ROOT)},
                    ruleFilter: ({ ruleId }) => ruleId === 'local/vector-store-single-seam',
                    overrideConfig: { languageOptions: { parserOptions: { projectService: false, project: null } } },
                });
                const out = [];
                for (const filePath of ${JSON.stringify([...sites, ...exempt])}) {
                    const [r] = await eslint.lintText(process.argv[1], { filePath });
                    out.push({ filePath, ruleIds: r.messages.map((m) => m.ruleId), fatal: r.messages.filter((m) => m.fatal).map((m) => m.message) });
                }
                process.stdout.write(JSON.stringify(out));
            })().catch((e) => { console.error(e); process.exit(1); });
        `;
        const raw = execFileSync(process.execPath, ['-e', script, planted], { cwd: ROOT, encoding: 'utf8' });
        const results: Array<{ filePath: string; ruleIds: string[]; fatal: string[] }> = JSON.parse(raw);
        for (const r of results) expect(r.fatal).toEqual([]);
        const flagged = (p: string) =>
            results.find((r) => r.filePath.endsWith(p))!.ruleIds.includes('local/vector-store-single-seam');
        for (const site of sites) expect([site, flagged(site)]).toEqual([site, true]);
        for (const site of exempt) expect([site, flagged(site)]).toEqual([site, false]);
    }, 120_000);
});
