# 2026-08-22 — the runner stops fetching a CLI it already has

**Commit:** `(this branch) fix(deploy): run the installed prisma CLI instead of fetching one`

## Design

`scripts/entrypoint.sh` ran `npx --yes prisma@7.8.0 migrate deploy` at every
container start. `prisma` is a **production** dependency at `^7.9.1`, so the CLI
was already in the image — but an explicit npx version that differs from the
installed one sends npx to the registry. Every boot downloaded and tar-extracted
a second, **older** copy of the CLI.

Not inferred. The artefact was on the running production container:

```
/home/nextjs/.npm/_npx/35bbd8b17918daaa/node_modules/prisma
```

The line now runs `./node_modules/.bin/prisma`, the same way the script already
ends with `exec node_modules/.bin/next start`.

## What made this worth doing now

CVE-2026-73566 (HIGH) — node-tar DoS via a crafted long-path archive, affecting
tar 7.5.19. The only tar in the runner is the global npm CLI's bundled copy, and
**tar extraction during that npx fetch was the one thing reaching it.**

No npm release fixes it. npm 12.0.2 (newest) still vendors tar 7.5.19 despite
7.5.21 shipping a month earlier, because bundled dependencies freeze at publish
time — so npm's own `^7.5.19` range never re-resolves. The repo's `tar` override
is already `^7.5.21` and is inert for exactly that reason.

## Proved before changing a production deploy path

Read-only, against the live production image and database:

| check | result |
|---|---|
| `node_modules/.bin/prisma` present | symlink → `../prisma/build/index.js` |
| version | **7.9.1**, matching `@prisma/client` |
| `migrate status --schema=./prisma/schema` | loads `prisma.config.ts`, resolves the multi-file schema, connects, reads all 255 migrations, reports up to date |

That exercises every step `migrate deploy` performs except the apply. The old
comment's worry — that the CLI would reject a Prisma 7 schema — was about the
5.22.0 pin it replaced; 7.9.1 handles it.

## Files

| file | role |
|---|---|
| `scripts/entrypoint.sh` | the one-line change, and why |
| `.trivyignore` | CVE-2026-73566, with reasoning that is conditional on the above |
| `tests/guards/runner-never-invokes-npm.test.ts` | enforces the exemption's premise |

## Decisions

- **The pin was drifting and its comment said the opposite.** The comment read
  "pin the CLI version to match `@prisma/client` in package.json" while pinning
  `7.8.0` against a declared `^7.9.1` — so it fetched an *older* CLI than the one
  present. Using the local binary makes the match structural rather than
  asserted, which is the only kind that cannot drift.

- **The exemption is conditional, and the condition is enforced.** Removing the
  fetch removes *reachability*, not the Trivy finding: the scanner reads the
  image, and the global npm stays in it. So the `.trivyignore` entry is still
  needed — but its justification ("nothing at runtime invokes npm") is true only
  because of this change. A justification that depends on a condition nothing
  checks is the exact failure this repo keeps finding, so
  `runner-never-invokes-npm.test.ts` fails if the entrypoint reverts. Mutation-proved.

- **The neighbouring exemption's reasoning did not transfer.** The undici entry
  says "the server runs `next start`, never the npm CLI". That was true for
  undici and **false for tar** at the time of writing, because of the npx fetch.
  Copying it would have put a false justification in the file. Reachability had
  to be checked, not pattern-matched from the entry above.

- **Not removing the global npm from the image.** It would not remove tar — the
  `node:24-alpine` base ships its own npm — and it is a larger change to the
  build for no additional gain here.
