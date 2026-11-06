# 2026-11-06 — The WEBHOOK signing key is stored encrypted and never returned

**Commit:** see the pull request for this branch (`claude/webhook-secret-encrypted`).

## Design

An automation rule of type WEBHOOK can sign each request with an HMAC key
(`X-Inflect-Signature`). The encrypted column for that key,
`AutomationRule.webhookSecretEncrypted`, already existed. So did the executor's
preference for it, and a script to move old keys into it. But the rule builder
still sent the key inside `actionConfig` as `secretRef`, and its form described
that value as a reference to a stored secret, when the executor uses it as the
key itself. So new keys never reached the column. Rule responses also returned
the stored row as it was.

One module now owns the key, `src/app-layer/automation/webhook-secret.ts`:

- `resolveWebhookSecretWrite` decides what a write does to the column, and
  strips `secretRef` from the config before it is stored. Its inputs are a
  top-level `webhookSecret` (a string sets the key, `null` removes it, absent
  leaves it) or the legacy `secretRef`, which is still accepted from API
  callers and moved.
- `toPublicRule` is the only shape a rule leaves the usecase layer in. It drops
  the column and `secretRef`, and adds `webhookSecretSet`.

The builder treats the key as write-only. On edit the field starts empty, a
stored key reads as stored, and **Remove signing secret** sends `null`.

## Also fixed: every rule write was failing

`logEvent` validates `detailsJson` against `AuditDetailsJsonSchema`, which
requires `category`. None of the four rule usecases sent one. Against a real
database, every rule create, edit, enable/disable and archive therefore failed
with a 400 "Invalid detailsJson structure", and so did installing a template,
which goes through create. The unit tests mock `logEvent`, which is how this
went unseen. The four audit payloads now carry `category`. A unit test runs each
payload through the real schema, and the new integration test drives the real
usecases.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/automation/webhook-secret.ts` | New. The write decision and the public shape. |
| `src/app-layer/usecases/automation-rules.ts` | Applies both; audit payloads carry `category`. |
| `src/app-layer/automation/AutomationRuleRepository.ts`, `types.ts` | `webhookSecret` on create and update. |
| `src/app-layer/schemas/automation.schemas.ts`, the two rule routes | Accept and pass `webhookSecret`. |
| `src/components/processes/RuleBuilderModal.tsx`, `RuleDetailSheet.tsx` | Write-only field; the sheet reads `webhookSecretSet`. |

## Decisions

- **The legacy field is still accepted, not refused.** An API caller sending
  `actionConfig.secretRef` keeps working, and its key lands in the encrypted
  column. Refusing it would break an integration for no safety gain.
- **Editing a rule whose key is still in the JSON moves the key.** The form no
  longer receives `secretRef`, so the saved config lacks it. Without the move,
  the first edit after this change would drop the key, and the endpoint would
  start receiving unsigned requests.
- **The executor's `?? cfg.secretRef` fallback stays** until
  `scripts/migrate-webhook-secrets.ts` reports nothing left to move. Rules
  nobody edits still sign.
- **Rotate a key that was configured before this change.** It was stored
  outside the encrypted column, and moving it does not change that it was.
- **Moving a rule off WEBHOOK clears the key.** A rule that signs nothing keeps
  nothing.
