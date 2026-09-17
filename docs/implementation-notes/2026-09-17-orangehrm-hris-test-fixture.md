# 2026-09-17 — OrangeHRM: an HRIS provider whose HR side we control (#2548)

**Commit:** `<pending>` feat(integrations): add an OrangeHRM HRIS provider as an internal test fixture

## Design

`docs/jml-hris-write-back-design.md` carries four open questions that all have
the same shape: *what does the HRIS actually return for a field we did not ask
for?* They are unanswered because BambooHR and Workday are customer-owned. We
can read what a tenant exposes; we cannot create an employee, blank an
`Employee #`, or watch what comes back. Production holds one `entra-id`
connection and one `MANUAL` employee, so "check against a real tenant" names an
instruction nobody can follow.

OrangeHRM is self-hostable, so its HR side is writable. This adds it as a
provider — deliberately as a **test fixture with a real API**, not a product
surface.

```
providers/orangehrm/
  host.ts    → assertOrangeHrmHost — delegates to ORANGEHRM_HOSTS in allowed-host.ts
  token.ts   → one POST: OAuth2 client-credentials, minted per run, nothing persisted
  roster.ts  → paginated resumable read + normalise + mapOrangeHrmStatus
  index.ts   → OrangeHrmProvider (ScheduledCheckProvider + HrisSyncProvider)
```

Structurally it is `providers/workday/` with the token lifecycle removed:
client-credentials has no refresh token, so nothing rotates and
`HrisSyncDeps.persistSecret` is deliberately unused. Pagination, the
`readDeadlineAt` budget, the short-page-outranks-the-deadline ordering and the
resume-cursor contract are Workday's, because the HRIS usecase reads
`complete` / `resumeToken` identically for every provider.

### The one substantive departure: an all-dropped roster is REFUSED

The field names in `OrangeHrmEmployeeRow` come from OrangeHRM's published v2
PIM payload and **have never met a live instance** — which is the premise of
the issue, not a shortcut taken under it. The work email is the field most
likely to be wrong: OrangeHRM exposes contact details under
`/pim/employees/{empNumber}/contact-details`, and whether `workEmail` also
rides the list response is exactly the class of question Open Question 2 asks.

Guessing it wrong is not a quiet no-op. `normalise` drops a row with no work
email, so a wrong field name yields `{ employees: [], complete: true }` — and
on any run after the first of a pass `passSawRows` is already true via
`syncPassStartedAt`, so the departure reconcile fires and marks everyone it has
not touched TERMINATED. TERMINATED is what makes an employee a candidate for a
real directory disable at 05:00.

So `readOrangeHrmRoster` throws when the API returned rows and NONE normalised.
Scoped to the whole run, not one page — a page of contractors with no work
email is an ordinary roster.

### The first provider where `hrisRecordId` is known by construction

OrangeHRM carries two identifiers and they go to the two different fields
`NormalizedEmployee` gained in #2549:

| OrangeHRM field | What it is | Maps to |
| --- | --- | --- |
| `empNumber` | internal primary key — what `/api/v2/pim/employees/{empNumber}` takes | `hrisRecordId` |
| `employeeId` | administrator-typed badge number; the analogue of BambooHR's `employeeNumber` | `externalId` |

That split is the fixture's substantive contribution. BambooHR sets
`hrisRecordId` from `r.id`, whose presence on rows that did not request the
field IS Open Question 2 — unresolved, and unresolvable without a tenant to
check. Workday has no row id and correctly leaves it null. OrangeHRM publishes
`empNumber` as a first-class field of the list payload, so a write-back pass
rehearsed against this fixture has a subject that is not a guess.

