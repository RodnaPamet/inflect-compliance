'use strict';

/**
 * `local/no-positional-comment-strip`
 *
 * Refuses a regex literal that strips comments by POSITION (#4659): the
 * block strip `/\/\*[\s\S]*?\*\//g`, and the line strip that matches an
 * escaped `//` followed by `[^\n]*` or `.*`, each replaced with `''`.
 *
 * Neither half can tell a comment from a string that looks like one. The
 * block half pairs `/*` with the next `*\/` by position, so a string holding
 * `/*` (a glob, a MIME wildcard) opens a phantom comment that runs to the
 * next `*\/` anywhere downstream, and deletes that code before the guard
 * matches. The line half does the same for any string holding `//`: a URL,
 * a path. A guard that asserts a pattern is ABSENT then passes on a region
 * it never read.
 *
 * Measured once: `border-tone-budget` read 106 where the tree held 108,
 * because a MIME wildcard in `FileDropzone.tsx` deleted 354 lines (#4655).
 * The pattern had been copied into 110 test files before #4659 migrated them.
 *
 * The replacement is `codeOf` (or `cssCodeOf`, `sqlCodeOf`, `mdCodeOf`) from
 * `tests/helpers/source-blocks.ts`, which scans strings, template literals
 * and regex literals, and blanks comments to spaces so offsets still line up.
 *
 * What it matches: a regex literal passed as the pattern of `.replace()` or
 * `.replaceAll()`, whose source holds an escaped `/*`, a repeated
 * any-character class and an escaped `*\/` (the block strip), or an escaped
 * `//` followed by `[^\n]*` or `.*` (the line strip). Only a REPLACE deletes
 * text. A regex that MATCHES code allowing a comment line in between, such as
 * `(?:\/\/[^\n]*\n\s*)?`, reads the comment and deletes nothing, so it is
 * left alone, and so is an alternation that only removes a docblock's
 * markers.
 *
 * What it cannot see: a pattern built with `new RegExp('…')` from a string,
 * or one held in a variable and passed by name. Both are rare in `tests/`;
 * the inline literal is how the pattern spread.
 *
 * A file that keeps the old strip on purpose, to show what it got wrong,
 * says so with an inline `eslint-disable-next-line` and its reason.
 */

const BLOCK = /\\\/\\\*(?:\[[^\]]*\]|\.)[*+]\??\\\*\\\//;
const LINE = /\\\/\\\/(?:\\\/\?)?(?:\[\^\\n\]|\.)[*+]/;

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Refuse a regex that strips comments by position; use codeOf from tests/helpers/source-blocks (#4659).',
        },
        schema: [],
        messages: {
            positional:
                'This regex strips {{what}} comments by position, so a "{{opener}}" inside a string is taken for a comment and the code after it is deleted before the check reads it. Use codeOf (or cssCodeOf / sqlCodeOf / mdCodeOf) from tests/helpers/source-blocks (#4659).',
        },
    },
    create(context) {
        return {
            Literal(node) {
                if (!node.regex) return;
                const call = node.parent;
                if (!call || call.type !== 'CallExpression' || call.arguments[0] !== node) return;
                const callee = call.callee;
                const method =
                    callee && callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier'
                        ? callee.property.name
                        : null;
                if (method !== 'replace' && method !== 'replaceAll') return;
                const pattern = node.regex.pattern;
                if (BLOCK.test(pattern)) {
                    context.report({ node, messageId: 'positional', data: { what: 'block', opener: '/*' } });
                } else if (LINE.test(pattern)) {
                    context.report({ node, messageId: 'positional', data: { what: 'line', opener: '//' } });
                }
            },
        };
    },
};
