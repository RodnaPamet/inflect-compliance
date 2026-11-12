'use strict';

/**
 * `local/web-bot-auth-single-seam`
 *
 * Web Bot Auth Phase 2 (docs/ai-architecture/web-bot-auth.md): every
 * unattended request to a third-party website goes through ONE seam,
 * `src/lib/web-bot-auth/bot-fetch.ts`. `botFetch` is `safeFetch` (https,
 * public addresses only, pinned, no redirects), plus the bot's honest
 * User-Agent, plus the deployment's request signature. A signature made
 * anywhere else could ride a request that skipped the SSRF checks, and a bot
 * User-Agent written anywhere else would claim the bot's identity for a
 * request the bot page does not describe.
 *
 * ── What it demands ──────────────────────────────────────────────────
 *
 * Outside the files the config exempts (the seam and the signer itself):
 *
 *   1. No module LOADS `src/lib/web-bot-auth/sign.ts` — by the `@/` alias or
 *      by a relative path that resolves there — through an import (type-only
 *      included), a re-export, `import x = require(…)`, `import()` or
 *      `require()`.
 *   2. No string or template literal carries the bot's product token,
 *      `InflectCompliance-VendorMonitor`. The User-Agent is built only by
 *      `vendorMonitorUserAgent` in the seam.
 *
 * ── What it cannot see ───────────────────────────────────────────────
 *
 * A computed module specifier, and a token assembled from pieces at run
 * time. The repo has neither.
 */

const path = require('path');

const SIGN_ALIAS = /^@\/lib\/web-bot-auth\/sign(\.ts)?$/;
const SIGN_FILE = `${path.sep}src${path.sep}lib${path.sep}web-bot-auth${path.sep}sign`;
const BOT_TOKEN = 'InflectCompliance-VendorMonitor';

function literalSource(node) {
    if (!node) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
        return node.quasis.map((q) => q.value.cooked).join('');
    }
    return null;
}

/** True when `source`, imported from `filename`, names the request signer. */
function namesSigner(source, filename) {
    if (typeof source !== 'string') return false;
    if (SIGN_ALIAS.test(source)) return true;
    if (!source.startsWith('.')) return false;
    const resolved = path.resolve(path.dirname(filename), source).replace(/\.ts$/, '');
    return resolved.endsWith(SIGN_FILE);
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Only src/lib/web-bot-auth/bot-fetch.ts signs a request or names the bot User-Agent; elsewhere, call botFetch().',
        },
        schema: [],
        messages: {
            signerLoad:
                "Only src/lib/web-bot-auth/bot-fetch.ts loads '{{source}}'. Fetch a third-party URL with botFetch(), which signs through safeFetch.",
            botToken:
                "The bot's User-Agent is built only in src/lib/web-bot-auth/bot-fetch.ts. Fetch with botFetch() rather than claiming the bot's identity here.",
        },
    },

    create(context) {
        const filename = context.filename || context.getFilename();

        function check(node, sourceNode) {
            const source = literalSource(sourceNode);
            if (namesSigner(source, filename)) {
                context.report({ node, messageId: 'signerLoad', data: { source } });
            }
        }

        return {
            ImportDeclaration: (node) => check(node, node.source),
            ExportNamedDeclaration: (node) => check(node, node.source),
            ExportAllDeclaration: (node) => check(node, node.source),
            ImportExpression: (node) => check(node, node.source),
            TSImportEqualsDeclaration(node) {
                const ref = node.moduleReference;
                if (ref && ref.type === 'TSExternalModuleReference') check(node, ref.expression);
            },
            CallExpression(node) {
                if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
                    check(node, node.arguments[0]);
                }
            },
            Literal(node) {
                if (typeof node.value === 'string' && node.value.includes(BOT_TOKEN)) {
                    context.report({ node, messageId: 'botToken' });
                }
            },
            TemplateElement(node) {
                if (node.value.cooked && node.value.cooked.includes(BOT_TOKEN)) {
                    context.report({ node, messageId: 'botToken' });
                }
            },
        };
    },
};
