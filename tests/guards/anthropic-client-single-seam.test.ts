/**
 * The repo's own ESLint configuration refuses a second Anthropic client
 * construction site (Step 2a of `docs/claude-tool-runner-design.md`, #4148).
 *
 * `eslint-rules/__tests__/anthropic-client-single-seam.test.ts` proves the RULE
 * catches every way of loading the SDK. This proves the CONFIG applies it where
 * it matters: a planted `new Anthropic(...)` is linted with `eslint.config.mjs`,
 * exactly as `npx eslint .` would lint it, at paths chosen because a careless
 * config would miss them:
 *
 *   • an ordinary engine file beside the seam;
 *   • a file in a directory whose config block REPLACES `no-restricted-syntax`
 *     (the audit procedures) and one whose block turns it OFF (the clipboard
 *     exemption). A selector-based ban would go quiet in both; the rule must not.
 *
 * And it proves the one exemption is the seam itself, by linting the same text
 * at `tool-runner/client.ts`, and the real `client.ts` on disk.
 *
 * ESLint runs in a child process because it loads `eslint.config.mjs` with a
 * native dynamic import that Jest's module system does not provide (the same
 * reason `eslint-skips-build-output.test.ts` does).
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const RULE_ID = 'local/anthropic-client-single-seam';
const SEAM = 'src/lib/agentic/tool-runner/client.ts';

/** A second construction site, as somebody in a hurry would write it. */
const PLANTED = [
    `import Anthropic from '@anthropic-ai/sdk';`,
    `export const direct = () => new Anthropic({ apiKey: 'sk-ant-planted' });`,
    '',
].join('\n');

const PLANT_SITES = [
    'src/lib/agentic/tool-runner/driver.ts',
    'src/app-layer/ai/planted-anthropic-client.ts',
    'src/app-layer/services/audit-procedures/planted-anthropic-client.ts',
    'src/lib/processes/canvas-export.ts',
];

type LintResult = { filePath: string; ruleIds: string[] };

/** Lint `text` as if it were each of `filePaths`, plus the files on disk, with the repo config. */
function lint(text: string, filePaths: readonly string[], onDisk: readonly string[]): LintResult[] {
    const program = `
        const { ESLint } = require('eslint');
        const [text, paths, disk] = JSON.parse(process.argv[1]);
        const eslint = new ESLint({ cwd: process.cwd() });
        (async () => {
            const out = [];
            for (const filePath of paths) {
                for (const r of await eslint.lintText(text, { filePath })) out.push(r);
            }
            for (const r of await eslint.lintFiles(disk)) out.push(r);
            process.stdout.write(JSON.stringify(out.map((r) => ({
                filePath: require('path').relative(process.cwd(), r.filePath),
                ruleIds: r.messages.map((m) => m.ruleId),
            }))));
        })().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
    `;
    const out = execFileSync(process.execPath, ['-e', program, JSON.stringify([text, filePaths, onDisk])], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(out) as LintResult[];
}

describe('the ESLint config allows one Anthropic construction site', () => {
    let results: LintResult[];
    const at = (filePath: string, kind: 'planted' | 'disk') => {
        const matches = results.filter((r) => r.filePath === filePath);
        // lintText results come first, in order; the on-disk lint of the seam is last.
        return kind === 'planted' ? matches[0] : matches[matches.length - 1];
    };

    beforeAll(() => {
        results = lint(PLANTED, [...PLANT_SITES, SEAM], [SEAM]);
    }, 120_000);

    it.each(PLANT_SITES)('refuses the planted construction at %s', (site) => {
        expect(at(site, 'planted').ruleIds).toContain(RULE_ID);
    });

    it('allows the same text in the seam itself (the one exemption)', () => {
        expect(at(SEAM, 'planted').ruleIds).not.toContain(RULE_ID);
    });

    it('the seam on disk lints clean of the rule, and loads the SDK (positive control)', () => {
        // If client.ts stopped importing the SDK, "it lints clean" would be
        // vacuous; the planted result above is what shows the rule is live.
        expect(at(SEAM, 'disk').ruleIds).not.toContain(RULE_ID);
    });
});
