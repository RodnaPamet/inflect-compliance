# Vendored OpenShell Agent Skills

Four Agent Skills copied from NVIDIA/OpenShell. They teach a **coding** agent to
drive the `openshell` CLI, author sandbox policy, and debug a gateway. They are
developer tooling: the product runtime never loads them, and no product code,
workflow, or Flue skill references them.

## The pin

| | |
| --- | --- |
| Source | https://github.com/NVIDIA/OpenShell |
| Commit | `ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47` |
| Tag | `v0.1.6` (2026-10-27) |
| Upstream path | `skills/` |
| Licence | Apache License 2.0 — text in `LICENSE-Apache-2.0.txt` |
| Vendored | 2026-10-29 |

The commit is pinned deliberately. `npx skills add NVIDIA/OpenShell` fetches
whatever is on NVIDIA's main branch at that moment, which would make these
skills describe a gateway other than the `v0.1.6` one this repository pins in
phase 0. Re-pin by changing the commit above and re-running the manifest.

Upstream ships **no NOTICE file** at this commit, so there is no upstream NOTICE
content to carry over. Attribution is in this repository's `NOTICE`.

## Manifest — SHA-256 of every vendored file

`tests/guardrails/vendored-openshell-skills.test.ts` recomputes these offline
and fails if any file drifts, so a local edit to vendor text turns CI red.

| SHA-256 | Bytes | File |
| --- | --- | --- |
| `58503cbebb6dae8d4856224d4d570b50f2c0163564321c8bf15c946c9036b47f` | 7524 | `debug-inference/SKILL.md` |
| `4a56225e7558f84a25814e21edd6f2b57c3419c451c1c71e30114582386e3bc1` | 111991 | `debug-openshell-cluster/SKILL.md` |
| `2401f6881db3c072aa0100d54bbc04cdfe183a55e5253aa3d91c2e6e44fd102e` | 9235 | `debug-openshell-cluster/references/supervisor-middleware.md` |
| `2a692a47770ddc1b7fe163620f25d11599a2cdf4a020a7d1533ee68641c4dab8` | 37388 | `generate-sandbox-policy/SKILL.md` |
| `60a3912debe46b70f2a7ec38ae88275223db1d312f21646194d580cbc4c8dc02` | 24569 | `generate-sandbox-policy/examples.md` |
| `6572a8b6daa093337ec0d5f565ded5265c2674b0d891fb28e5e60d4cd885caef` | 53791 | `openshell-cli/SKILL.md` |
| `d07c0367e2861e7fe70fa1b679f879f4fa2f9138ade4457d44ecf8b2e135bb45` | 11431 | `LICENSE-Apache-2.0.txt` |

## Vendored byte-for-byte

No edits. A re-pin is therefore a clean diff against upstream rather than a
three-way merge against local changes. Every file above was additionally checked
against GitHub's own git blob SHA at the pinned commit, which verifies the
content independently of how it was downloaded.

**Local guidance goes in `OPENSHELL-LOCAL-NOTES.md`, never inside vendor text.**
That file records where this repository's standards differ from what these
skills teach — read it alongside them.
