/**
 * Turning a config FORM's values back into the JSON the API expects.
 *
 * The admin integrations form holds every config value as a string, because
 * every control it renders produces one — the checkbox writes `'true'` /
 * `'false'`. JSON has no such convention, and at least one consumer compares
 * strictly: the Entra writer's `config.writesEnabled !== true` is deliberately
 * strict, on the argument that a value which merely LOOKS affirmative is not a
 * considered grant of standing power to disable accounts.
 *
 * The result was a checkbox that ticked, saved, and reloaded ticked while the
 * feature stayed off, with no error anywhere — and the writer's own diagnostic
 * told the operator to "re-save the connection", which reproduced the string.
 * This is what makes that advice true.
 *
 * Deliberately NOT a general-purpose coercion:
 *   - only keys the provider DECLARES as boolean are touched, so the conversion
 *     cannot drift from what the form rendered;
 *   - only the two spellings the checkbox itself emits are converted. Anything
 *     else — `'yes'`, `'1'`, `'TRUE'` — is passed through untouched, because it
 *     did not come from this form and guessing at it is the very thing the
 *     strict comparison exists to refuse.
 */
export function coerceDeclaredBooleans(
    values: Record<string, string>,
    declaredBooleanKeys: ReadonlySet<string>,
): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(values).map(([key, value]) =>
            declaredBooleanKeys.has(key) && (value === 'true' || value === 'false')
                ? [key, value === 'true']
                : [key, value],
        ),
    );
}
