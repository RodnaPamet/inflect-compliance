/**
 * Reading a `--flag value` or `--flag=value` argument, and refusing one that
 * was never understood (#5647).
 *
 * Both Epic B operator scripts documented their flags with a SPACE and parsed
 * only the `=` form:
 *
 *     // usage:  --models Risk,Finding
 *     const modelsArg = args.find((a) => a.startsWith('--models='));
 *
 * So the documented command dropped the flag in silence. On
 * `encrypt-existing-data.ts` that is not a usage error but a mass write: no
 * `--models` filter means EVERY model in the manifest, and an operator who
 * asked for two got the estate re-encrypted under the global key.
 *
 * The strict half made it worse — that script validates the model names it
 * does parse and throws on a typo — so it reads as a script that checks its
 * input, right up to the argument it ignores.
 *
 * Hence both halves live here: accept either spelling, and REFUSE an argument
 * nobody claimed. The refusal is the half that surfaces the next one of these,
 * because a dropped flag is otherwise indistinguishable from an applied one.
 *
 * @module scripts/lib/value-flag
 */

/**
 * The value of `--name`, written either `--name=value` or `--name value`.
 *
 * Returns undefined when the flag is absent. THROWS when it is present with no
 * value — `--models --execute` is a mistake, and reading `--execute` as the
 * model list would be worse than stopping.
 */
export function readValueFlag(args: readonly string[], name: string): string | undefined {
    const eq = `--${name}=`;
    const joined = args.find((a) => a.startsWith(eq));
    if (joined !== undefined) {
        const value = joined.slice(eq.length);
        if (value === '') throw new Error(`--${name} was given no value`);
        return value;
    }
    const at = args.indexOf(`--${name}`);
    if (at === -1) return undefined;
    const next = args[at + 1];
    if (next === undefined || next.startsWith('--')) {
        throw new Error(`--${name} was given no value`);
    }
    return next;
}

/**
 * Refuse any argument that is not a known flag or the value of one.
 *
 * `valueFlags` are the names that CONSUME the next token, so `--models` plus
 * `Risk,Finding` is two tokens and one flag. Without this the two stray tokens
 * of `--models Risk,Finding` were swallowed silently, which is how a dropped
 * flag looked exactly like an applied one.
 */
export function assertNoUnknownArgs(
    args: readonly string[],
    booleanFlags: readonly string[],
    valueFlags: readonly string[],
): void {
    const known = new Set([...booleanFlags, ...valueFlags].map((n) => `--${n}`));
    const consumesNext = new Set(valueFlags.map((n) => `--${n}`));
    const unknown: string[] = [];

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        const bare = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
        if (known.has(bare)) {
            // `--name value` consumes the token after it; `--name=value` does not.
            if (consumesNext.has(bare) && !arg.includes('=')) i += 1;
            continue;
        }
        unknown.push(arg);
    }

    if (unknown.length > 0) {
        throw new Error(
            `Unrecognised argument(s): ${unknown.join(' ')}. `
            + `Known flags: ${[...known].sort().join(' ')}`,
        );
    }
}
