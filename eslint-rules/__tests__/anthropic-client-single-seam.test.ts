/**
 * `local/anthropic-client-single-seam` — RuleTester.
 *
 * The `valid` cases are the load-bearing half, as the README asks. An
 * invalid-only suite passes against a rule that flags every import. Each
 * narrowing the rule makes (`import type`, `export type`, another scope that
 * merely shares the prefix's first letters, a computed dynamic import) has a
 * case here that goes red if it breaks.
 *
 * The invalid cases are every way a module can load the SDK and so obtain the
 * class to construct: default, named, namespace and side-effect imports, a
 * subpath, `import = require`, a re-export, `import()`, `require()`, and the
 * near-miss that looks like a type import and is not.
 *
 * Cases are parsed with `@typescript-eslint/parser`, because `import type`,
 * inline `type` specifiers and `import x = require()` are TypeScript syntax and
 * the rule's narrowings read the TS-only `importKind` / `exportKind` fields.
 */
import { RuleTester } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';

// CommonJS on purpose — see eslint-rules/index.js for why `.mjs` and `.cjs`
// both fail in this repo.
const rule = require('../rules/anthropic-client-single-seam');

const ruleTester = new RuleTester({
    languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
});

describe('local/anthropic-client-single-seam', () => {
    it('runs its cases through the TypeScript parser, not espree', () => {
        // `import type` is a parse error under espree, so this succeeding is
        // evidence the TS parser does the work.
        expect(() => tsParser.parse(`import type X from '@anthropic-ai/sdk';`, { sourceType: 'module' })).not.toThrow();
    });

    ruleTester.run('anthropic-client-single-seam', rule, {
        valid: [
            {
                name: 'a type-only import of the client class',
                code: `import type Anthropic from '@anthropic-ai/sdk';`,
            },
            {
                name: 'a type-only import of a subpath, how an engine names message types',
                code: `import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';`,
            },
            {
                name: 'a type-only re-export',
                code: `export type { MessageParam } from '@anthropic-ai/sdk/resources/messages';`,
            },
            {
                name: 'a re-export whose specifiers are all inline type',
                code: `export { type MessageParam } from '@anthropic-ai/sdk/resources/messages';`,
            },
            {
                name: 'the seam itself, imported by an engine',
                code: `import { clientForRun } from '@/lib/agentic/tool-runner/client';`,
            },
            {
                name: 'another scope is not this one',
                code: `import { Foo } from '@anthropic/other'; import { Bar } from 'anthropic-ai';`,
            },
            {
                name: 'a computed dynamic import is out of reach, and not reported',
                code: `const m = await import(moduleName);`,
            },
            {
                name: 'a require of something else',
                code: `const fs = require('fs');`,
            },
            {
                name: 'a method named require is not the loader',
                code: `registry.require('@anthropic-ai/sdk');`,
            },
        ],
        invalid: [
            {
                name: 'the default import a second construction site would start from',
                code: `import Anthropic from '@anthropic-ai/sdk';\nconst c = new Anthropic({ apiKey });`,
                errors: [{ messageId: 'valueImport' }],
            },
            {
                name: 'a named import of the class',
                code: `import { Anthropic } from '@anthropic-ai/sdk';`,
                errors: [{ messageId: 'valueImport' }],
            },
            {
                name: 'a namespace import',
                code: `import * as sdk from '@anthropic-ai/sdk';`,
                errors: [{ messageId: 'valueImport' }],
            },
            {
                name: 'a side-effect import still loads the package',
                code: `import '@anthropic-ai/sdk';`,
                errors: [{ messageId: 'valueImport' }],
            },
            {
                name: 'a subpath that exports the client',
                code: `import { Anthropic } from '@anthropic-ai/sdk/client';`,
                errors: [{ messageId: 'valueImport' }],
            },
            {
                name: 'another package in the scope, such as a later agent SDK',
                code: `import { query } from '@anthropic-ai/claude-agent-sdk';`,
                errors: [{ messageId: 'valueImport' }],
            },
            {
                name: 'a value import beside a type one',
                code: `import Anthropic, { type MessageParam } from '@anthropic-ai/sdk';`,
                errors: [{ messageId: 'valueImport' }],
            },
            {
                name: 'all-inline-type specifiers look like a type import and may not be one',
                code: `import { type MessageParam } from '@anthropic-ai/sdk/resources/messages';`,
                errors: [{ messageId: 'inlineTypeOnly' }],
            },
            {
                name: 'import = require',
                code: `import Anthropic = require('@anthropic-ai/sdk');`,
                errors: [{ messageId: 'valueImport' }],
            },
            {
                name: 'a re-export would hand the class on',
                code: `export { default as Anthropic } from '@anthropic-ai/sdk';`,
                errors: [{ messageId: 'reExport' }],
            },
            {
                name: 'export * from the package',
                code: `export * from '@anthropic-ai/sdk';`,
                errors: [{ messageId: 'reExport' }],
            },
            {
                name: 'a dynamic import',
                code: `const { default: Anthropic } = await import('@anthropic-ai/sdk');`,
                errors: [{ messageId: 'dynamicLoad' }],
            },
            {
                name: 'a dynamic import through a template with no expressions',
                code: 'const m = await import(`@anthropic-ai/sdk`);',
                errors: [{ messageId: 'dynamicLoad' }],
            },
            {
                name: 'a require',
                code: `const Anthropic = require('@anthropic-ai/sdk');`,
                errors: [{ messageId: 'dynamicLoad' }],
            },
        ],
    });
});
