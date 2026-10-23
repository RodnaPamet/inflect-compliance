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

/** The shape `buildConnectionBody` needs from a provider's declared field. */
export interface DeclaredConfigField {
    readonly key: string;
    readonly type: string;
}

/**
 * The request body the admin integrations form POSTs, built from form state.
 *
 * Extracted from `handleSave` (#4008) because the two decisions it makes were
 * untestable where they lived — four lines inside an 827-line client component
 * with eighteen `useState`, a mount-time fetch and five sibling cards, so any
 * test of them was really a test of the whole page. Mounting it needed eight
 * separate mocks and shims and still timed out; the blockers are listed on
 * #4008. Here the same decisions are a pure function.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DECISION 1 — `secrets` IS OMITTED UNLESS SOMETHING WAS TYPED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `upsertIntegrationConnection` gates on key COUNT, so `{ authorization: '' }`
 * — a key with an empty value — validates, encrypts and OVERWRITES a working
 * credential with an empty string. The server cannot tell "the operator cleared
 * this field" from "the form sent its empty default", and refusing empties would
 * remove the ability to clear one deliberately.
 *
 * So this is the only thing standing between that and the wipe, and the path
 * that reaches it is *type into a secret field, then clear it* — an untouched
 * form holds `{}`, which fails the server's count check anyway. Change `some` to
 * `every`, or drop the `.trim()`, and clearing a field you had started to fill
 * destroys the stored credential with no error.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DECISION 2 — DECLARED BOOLEANS GO OUT AS BOOLEANS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Form state is all strings. `coerceDeclaredBooleans` above records what a
 * ticked checkbox saved as `'true'` cost: the Entra writer's
 * `config.writesEnabled !== true` is deliberately strict, so the feature stayed
 * off with no error anywhere. This is the other half of that pairing — break it
 * and a connection that was writing stops writing, silently.
 */
export function buildConnectionBody(input: {
    readonly provider: string;
    readonly name: string;
    readonly config: Record<string, string>;
    readonly secrets: Record<string, string>;
    readonly editingId: string | null;
    readonly configFields: readonly DeclaredConfigField[];
}): Record<string, unknown> {
    const declaredBoolean = new Set(
        input.configFields.filter((f) => f.type === 'boolean').map((f) => f.key),
    );

    const body: Record<string, unknown> = {
        provider: input.provider,
        name: input.name,
        configJson: coerceDeclaredBooleans(input.config, declaredBoolean),
    };
    if (input.editingId) body.id = input.editingId;

    // Only send secrets if any field has a value — see DECISION 1.
    const hasSecrets = Object.values(input.secrets).some((v) => v.trim().length > 0);
    if (hasSecrets) body.secrets = input.secrets;

    return body;
}
