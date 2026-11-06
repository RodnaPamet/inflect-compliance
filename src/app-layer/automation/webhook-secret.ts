/**
 * The WEBHOOK signing key: written to the encrypted column, and never sent back.
 *
 * A WEBHOOK rule can sign each request with an HMAC key
 * (`X-Inflect-Signature`). It belongs in `webhookSecretEncrypted`, which the
 * Epic B extension encrypts at rest and DECRYPTS on read, so a rule row read
 * through the app client carries the key in clear. Two halves, one rule each:
 *
 *   - {@link resolveWebhookSecretWrite} decides what a create or update writes
 *     to `webhookSecretEncrypted` (in the Epic B manifest, so encrypted at rest)
 *     and strips `secretRef` from the config before it is stored.
 *   - {@link toPublicRule} is the only shape a rule leaves the usecase layer
 *     in: no `webhookSecretEncrypted`, no `secretRef`, and a boolean
 *     `webhookSecretSet` so a form can say a key is set without holding it.
 *
 * The executor still falls back to a legacy `secretRef` for rules nobody has
 * edited since; `scripts/migrate-webhook-secrets.ts` moves those, and editing
 * such a rule moves it too (see `resolveWebhookSecretWrite`).
 */

/** The legacy key, if this config carries one. */
function legacySecretOf(config: unknown): string | null {
    if (!config || typeof config !== 'object') return null;
    const v = (config as { secretRef?: unknown }).secretRef;
    return typeof v === 'string' && v.length > 0 ? v : null;
}

/** The config with any `secretRef` removed; non-objects pass through. */
export function withoutSecretRef<T>(config: T): T {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
    if (!('secretRef' in (config as Record<string, unknown>))) return config;
    const { secretRef: _secret, ...rest } = config as Record<string, unknown>;
    void _secret;
    return rest as T;
}

export interface WebhookSecretWriteInput {
    /** The action type the rule will have after this write. */
    effectiveActionType: string;
    /** The incoming config, when the write carries one. */
    incomingConfig: unknown;
    /**
     * The explicit key from the request: a string sets it, `null` removes it,
     * `undefined` says nothing.
     */
    requestedSecret: string | null | undefined;
    /** The stored row, on an update. */
    existing?: { webhookSecretEncrypted?: string | null; actionConfigJson?: unknown } | null;
}

export interface WebhookSecretWrite {
    /** What to store as the config: the incoming one without `secretRef`. */
    config: unknown;
    /**
     * What to write to `webhookSecretEncrypted`: a string or `null` to write,
     * `undefined` to leave the column as it is.
     */
    secret: string | null | undefined;
}

export function resolveWebhookSecretWrite(input: WebhookSecretWriteInput): WebhookSecretWrite {
    const config = withoutSecretRef(input.incomingConfig);

    // A rule that is not a WEBHOOK signs nothing, so it keeps no key. Moving a
    // rule off WEBHOOK clears the column rather than leaving a key behind.
    if (input.effectiveActionType !== 'WEBHOOK') {
        const hadOne = Boolean(input.existing?.webhookSecretEncrypted);
        return { config, secret: hadOne ? null : undefined };
    }

    // An explicit request wins: a new key, or `null` to remove it.
    if (input.requestedSecret !== undefined) {
        return { config, secret: input.requestedSecret };
    }

    // An API caller still using the old field gets it moved, not stored.
    const fromConfig = legacySecretOf(input.incomingConfig);
    if (fromConfig) return { config, secret: fromConfig };

    // A rule configured before this change, edited without touching its key:
    // the new config drops the legacy `secretRef`, so the key moves to the
    // column instead of being lost. The column, once set, is left alone.
    const legacy = legacySecretOf(input.existing?.actionConfigJson);
    if (input.incomingConfig !== undefined && legacy && !input.existing?.webhookSecretEncrypted) {
        return { config, secret: legacy };
    }

    return { config, secret: undefined };
}

type RuleRowLike = {
    actionConfigJson?: unknown;
    webhookSecretEncrypted?: string | null;
};

export type PublicAutomationRule<T extends RuleRowLike> = Omit<T, 'webhookSecretEncrypted'> & {
    /** A signing key is configured. The key itself never leaves the server. */
    webhookSecretSet: boolean;
};

/** A rule as a client may see it. */
export function toPublicRule<T extends RuleRowLike>(rule: T): PublicAutomationRule<T> {
    const { webhookSecretEncrypted, ...rest } = rule;
    const set = Boolean(webhookSecretEncrypted) || legacySecretOf(rule.actionConfigJson) !== null;
    return {
        ...(rest as Omit<T, 'webhookSecretEncrypted'>),
        ...('actionConfigJson' in rule ? { actionConfigJson: withoutSecretRef(rule.actionConfigJson) } : {}),
        webhookSecretSet: set,
    };
}
