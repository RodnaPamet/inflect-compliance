# Reading the vendored OpenShell skills in THIS repository

Local guidance, written here rather than inside vendor text so a re-pin stays a
clean diff. See `VENDORED.md` for the pin and the hash manifest.

All six vendored files were read in full before merge, which `#3968` requires
because once merged they are instructions to every Claude Code session working
on this repository. The review verdict and the three findings are below.

## Verdict: the text is good, and argues for tighter controls

Across ~227 KB these skills repeatedly refuse the weakening repair, which is the
behaviour you want from text an agent will follow. A sample, quoted:

- "Never broaden endpoint policy merely to silence a credential binding error"
- "do not add `allow_uninspected_credentials` merely to bypass a startup error"
- "Do not add capabilities or switch to an unconfined seccomp profile"
- "never repair a denial by issuing operator certificates to ordinary users"
- "Do not automatically label control-plane resources or disable enforcement as a repair"
- "do not persist or recommend insecure verification for shared gateways"
- "never print the bootstrap bundle or private key"
- "do not infer enforcement from the gateway accepting the update"

No prompt-injection shapes, no instruction-override phrasing, no secret-shaped
strings, and no pipe-to-shell anywhere in the six files.

## Finding 1 — `best_effort` is taught as a "sensible default". IT IS NOT ONE HERE.

`generate-sandbox-policy/SKILL.md` and its `examples.md` both scaffold a new
policy file with:

```yaml
landlock:
  compatibility: best_effort
```

and the surrounding prose calls the `filesystem_policy` and `landlock` sections
"sensible defaults". **`hard_requirement` appears zero times in any of the six
vendored files.**

That conflicts with three things at once:

1. Phase 5 requires every committed policy to set `enforcement: enforce` and
   Landlock `compatibility: hard_requirement`, **checked mechanically in CI**. A
   policy generated from this scaffold is rejected by our own gate.
2. The phase-3 `agent-sandbox-policy-review` skill exists to report that a
   `best_effort` ruleset is NOT confinement — it may have applied in part, or
   been dropped whole (upstream issue #664 reports the entire ruleset abandoned
   when one path does not exist).
3. NVIDIA's own security best-practices page recommends `hard_requirement`.

**So when authoring a policy for this repository, override the scaffold:** set
`compatibility: hard_requirement`, and expect the gateway to refuse to start
without the kernel support rather than silently skipping paths. That refusal is
the behaviour we want. Landlock ABI was measured at 8 on the development host;
a Debian 12 target would give ABI 3, which has no network rules.

## Finding 2 — two paths fetch remote content INTO security configuration

Both are mitigated by the skills' own review language, and both remain
injection surfaces worth knowing about:

- `generate-sandbox-policy` has an "Auto-Discovery of API Docs" step that tells
  the agent to web-search for a service's API documentation, fetch the page, and
  parse its endpoint inventory into policy rules. A hostile or wrong doc becomes
  policy input. The skill does ask the user first and falls back gracefully.
- `openshell-cli` documents `openshell profile lint --url` and
  `profile import --url`, which pull a **provider profile** — a document that
  grants endpoints and binaries — from an arbitrary HTTPS URL. The skill says
  "Review its endpoint and binary grants before importing it" and notes the
  1 MiB / 15 second limits.

**Treat generated policy as a proposal to review, never as output to apply.**
That is already this repository's posture for agent-authored rules.

## Finding 3 — every documentation link points at `latest`, not at the pin

All ~30 `docs.nvidia.com` URLs in the vendored text use `/latest/`. The text is
pinned at `v0.1.6`; the documentation it sends you to is not. The spike note
records that docs versioning (`v0.0.116`) and release versioning (`0.1.x`) are
two different spaces, so a `latest` link can describe a release these skills
were never written against.

## What these skills are NOT

They are not part of the Flue skill corpus and the loader would refuse them:
each is several times `MAX_SKILL_BYTES`, none carries a `license` field, all
link to vendor documentation (`skill.fetchable_url`), and none has the
`requiredInput` / `output` / `controls` / `evaluation` metadata or an evaluation
record the mount gate demands. `src/lib/agentic/flue/skills/` is a different
population with a different contract.
