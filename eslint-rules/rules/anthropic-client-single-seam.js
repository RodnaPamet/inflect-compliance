'use strict';

/**
 * `local/anthropic-client-single-seam`
 *
 * Every Anthropic client an agent run uses is built by `clientForRun` in
 * `src/lib/agentic/tool-runner/client.ts` (Step 2a of
 * `docs/claude-tool-runner-design.md`, #4148). That function chooses the
 * client from the run's residency, refuses a LOCAL_ONLY tenant before anything
 * external is read, pins the host, the log level and the tracing mode the SDK
 * would otherwise take from the environment, and builds a new client per call.
 * A client constructed anywhere else skips all of that, and nothing about the
 * construction would look wrong in review.
 *
 * ── What it demands, exactly ─────────────────────────────────────────
 *
 * Outside the files the config exempts (the seam itself), no module LOADS a
 * package under `@anthropic-ai/`:
 *
 *   • `import X from '@anthropic-ai/…'`, a named or namespace import, and a
 *     bare side-effect import;
 *   • `import X = require('@anthropic-ai/…')`;
 *   • `export … from '@anthropic-ai/…'` and `export * from …`, so no module
 *     can hand the class on;
 *   • `import('@anthropic-ai/…')` and `require('@anthropic-ai/…')`.
 *
 * With the class importable in one file only, a second construction site
 * cannot be written: there is no `Anthropic` to `new`. That is why the rule
 * polices the LOAD rather than the `new` expression, which an alias, a
 * re-export or a factory would hide.
 *
 * `import type` and `export type` are allowed: they are erased, load nothing,
 * and let an engine describe its tools and messages in the SDK's own types.
 * An import whose specifiers are all inline `type` is NOT accepted. Under
 * `isolatedModules` TypeScript may keep it as `import {} from '…'`, which
 * loads the package; write `import type` instead.
 *
 * ── What it cannot see ───────────────────────────────────────────────
 *
 * A dynamic `import()` or `require()` whose argument is not a string literal
 * (or a template with no expressions) is not resolved. It is not reported
 * either: the repo has no such call, and reporting every computed import in
 * `src/` to catch a hypothetical one would make the rule noise. The SDK keeps
 * no process-wide default client or provider registry, so there is no global
 * setter to police; pi-ai's registry, which Flue uses, is a different package
 * and is covered by `flue/model-selection.ts`'s own design.
 *
 * ── Why a rule and not a selector ────────────────────────────────────
 *
 * Several blocks in `eslint.config.mjs` REPLACE `no-restricted-syntax` for
 * their own files, and one turns it off, so a selector there would silently
 * stop applying to those files. A rule is turned on once and stays on.
 */

const PACKAGE_SCOPE = '@anthropic-ai/';

/** The literal module name a node names, or null when it is computed. */
function literalSource(node) {
    if (!node) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
        return node.quasis.map((q) => q.value.cooked).join('');
    }
    return null;
}

function isAnthropicPackage(source) {
    return typeof source === 'string' && source.startsWith(PACKAGE_SCOPE);
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Only src/lib/agentic/tool-runner/client.ts may load an @anthropic-ai/* package; elsewhere, use clientForRun and `import type`.',
        },
        schema: [],
        messages: {
            valueImport:
                "Only src/lib/agentic/tool-runner/client.ts loads '{{source}}'. Get a client from clientForRun(), which chooses it from the run's residency; for the SDK's types, write `import type`.",
            inlineTypeOnly:
                "An import of '{{source}}' whose specifiers are all inline `type` may still load the package under isolatedModules. Write `import type { … } from '{{source}}'`.",
            reExport:
                "Do not re-export from '{{source}}': only src/lib/agentic/tool-runner/client.ts may hand on the Anthropic SDK. `export type` is allowed.",
            dynamicLoad:
                "Only src/lib/agentic/tool-runner/client.ts loads '{{source}}'. Get a client from clientForRun() instead of loading the SDK at run time.",
        },
    },

    create(context) {
        function report(node, messageId, source) {
            context.report({ node, messageId, data: { source } });
        }

        return {
            ImportDeclaration(node) {
                const source = literalSource(node.source);
                if (!isAnthropicPackage(source)) return;
                if (node.importKind === 'type') return;
                const specifiers = node.specifiers || [];
                if (
                    specifiers.length > 0 &&
                    specifiers.every((s) => s.type === 'ImportSpecifier' && s.importKind === 'type')
                ) {
                    report(node, 'inlineTypeOnly', source);
                    return;
                }
                report(node, 'valueImport', source);
            },

            TSImportEqualsDeclaration(node) {
                if (node.importKind === 'type') return;
                const ref = node.moduleReference;
                if (!ref || ref.type !== 'TSExternalModuleReference') return;
                const source = literalSource(ref.expression);
                if (isAnthropicPackage(source)) report(node, 'valueImport', source);
            },

            ExportNamedDeclaration(node) {
                const source = literalSource(node.source);
                if (!isAnthropicPackage(source)) return;
                if (node.exportKind === 'type') return;
                const specifiers = node.specifiers || [];
                if (specifiers.length > 0 && specifiers.every((s) => s.exportKind === 'type')) return;
                report(node, 'reExport', source);
            },

            ExportAllDeclaration(node) {
                const source = literalSource(node.source);
                if (!isAnthropicPackage(source)) return;
                if (node.exportKind === 'type') return;
                report(node, 'reExport', source);
            },

            ImportExpression(node) {
                const source = literalSource(node.source);
                if (isAnthropicPackage(source)) report(node, 'dynamicLoad', source);
            },

            CallExpression(node) {
                if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
                const source = literalSource(node.arguments[0]);
                if (isAnthropicPackage(source)) report(node, 'dynamicLoad', source);
            },
        };
    },
};
