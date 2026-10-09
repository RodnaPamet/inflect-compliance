# 2026-10-09 — Mapping UI and suggestions (Step 2b)

**Commit:** `(pending) feat(legacy-access): mapping UI and suggestions (Step 2b)`

## Design

An administrator maps a legacy application's columns onto the canonical schema,
guided by suggestions, **without ever seeing a raw sample value**.

```
POST /admin/legacy-access/profile
        │
        ├─ probeManifest()            ── column NAMES only
        │     └─ filter: isDeniedColumn  ── the projection
        │
        ├─ profileFirstPage({ fields })  ── ONE page, stripped, named
        │
        ├─ computeColumnProfiles(rows)   ── counts + shares; rows discarded HERE
        │     └─ mayExposeValueSet       ── the only path a value takes onward
        │
        └─ suggestMapping(profiles)      ── name synonyms + statistics
                │
                ▼
        LegacyAccessMappingCard          ── DataTable + Combobox + FormField
                │
        PUT /admin/legacy-access/mapping ── explicit, versioned, audited diff
```

## Files

| File | Role |
| --- | --- |
| `src/lib/legacy-access/mapping-suggest.ts` | Pure: synonyms, the statistics→field rules, `mayExposeValueSet` |
| `src/lib/legacy-access/profile.ts` | Rows → statistics, and the gate on exposing a value set |
| `src/lib/mcp/client/index.ts` | `profileFirstPage` — manifest plus page one, stopping deliberately |
| `src/app-layer/usecases/legacy-access-profile.ts` | Two-step read, the provider guard, denied columns shown as unmappable |
| `src/app-layer/usecases/legacy-access-mapping.ts` | `diffMappings` for the audited diff |
| `src/lib/legacy-access/canonical.ts` | `confirmedColumns` + `diffColumnSets` for drift |
| `.../[connectionId]/LegacyAccessMappingCard.tsx` | The screen |
| `messages/{en,bg}.json` | 53 keys each |

## Decisions

- **The brief contains a tension and the threshold resolves it.** "The UI shows
  profile statistics only, never a raw sample value" and "a value-map editor for
  the status column" cannot both hold literally — you cannot ask somebody to map
  `A` onto `ACTIVE` without showing them `A`. So values are exposed only when the
  profile PROVES they are a vocabulary: at most 12 distinct, at least 20 non-null
  rows, each value recurring at least 4× on average, and no value that looks like
  an email. The consequence worth having is that a high-cardinality identity
  column — names, emails, employee numbers — **can never qualify at any sample
  size**, because it fails the repetition floor however the sample is chosen.
  Asserted across sample sizes from 20 to 50,000.

- **The gate lives server-side and the component cannot override it.** A column
  that did not qualify arrives with no `valueSet` at all, so the card has nothing
  to render even by mistake. The rendered test asserts both directions: no
  identity value in the DOM, and the vocabulary IS shown — the second is the
  denominator, without which the first would pass for a component that drew
  nothing.

- **A hash cannot be diffed.** 2a stored only `columnSetFingerprint`, so a drift
  refusal could only say "something changed" — asking somebody to re-confirm a
  mapping they had no way to review. The mapping now also stores
  `confirmedColumns`, OPTIONAL so 2a-era mappings keep pulling, and
  `diffColumnSets` reports `indeterminate` for them rather than an empty diff:
  "I cannot tell what changed" must not render as "nothing changed" on the one
  screen whose job is to justify re-confirmation. `assertMappingUsable` refuses
  names that do not hash to the stored fingerprint, because a screen explaining a
  refusal with the wrong columns is worse than one showing nothing.

- **`profileFirstPage` is not `pullSnapshot` with a cap.** Every cap in the
  transport THROWS — `maxPages: 1` raises before a page is requested — which is
  right for a snapshot, where a partial read must never pass as a population.
  One page is the CONTRACT for a profile, and `truncated` says more exist.

- **Two round trips, deliberately.** `probeManifest` to learn the names, then the
  page read with the non-denylisted subset as an explicit projection. One call
  would do if the transport applied the denylist — and it must not; that is
  product policy, like `LEGACY_SNAPSHOT_MAX_ACCOUNTS` and the oversharing
  severity rule. Saving a handshake is not worth the transport deciding anything.

- **Profiling requests MORE columns than a pull, and that is safe.** A pull asks
  for the mapped columns; a profile asks for every non-denylisted one, because you
  cannot map a column you were never shown. The denylist is what keeps it from
  being a widening — the sensitive names are excluded at both stages.

- **A denylisted column is SHOWN, as present and unmappable.** Omitting it leaves
  an administrator wondering where `PASSWORD_HASH` went; profiling it is what the
  denylist prevents. So it appears with every statistic zero and `denied: true`.

- **Suggestions never auto-save.** Reading pre-selects the suggested target per
  column, which is a convenience; the state is local until Save. Accepting every
  suggestion at once still takes the press.

- **The name beats a disagreeing profile**, with a note saying so. A column called
  `EMAIL` holding mostly nulls is still the email column: statistics describe the
  data, the name describes the intent. And nothing suggests `accountKey` from
  shape alone — the primary key of the whole snapshot is not a thing to guess at;
  `username` is the recoverable version of the same guess.

- **The engine refuses to infer a convention from the data**, consistent with
  Step 4a: `proposeConventions` measures and a human adopts, because fitting a
  rule to the population being examined explains away the anomalies the product
  exists to find.

## Two traps worth recording

- **`new Date('7')` is a valid date in V8**, so a column of small integers reads
  as 100% dates and would be suggested as `createdAt` — the field that drives the
  temporal veto. The detector pattern-matches first and parses second.

- **`Response` is not usable in this jsdom environment.** Constructing one inside
  a fetch mock throws *inside the component's own try/catch*, which renders as
  "the profile failed" with no hint that the mock was at fault. The house pattern
  is a plain `{ ok, status, json }`.
