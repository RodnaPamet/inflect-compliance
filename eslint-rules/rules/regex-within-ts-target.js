'use strict';

/**
 * A regex literal uses only syntax `tsc` accepts at the tsconfig's target.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 *
 * `tsconfig.json` targets ES2017. Jest's transform does not typecheck, and
 * Node runs ES2018+ regex syntax happily, so a test using the `s` flag or a
 * named group is green locally and fails the `Typecheck` job after the push.
 * That happened at least twice (#3922): a guard written with `/s`, and a proto
 * reader written with named groups. Two guards already carry a comment
 * explaining the `[\s\S]` workaround, in exactly the places somebody had
 * already been bitten, which is not where the next author is reading.
 *
 * ── WHAT IT SEES ─────────────────────────────────────────────────────────
 *
 * What `tsc` 5.9 REFUSES at the target, measured, and nothing else:
 *
 *   `s` flag        TS1501  ES2018
 *   `d` flag        TS1501  ES2022
 *   `v` flag        TS1501  ES2024
 *   `(?<name>…)`    TS1503  ES2018
 *
 * Lookbehind (`(?<=…)`, `(?<!…)`) and `\p{…}` are ES2018 too, but `tsc`
 * accepts them at ES2017, so flagging them would refuse code that typechecks.
 * A named group is told apart from a lookbehind by the character after `(?<`,
 * and only outside a character class and not after a backslash.
 *
 * ── WHAT IT CANNOT SEE ───────────────────────────────────────────────────
 *
 * A pattern built at run time (`new RegExp(src, 's')`). `tsc` does not check
 * those either, so jest and the compiler agree about them.
 */

/** Each flag `tsc` refuses below a target, with the ES year it needs. */
const FLAG_MINIMUM = { s: 2018, d: 2022, v: 2024 };

/** The ES year a named capturing group needs. */
const NAMED_GROUP_MINIMUM = 2018;

/** Whether `pattern` holds a named capturing group, outside classes and escapes. */
function hasNamedGroup(pattern) {
    let inClass = false;
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '\\') {
            i++;
            continue;
        }
        if (inClass) {
            if (ch === ']') inClass = false;
            continue;
        }
        if (ch === '[') {
            inClass = true;
            continue;
        }
        if (ch === '(' && pattern[i + 1] === '?' && pattern[i + 2] === '<') {
            const next = pattern[i + 3];
            if (next !== '=' && next !== '!') return true;
        }
    }
    return false;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                "A regex literal uses only syntax tsc accepts at the tsconfig's target, which jest does not check",
        },
        schema: [
            {
                type: 'object',
                properties: { target: { type: 'integer', minimum: 2015 } },
                required: ['target'],
                additionalProperties: false,
            },
        ],
        messages: {
            flag:
                'The `{{flag}}` flag needs ES{{needed}}, and tsconfig targets ES{{target}}. Jest runs it; ' +
                'tsc refuses it (TS1501), so it fails the Typecheck job after the push.{{remedy}}',
            namedGroup:
                'Named capturing groups need ES{{needed}}, and tsconfig targets ES{{target}}. Jest runs them; ' +
                'tsc refuses them (TS1503), so it fails the Typecheck job after the push. ' +
                'Use a numbered group and read it by index.',
        },
    },

    create(context) {
        const { target } = context.options[0];
        const REMEDY = { s: ' Write `[\\s\\S]` where the pattern means any character.' };

        return {
            Literal(node) {
                if (!node.regex) return;
                const { pattern, flags } = node.regex;
                for (const flag of flags) {
                    const needed = FLAG_MINIMUM[flag];
                    if (needed && needed > target) {
                        context.report({
                            node,
                            messageId: 'flag',
                            data: { flag, needed, target, remedy: REMEDY[flag] ?? '' },
                        });
                    }
                }
                if (NAMED_GROUP_MINIMUM > target && hasNamedGroup(pattern)) {
                    context.report({
                        node,
                        messageId: 'namedGroup',
                        data: { needed: NAMED_GROUP_MINIMUM, target },
                    });
                }
            },
        };
    },
};
