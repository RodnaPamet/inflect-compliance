# Vendored Powerpipe control-id snapshots

Each `<cloud>.txt` is the sorted, de-duplicated set of control names
**reachable from that mod's `all_controls` benchmark** — the root the collectors
run (#3434). They exist so a guard can answer **offline** the question that
broke in #3434: *will the run we actually perform emit this control?*

Reachability, not declaration, is the right population. A control can be
declared and still never appear in our output: Azure declares
`iam_user_with_owner_permission_on_subscription_mfa_enabled`, but only the
HIPAA / NIST / PCI benchmarks include it, so under `all_controls` it is a dead
row. Snapshotting declarations would have called that mapping valid.

The crosswalks were authored from an idea of what the controls were called —
"ORIGINALLY authored against IC's OWN library codes ... no mod HCL/SQL
transcribed" — and 13 of 24 ids named nothing real. The existing map-validity
tests checked the crosswalk's RIGHT-hand side (SOC 2 / NIST codes resolve to a
real IC requirement) and never its LEFT-hand side.

These are **names only** — no HCL, no SQL, no titles, no mappings — so the
license tripwire in `tests/guards/aws-posture-connector.test.ts` stays satisfied.

## Provenance

| file | mod | version | reachable |
| --- | --- | --- | --- |
| `gcp.txt` | `turbot/steampipe-mod-gcp-compliance` | v1.3.2 | 202 controls |
| `azure.txt` | `turbot/steampipe-mod-azure-compliance` | v2.5.2 | 476 controls |
| `aws.txt` | `turbot/steampipe-mod-aws-compliance` | v1.13.1 | 679 controls |

All three clouds are covered as of #3439. The guard still prints which clouds
it covered — read that denominator rather than assuming, and it asserts the
UNCOVERED list is empty so a fourth cloud without a snapshot reddens rather
than quietly lowering the fraction.

## Refreshing

    git clone --depth 1 --branch <tag> https://github.com/turbot/steampipe-mod-<cloud>-compliance

Then walk `benchmark "all_controls"` transitively through its `children`
(`benchmark.*` and `control.*` refs) and write the sorted control names. A
`grep` for every declared `control "<id>"` is NOT equivalent — see above.

A refresh that REMOVES an id our crosswalk maps will redden the guard — that is
the point: upstream renames a control (it has, repeatedly) and the crosswalk
silently stops matching anything. Update the table above when you refresh.
