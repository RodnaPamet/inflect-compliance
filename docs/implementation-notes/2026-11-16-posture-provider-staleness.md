# 2026-11-16 — reporting that a posture connection's gateway provider is behind

**Commit:** `(this PR)` feat(posture): report a posture connection's gateway provider as stale after a credential rotation

## Design

#5476's acceptance criterion 4 was originally *"rotation and tenant purge remove
the provider"*, renegotiated by the owner to **detect and report** — the product
cannot remove what it cannot write, because writing a provider's credential needs
gateway-wide mTLS with `OU=operator`, deliberately absent from both VMs.

The fact worth reporting: a posture connection's provider is created by the
operator with that connection's credential, and the product attaches it by a name
derived from row ids. Rotating the credential in the product therefore leaves the
gateway holding the previous one **under the same name**, and every later scan
benchmarks an account the tenant no longer has on record. It is the quietest
version of #5251 — the account is real; it is simply not theirs any more.

```
save a new credential ──► verdict (pure)        ──► one finding, assigned
                          provider-staleness.ts      posture-provider-staleness.ts
                                │
                   NOT_APPLICABLE / FIRST_CREDENTIAL / UNCHANGED  ──► nothing
                   STALE / UNREADABLE_PREVIOUS                    ──► report
```

The two halves of criterion 4 are reported by different routes, because only one
of them has a reader:

| what happened | how it is reported |
| --- | --- |
| the credential rotated | one MEDIUM finding on the connection, assigned to its owner |
| the connection or tenant is gone | **not** a finding — the operator diffs the `posture-provider-names` output, where an orphan is by definition absent |

## Files

| File | Role |
| --- | --- |
| `src/app-layer/integrations/cloud-posture/provider-staleness.ts` | NEW. The pure verdict over five outcomes and three previous-credential states |
| `src/app-layer/usecases/posture-provider-staleness.ts` | NEW. Turns a reportable verdict into exactly one Finding |
| `src/app-layer/usecases/integrations.ts` | The upsert's update path decides and reports, after the write, in the same transaction |
| `deploy/openshell/README.md` | The rotation and orphan halves, and why neither closes itself |

## Decisions

- **Nothing closes the finding automatically** (owner, 2026-11-16). There is no
  positive evidence available: #5739's readiness observation reports
  `credentials_installed`, never *which* credential. A close on the next
  successful scan would close on the old credential working perfectly well, and a
  close on a scan refusing would be a different fact entirely. So a person closes
  it after re-provisioning, and the finding's body says so — otherwise a reader
  would reasonably wait for it to clear.

- **One OPEN finding per connection, not one per rotation.** `sourceRef` is the
  connection id, so `[tenantId, sourceKind, sourceRef]` is the dedupe key. The
  fact is the same fact however many times the credential moved; a `sourceRef`
  carrying a timestamp would be literally per-rotation and would pile up, which is
  what the owner's reasoning ruled out. A later rotation still reaches the audit
  trail through the ordinary connection-update row.

- **Decrypted values are compared, not ciphertexts.** `encryptField` uses a fresh
  IV, so the same plaintext encrypts differently every time and a ciphertext
  comparison would report every save as a rotation. Keys are ordered first, so two
  serialisations of one credential do not read as a change.

- **The previous credential has THREE states, and collapsing any two gets a case
  wrong.** "There was none" is a first provisioning and reports nothing; "we could
  not read it" cannot show currency and reports; a readable one is compared. An
  earlier draft folded `unreadable` into a null canonical form and steered the
  verdict through a second field — it worked and could not be read, so the
  contract became an explicit `StoredCredential` union.

- **`FindingRepository`, not `createFinding`.** The same reason the integration
  passport sweep uses it: `createFinding` carries its own gate, and reaching it
  here would add `findings.create` to the permission an admin needs to **save a
  connection** — a new requirement on an existing action, for a side effect they
  did not ask for.

- **Reported after the write, inside the same transaction.** A refused save reports
  nothing, and a reported rotation is one that committed.

- **MEDIUM, and the reasoning is the point.** It is not the acute case #5251
  refused — that was every tenant sharing one credential, so a scan could report an
  unrelated organisation's posture as yours. Here the account is one this tenant
  did configure; what has drifted is that it is no longer the credential of record.

- **The finding names the provider and no credential.** The name is what the reader
  passes to `provider create` and is an opaque digest of two row ids; the
  credential is absent in every form — not its value, not its length, not a digest
  of it. A test asserts the body carries none of the obvious words.

- **Purge and deletion are reported by absence, not by a finding.** A finding in a
  purged tenant has no reader. The `posture-provider-names` check lists the
  expected provider for every live posture connection, so a provider the gateway
  holds and that list omits is an orphan — the only direction that works, since the
  list is derived from live rows.
