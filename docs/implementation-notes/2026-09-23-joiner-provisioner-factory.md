# 2026-09-23 — the joiner's provisioner is resolved through a factory

**Issue:** #2750. Builds on #2775, which landed the live Active Directory
provisioner itself.

## Design

#2775 built a live AD provisioner with all five verbs. **Nothing could reach
it.** `createSnapshotProvisioner` was the only `DirectoryProvisioner` any
caller could obtain, and it refuses all four create steps by name — so the live
code existed, was tested, and was unreachable from any pass, at any rung, for
any tenant. A capability with no resolution path is indistinguishable from an
absent one, which is exactly how a joiner can look finished and create nobody.

`src/app-layer/integrations/identity-provisioner-factory.ts` is the resolution
path, deliberately shaped after `resolveDirectoryWriter` rather than invented
fresh:

```
resolveDirectoryProvisioner({ ctx, provider, mode })
  ├─ not in WRITABLE_IDENTITY_PROVIDERS      → none / UNSUPPORTED_PROVIDER   (no DB read)
  ├─ 0 enabled connections                   → none / NO_CONNECTION
  ├─ >1 enabled connections                  → none / AMBIGUOUS_CONNECTION
  ├─ mode !== 'AUTOMATIC'                    → snapshot  (NO socket, NO constructor)
  ├─ no live arm for this provider           → none / NO_LIVE_PROVISIONER
  ├─ secrets will not decrypt                → none / SECRETS_UNREADABLE
  └─ explicit per-provider branch            → live + close()
```

Same refusal vocabulary, same cheapest-first ordering, same `mergeConnection`,
same allowlisted mode test, same always-present `close`.

## Where it diverges from the writer factory, and why

**Two provider sets, not one.** `WRITABLE_IDENTITY_PROVIDERS` has two members
and both have a live *writer*. Creating is not symmetric with disabling: the
Entra joining credential is a Temporary Access Pass, a TAP needs the
authentication-methods policy, that needs `Policy.Read.All`, and that is not
among the permissions this connector requests (`docs/jml-joiner-design.md:350`,
`:355`). So `LIVE_PROVISIONER_PROVIDERS` is a strict subset and Entra at
`AUTOMATIC` refuses `NO_LIVE_PROVISIONER` — a new arm on `ProvisionerRefusal`,
not `UNSUPPORTED_PROVIDER`, because telling an operator "entra-id has no
directory writer" is false and sends them to the wrong setting.

**No fall-through.** `resolveDirectoryWriter`'s last arm is an unguarded
`createActiveDirectoryWriter(...)`, so a provider added to the writable set
without its own branch silently gets an AD writer — CLAUDE.md names that hazard
explicitly. The same mistake here would hand an Entra create to the AD arm,
which binds LDAPS to a host an Entra connection does not have and sets a
PASSWORD where decision 2 says a TAP or nothing. `buildLiveProvisioner`
dispatches on an explicit branch and throws on an unmapped provider.

**The `NO_LIVE_PROVISIONER` refusal sits BELOW the snapshot arm.** Put beside
`UNSUPPORTED_PROVIDER` it would fire first, and the seven-day observation window
would be unavailable for the directory most tenants actually have. Entra can be
dry-run end to end; it just cannot create.

**No readiness report.** `WriterResolution` carries one; `describeWriteReadiness`
answers a *disable's* question in a disable's words ("every disable is refused
with LDAP result 50 and the leaver is not offboarded"), and a create needs a
different right entirely — create-child on the target OU, not
write-userAccountControl on an existing user object.

**No `createOU` gate in the factory.** The provisioner refuses per-create when
none is configured, which gives each candidate a journalled `REFUSED` naming the
missing setting instead of the whole run vanishing behind one factory refusal. A
copy of the check here would be a second spelling free to disagree.

## REFUSED vs INDETERMINATE — the change with teeth

Every failure in the live provisioner was reported as `indeterminate`. That told
an operator "an account may or may not exist" for a create the domain controller
had plainly declined with result 50, and filed a row that needs no human in the
queue only humans clear (`findRestorableState` and the operator sweep both read
INDETERMINATE; neither reads FAILED).

`classifyProvisionFailure` now reads the LDAP result code through the writer's
own `resultCodeOf` + `PROVEN_REFUSAL_RESULT_CODES` — **exported, not copied**, so
the `DOMException` exclusion that keeps an `AbortError`'s legacy `code: 20` from
reading as `attributeOrValueExists` applies to both seams. The default stays
INDETERMINATE and every unrecognised shape keeps it; a transport failure carries
no LDAP result code at all.

The ADD step gets one extra code, in a COPY of the set rather than in the set:
68 (`entryAlreadyExists`) proves an add landed nowhere and proves nothing about a
modify. It is the TOCTOU race the probe structurally cannot close.

## The probe could not answer `unknown`

`IdentifierProbe` has always had three arms and the seam's header says "a failed
probe means UNKNOWN, never FREE". The live arm was the one implementation that
could not honour it — a bind refusal or dropped socket propagated out as a
throw, leaving a caller to invent an answer from `free` (a create straight into a
collision) or a crashed pass. The search is now wrapped and answers `unknown`
naming both namespaces.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/integrations/identity-provisioner-factory.ts` | NEW. The one seam from a connection to a `DirectoryProvisioner`. |
| `src/app-layer/integrations/identity-provisioner.ts` | `ProvisionerResolution` reshaped to snapshot/live/none + `close`; `ProvisionerRefusal` gains `NO_LIVE_PROVISIONER`. |
| `src/app-layer/integrations/identity-writer-factory.ts` | `mergeConnection` exported so there is one decrypt-and-merge, not two. |
| `src/app-layer/integrations/providers/active-directory/writer.ts` | `resultCodeOf` + `PROVEN_REFUSAL_RESULT_CODES` exported for the same reason. |
| `src/app-layer/integrations/providers/active-directory/provisioner.ts` | Failure classification (refused vs indeterminate); the probe's `unknown` arm. |
| `tests/unit/identity/directory-provisioner-factory.test.ts` | NEW. Which arm is chosen, asserted against the CONSTRUCTOR spy. |
| `tests/unit/active-directory-provisioner.test.ts` | The four steps failing independently on real `ldapts` errors, driven through `createDirectoryAccount`. |

## Decisions

- **The snapshot arm is asserted against the constructor spy, not the returned
  `kind`.** A `kind: 'snapshot'` result that opened an LDAPS bind first would
  satisfy the label and violate the rung.
- **`mode !== 'AUTOMATIC'` is an allowlist**, for the reason the writer factory
  spells out: the live arm used to be reached by exhaustion, and retiring
  `PROPOSE` (#2241) turned a stored value into an unrecognised mode that took it.
- **Each step's test asserts the journal verb as well as the `PARTIAL_*`
  state.** They are not the same assertion — every step-2 failure is
  `PARTIAL_NO_GROUP` whether refused or indeterminate, and only the journal
  distinguishes a row a human must chase from one nobody needs to.
- **Nothing here raises `JOINER_MAX_MODE`.** It stays `DRY_RUN`, so the live arm
  this factory can now resolve is still unreachable from a scheduled pass. That
  ceiling is a separate reviewed diff on purpose.
