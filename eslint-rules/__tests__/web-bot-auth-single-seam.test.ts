/**
 * `local/web-bot-auth-single-seam` — RuleTester, plus the repo config's wiring.
 *
 * The valid cases are the load-bearing half: the seam's own module by alias,
 * a sibling that only shares the prefix (`sign-…`), a relative import that does
 * not resolve to the signer, and a comment naming the token. An invalid-only
 * suite would pass against a rule that flags every import.
 *
 * The last case lints planted files with `eslint.config.mjs` itself, in a
 * child process (Jest cannot load the ESM config), so a config edit that drops
 * the rule or widens the exemption fails here, not only the rule.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';
import { RuleTester } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';

const rule = require('../rules/web-bot-auth-single-seam');

const ROOT = path.resolve(__dirname, '../..');
const PROVIDER = path.join(ROOT, 'src/app-layer/services/vendor-monitoring/tls-provider.ts');
const WBA_SIBLING = path.join(ROOT, 'src/lib/web-bot-auth/directory.ts');

const ruleTester = new RuleTester({
    languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
});

describe('local/web-bot-auth-single-seam', () => {
    ruleTester.run('web-bot-auth-single-seam', rule, {
        valid: [
            {
                name: 'the seam itself, by alias',
                filename: PROVIDER,
                code: `import { botFetch } from '@/lib/web-bot-auth/bot-fetch';`,
            },
            {
                name: 'a module that only shares the prefix',
                filename: PROVIDER,
                code: `import { x } from '@/lib/web-bot-auth/sign-off';\nimport { y } from '@/lib/web-bot-auth/signature-agent-card';`,
            },
            {
                name: 'a relative import that resolves to another module',
                filename: WBA_SIBLING,
                code: `import { signMember } from './message-signature';`,
            },
            {
                name: 'a comment naming the token is prose, not a User-Agent',
                filename: PROVIDER,
                code: `// InflectCompliance-VendorMonitor is the bot's token.\nexport const a = 1;`,
            },
        ],
        invalid: [
            {
                name: 'the signer by alias',
                filename: PROVIDER,
                code: `import { signRequest } from '@/lib/web-bot-auth/sign';`,
                errors: [{ messageId: 'signerLoad' }],
            },
            {
                name: 'a type-only import of the signer',
                filename: PROVIDER,
                code: `import type { SignedRequest } from '@/lib/web-bot-auth/sign';`,
                errors: [{ messageId: 'signerLoad' }],
            },
            {
                name: 'the signer by a relative path from a sibling',
                filename: WBA_SIBLING,
                code: `import { signRequest } from './sign';`,
                errors: [{ messageId: 'signerLoad' }],
            },
            {
                name: 'a re-export, a dynamic import and a require',
                filename: PROVIDER,
                code: `export * from '@/lib/web-bot-auth/sign';\nconst a = import('@/lib/web-bot-auth/sign');\nconst b = require('@/lib/web-bot-auth/sign');`,
                errors: [{ messageId: 'signerLoad' }, { messageId: 'signerLoad' }, { messageId: 'signerLoad' }],
            },
            {
                name: 'the bot User-Agent written by hand, in a string and in a template',
                filename: PROVIDER,
                code: `const ua = 'InflectCompliance-VendorMonitor/1.0';\nconst ub = \`InflectCompliance-VendorMonitor/\${2}\`;`,
                errors: [{ messageId: 'botToken' }, { messageId: 'botToken' }],
            },
        ],
    });

    it('is applied by the repo config everywhere under src/ except the seam and the signer', () => {
        const planted = `import { signRequest } from '@/lib/web-bot-auth/sign';\nexport const ua = 'InflectCompliance-VendorMonitor/9';\nexport const s = signRequest;\n`;
        const sites = [
            'src/app-layer/services/vendor-monitoring/planted-bot-backdoor.ts',
            'src/lib/web-bot-auth/planted-bot-backdoor.ts',
            'src/app-layer/jobs/planted-bot-backdoor.ts',
        ];
        const exempt = ['src/lib/web-bot-auth/bot-fetch.ts', 'src/lib/web-bot-auth/sign.ts'];
        const script = `
            const { ESLint } = require('eslint');
            (async () => {
                const eslint = new ESLint({
                    cwd: ${JSON.stringify(ROOT)},
                    ruleFilter: ({ ruleId }) => ruleId === 'local/web-bot-auth-single-seam',
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
        const flags = (p: string) =>
            results.find((r) => r.filePath.endsWith(p))!.ruleIds.filter((id) => id === 'local/web-bot-auth-single-seam').length;
        for (const site of sites) expect([site, flags(site)]).toEqual([site, 2]);
        for (const site of exempt) expect([site, flags(site)]).toEqual([site, 0]);
    }, 120_000);
});