`hrisRecordId` is null without `empNumber` — never a fallback to the badge
number or the work email, because an update addressed by work email would be
addressed by the value the write-back exists to create (Decision 3 of the
design doc). Mutation-proved: adding that fallback reddens the test that names
it.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/integrations/providers/orangehrm/index.ts` | Provider class; carries the "test fixture, not supported" statement in the docblock AND in `displayName` / `description` / `setupGuide` |
| `src/app-layer/integrations/providers/orangehrm/roster.ts` | Paginated resumable read, status mapping, the all-dropped refusal |
| `src/app-layer/integrations/providers/orangehrm/token.ts` | Client-credentials exchange; no token lifecycle by construction |
| `src/app-layer/integrations/providers/orangehrm/host.ts` | Delegates to the one host allowlist both request paths and config validation read |
| `src/app-layer/integrations/allowed-host.ts` | `ORANGEHRM_HOSTS` — vendor-operated estate only; see Decisions |
| `src/app-layer/integrations/config-schema.ts` | `orangehrm.baseUrl` as `vendorOrigin` against the same list |
| `src/app-layer/integrations/http-resilience.ts` | Two suffixes so the traffic labels `orangehrm`, not `other` |
| `src/app-layer/integrations/bootstrap.ts` | Registers it — the sync resolves providers through the registry |
| `src/app-layer/integrations/providers/hris/index.ts` | `HRIS_PROVIDERS` gains `orangehrm` |
| `src/app-layer/usecases/integrations.ts` | `PROVIDER_CATEGORY` gains `orangehrm` and `workday` |
| `docs/sub-processors.md` | Inventory row, marked as an internal fixture |

## Decisions

- **It is in `HRIS_PROVIDERS`, and that is a safety decision rather than a
  registration detail.** Leaving a fixture out of the allowlist is the tempting
  way to keep it out of everyone's way; it would also have taken it outside
  `assertSoleEnabledHrisConnection` (#2500). The departure reconcile is
  tenant-scoped, so an enabled fixture beside an enabled real HRIS alternates
  nightly and each pass marks the other's whole roster TERMINATED. The
  practical cost, stated in the module docblock: a rehearsal tenant cannot have
  both enabled at once — disable one first.

- **It is registered in `bootstrap.ts`, so it appears in the connector list.**
  `usecases/hris-sync.ts` resolves providers via `registry.getProvider`, so an
  unregistered provider cannot be exercised end to end, which is the only thing
  this one is for. There is no "internal" flag on `IntegrationProvider`, so the
  disclaimer lives in `displayName` / `description` / `setupGuide` — the only
  places an operator reads. Adding such a flag and filtering
  `listAvailableProviders` is a product-surface change and is left to whoever
  owns that surface.

- **`ORANGEHRM_HOSTS` covers only what OrangeHRM operates, and the self-hosted
  case is therefore an explicit follow-up.** The alternative — classifying
  `baseUrl` as customer infrastructure the way Active Directory's `url` is —
  hands any `admin.manage` holder a fetch primitive aimed at an arbitrary https
  host from inside the worker. AD survives that classification because it binds
  over LDAPS and adds a connect-time private-address assertion; a plain HTTPS
  roster read has neither. Admitting a self-hosted instance is a reviewed
  one-line suffix addition once somebody picks the domain — and that same diff
  must add the suffix to `PROVIDER_BY_HOST_SUFFIX`, or the instance's traffic
  labels `other` while the metric-label guard goes on passing.

- **`workday: 'hris'` was added to `PROVIDER_CATEGORY` alongside the new
  entry.** Workday was falling to `other`; leaving the real integration
  mis-grouped while the fixture grouped correctly was not defensible in the
  same diff.

- **`CONFIG_FIELD_RULES` keys by PROVIDER ID, and BambooHR's entry does not.**
  Its key is `hris` (the directory name) while `validateProviderConfig` is
  called with `bamboohr`, so BambooHR's `subdomain` rule has never run. Noted
  beside the new entry rather than fixed here: changing which provider ids that
  table covers is a write-boundary change of its own, and a key whose rules
  have never run is likely to reject config that already exists.
