/**
 * The WEBHOOK signing key: where a write puts it, and what a read leaves out.
 * See `src/app-layer/automation/webhook-secret.ts`.
 */
import {
    resolveWebhookSecretWrite,
    toPublicRule,
    withoutSecretRef,
} from '@/app-layer/automation/webhook-secret';

const CONFIG = { url: 'https://hooks.example.com/x', method: 'POST' };

describe('resolveWebhookSecretWrite', () => {
    it('an explicit key is written to the column, and the config carries none', () => {
        const w = resolveWebhookSecretWrite({
            effectiveActionType: 'WEBHOOK',
            incomingConfig: CONFIG,
            requestedSecret: 'k-new',
        });
        expect(w).toEqual({ config: CONFIG, secret: 'k-new' });
    });

    it('a key sent the OLD way, in actionConfig.secretRef, is moved rather than stored', () => {
        const w = resolveWebhookSecretWrite({
            effectiveActionType: 'WEBHOOK',
            incomingConfig: { ...CONFIG, secretRef: 'k-legacy' },
            requestedSecret: undefined,
        });
        expect(w.config).toEqual(CONFIG);
        expect(w.secret).toBe('k-legacy');
    });

    it('null removes the stored key', () => {
        const w = resolveWebhookSecretWrite({
            effectiveActionType: 'WEBHOOK',
            incomingConfig: CONFIG,
            requestedSecret: null,
            existing: { webhookSecretEncrypted: 'k-old', actionConfigJson: CONFIG },
        });
        expect(w.secret).toBeNull();
    });

    it('an edit that says nothing about the key leaves the column alone', () => {
        const w = resolveWebhookSecretWrite({
            effectiveActionType: 'WEBHOOK',
            incomingConfig: CONFIG,
            requestedSecret: undefined,
            existing: { webhookSecretEncrypted: 'k-old', actionConfigJson: CONFIG },
        });
        expect(w.secret).toBeUndefined();
    });

    it('editing a rule whose key is still in the legacy JSON moves it, instead of losing it', () => {
        // The form no longer sends `secretRef` (a read never returns it), so
        // the new config has none. Without this the key would vanish on save
        // and the endpoint would start receiving unsigned requests.
        const w = resolveWebhookSecretWrite({
            effectiveActionType: 'WEBHOOK',
            incomingConfig: CONFIG,
            requestedSecret: undefined,
            existing: { webhookSecretEncrypted: null, actionConfigJson: { ...CONFIG, secretRef: 'k-legacy' } },
        });
        expect(w).toEqual({ config: CONFIG, secret: 'k-legacy' });
    });

    it('moving a rule off WEBHOOK clears its key', () => {
        const w = resolveWebhookSecretWrite({
            effectiveActionType: 'NOTIFY_USER',
            incomingConfig: { userIds: ['u1'], message: 'hi' },
            requestedSecret: 'ignored',
            existing: { webhookSecretEncrypted: 'k-old', actionConfigJson: CONFIG },
        });
        expect(w.secret).toBeNull();
    });

    it('a rule that is not a WEBHOOK and never had a key writes nothing', () => {
        const w = resolveWebhookSecretWrite({
            effectiveActionType: 'NOTIFY_USER',
            incomingConfig: { userIds: ['u1'], message: 'hi' },
            requestedSecret: undefined,
        });
        expect(w.secret).toBeUndefined();
    });
});

describe('toPublicRule', () => {
    it('drops the column and the legacy field, and says whether a key is set', () => {
        const pub = toPublicRule({
            id: 'r1',
            actionConfigJson: { ...CONFIG, secretRef: 'k-legacy' },
            webhookSecretEncrypted: 'k-decrypted',
        });
        expect(pub).toEqual({ id: 'r1', actionConfigJson: CONFIG, webhookSecretSet: true });
        expect(JSON.stringify(pub)).not.toContain('k-legacy');
        expect(JSON.stringify(pub)).not.toContain('k-decrypted');
    });

    it('a rule with no key says so', () => {
        expect(toPublicRule({ id: 'r1', actionConfigJson: CONFIG, webhookSecretEncrypted: null }).webhookSecretSet).toBe(false);
    });

    it('a legacy-only key still reads as set', () => {
        expect(
            toPublicRule({ id: 'r1', actionConfigJson: { ...CONFIG, secretRef: 'k' }, webhookSecretEncrypted: null })
                .webhookSecretSet,
        ).toBe(true);
    });
});

describe('withoutSecretRef', () => {
    it('passes non-objects and configs without the field through unchanged', () => {
        expect(withoutSecretRef(null)).toBeNull();
        expect(withoutSecretRef(CONFIG)).toBe(CONFIG);
    });
});
