# 2026-07-25 — Override advisory verification

**Commit:** _(uncommitted at time of writing)_ — extends the override
governance added in `2026-07-22-table-identity-and-override-decay.md`.

## Design

The override governance had two halves: an offline Jest guard proving
each override BITES, and a weekly script proving the lockfile is not
behind the range. Both trusted the registry's *content* completely.

Check A validated an advisory id with `/^(GHSA-|CVE-)/` — a shape
test. Nothing checked that the id was real, described the package it
was filed under, or was fixed in the version recorded as
`patchedFrom`. Four entries were wrong at once and all four were
green:

| Entry | Recorded | Reality |
|---|---|---|
| `picomatch` | GHSA-2p57-rm9w-gvfp | an `ip` SSRF advisory — wrong package entirely |
| `tmp` | GHSA-52f5-9888-68mp | does not exist |
| `protobufjs` | GHSA-h755-8qp9-cq85 | real, patched 6.11.4 / 7.2.5 — cannot justify an 8.x floor |
| `@grpc/grpc-js` | GHSA-7v5v-9h63-cj86 | real, patched 1.8.22 / 1.9.15 / 1.10.9 — cannot justify a 1.14.4 floor |

Verifying any of that needs the advisory database, so it belongs in
the network half. The script now performs two additional checks per
security override:

```
ADVISORY  recorded id does not resolve · covers a different package ·
          its real first_patched_version disagrees with patchedFrom

FLOOR     the override's own floor version is STILL inside some
          advisory's vulnerable range — the pin no longer excludes
          anything
```

`FLOOR` generalises a defect found three times by hand the same day
(`hono` ^4.12.25 vs a 4.12.27 fix, `tmp` ^0.2.6 vs an advisory
affecting 0.2.6, `protobufjs` ^8.2.0 vs a fix in 8.6.6). In each case
the lockfile happened to sit on something patched, so `npm audit`
stayed green while the floor protected nothing.

Both checks run over EVERY security override including
`currentlyInert` ones — an inert floor's facts still have to be true,
because the floor is what governs the package if it returns.

To let a plain `.mjs` script read the same facts the TypeScript guard
asserts, the registry moved out to `tests/guards/override-registry.json`.
A script cannot import a Jest module (the `describe` calls would run),
so the alternatives were a second copy of the facts or a regex parse
of TypeScript — one drifts, the other fails silently.

## Files

| File | Role |
|---|---|
| `tests/guards/override-registry.json` | the registry, now data — one source, two readers |
| `tests/guards/overrides-effective.test.ts` | loads the JSON; adds a registry-size floor and a well-formedness check over ALL entries (check A only sees entries reachable from `overrides`) |
| `scripts/check-override-freshness.mjs` | advisory resolution + floor-vulnerability checks, `--self-test`, `GITHUB_TOKEN` support |
| `.github/workflows/override-freshness.yml` | blocking self-test step before the non-blocking report; token wired; issue body gains the two new sections |
| `docs/dependency-policy.md` | the two new decay modes and the check table |

## Decisions

- **Findings name the fix.** A wrong id otherwise leaves the reader to
  research the right one. Since the recorded *fixed version* is
  usually correct even when the id is wrong, the script reports the
  advisory whose `first_patched_version` matches `patchedFrom` —
  turning a research task into a one-line correction. It resolved
  `@hono/node-server`, `fast-uri` and `hono` automatically.

- **Unknown ranges return `null`, never `false`.** A range shape the
  comparator does not understand must read as "unknown" at the call
  site. Returning `false` would mean "not affected", i.e. silence —
  the exact failure this file exists to prevent.

- **`--self-test` is blocking; the report is not.** Every finding
  rests on two hand-rolled comparators, and one that always returns
  "not affected" reports a clean bill of health forever. The self-test
  earned this on day one: GitHub writes ranges as `>= 0.2.6, < 0.2.7`
  — with a space after the operator — which the first tokenizer split
  into bare operators, making every range unparseable and the entire
  FLOOR check silently inert. It reported zero findings and looked
  correct.

- **Escalation stays opt-in.** `--strict` now exits 1 on `advisory`
  and `floor` as well as `lagging`, but the scheduled job still
  reports rather than blocks. `npm audit` remains the merge gate: it
  blocks on evidence of a real advisory in the resolved tree, not on
  version arithmetic over a floor.

- **Registry as JSON, not a typed literal.** Cost: the entries lose
  compile-time checking of their shape. Mitigated by the new
  well-formedness test, which validates every entry in the file —
  including ones whose override has not landed yet, which the typed
  literal never did.
