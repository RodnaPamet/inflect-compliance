# `eslint-rules/` — this repo's own ESLint rules

CLAUDE.md's guard policy says:

> If the rule is structural — a banned import, a required prop, a forbidden
> identifier, a naming convention — write an **ESLint rule** instead. An AST
> rule survives reformatting and renaming; a regex over source text does not.

Until this directory existed there was nowhere to put one, so the policy was
unfollowable and every structural rule landed as another `readFileSync` +
regex under `tests/guards/`. This is that somewhere.

## Layout

```
eslint-rules/
  index.js                          the plugin object, registered as `local`
  rules/<rule-name>.js              one rule per file
  __tests__/<rule-name>.test.ts     RuleTester, run by Jest's `node` project
```

`eslint.config.mjs` imports `index.js`, registers it as the `local` plugin, and
turns each rule on by its `local/<rule-name>` id.

## Module format: CommonJS `.js`, and it is not a free choice

`package.json` declares no `"type"`, so a `.js` file here is CommonJS. All
three consumers can load it: `eslint.config.mjs` (ESM) imports it through
Node's CJS/ESM interop, Jest's CommonJS `node` project requires it, and
`eslint .` loads it the same way as the config.

Both alternatives were tried and both fail:

| Format | What happens |
| --- | --- |
| `.mjs` | TypeScript treats a `.mjs` file as ES-module format unconditionally and will not downlevel it to CommonJS. ts-jest hands Jest untransformed `export` syntax and every rule test dies with `SyntaxError: Unexpected token 'export'` — the rules become untestable, which defeats the point. |
| `.cjs` | `eslint.config.mjs` applies the `react-hooks/*` rules to all files, but `eslint-config-next` only registers the `react-hooks` plugin for its own scope, which excludes `.cjs`. The Lint job fails with "could not find plugin react-hooks". Same reason every build script under `scripts/` is `.js` or `.mjs`. |

## When a rule belongs here rather than in `tests/guards/`

Write an ESLint rule when the thing you are policing is **syntax**: a banned
call, a required prop, a forbidden identifier, a shape of expression. The AST
survives renaming, reformatting, comment edits and helper extraction; a regex
over source text survives none of those, and the failure mode is silent —
`tests/guards/detail-page-back-prop-ban.test.ts` needs a hand-rolled
`stripComments()` helper purely so a doc-block mentioning the banned prop does
not fail the build.

Keep it in `tests/guards/` when the assertion is about something ESLint cannot
see from inside one file: a registry that must stay in sync with a directory
listing, a count or budget across the tree, a Prisma schema invariant, a
cross-file coverage claim.

**Prefer a `no-restricted-syntax` selector in `eslint.config.mjs` over a rule
file** when one esquery selector says the whole thing — that is how the
clipboard and native-date-input bans are expressed today, with no rule file at
all. Reach for `rules/` when the check needs more than a selector: scope
resolution, cross-node reasoning inside the file, a computed message, options.

## Adding a rule

1. Write `rules/<name>.js`, exporting an ESLint `RuleModule`
   (`meta.type`, `meta.docs`, `meta.schema`, `meta.messages`, `create`).
2. Register it in `index.js`.
3. Add `__tests__/<name>.test.ts` using ESLint's `RuleTester`, with **both**
   `valid` and `invalid` arrays. An invalid-only suite passes against a rule
   that flags everything — every narrowing the rule performs needs a `valid`
   case that would go red if the narrowing broke.
   Call `ruleTester.run(...)` directly in the `describe` body, never inside an
   `it(...)`: ESLint 9's RuleTester emits its own `describe`/`it` per case and
   nesting it fails with "Tests cannot be nested".
4. Turn it on in `eslint.config.mjs`.
5. Run `npm run lint` over the whole repo before choosing a severity. If the
   rule flags existing code, that is a calibration signal — decide whether the
   flags are true positives (fix them, or land at `warn` with a plan) before
   landing at `error`.

## Rules

### `no-fail-open-teardown-filter`

Flags a `deleteMany` / `updateMany` inside an `afterAll` / `afterEach` hook
whose `where` filter reads a **bare `let`** (declared with no initializer),
unless the call sits inside an `if` / `&&` / ternary that tests the same
variable.

**Why.** Jest runs `afterAll` even when `beforeAll` threw, so a fixture id held
in a bare `let` is still `undefined` in teardown on every setup failure — and
Prisma DROPS an undefined filter value rather than rejecting it. Measured on
this repo's own client against the test database (see the note in
`tests/integration/db-helper.ts`):

```
user.count()                                        -> 306   (every row)
user.count({ where: { id: undefined } })            -> 306   (every row)
user.count({ where: { id: 'no-such-id' } })         ->   0
user.count({ where: { id: { in: [undefined] } } })  -> throws
```

So the unguarded teardown is `DELETE FROM "User"` with no predicate against a
database every other suite in the run is sharing. It does not throw — it
SUCCEEDS, so the surrounding `try { … } catch` is no protection and the run
stays green. It fails OPEN, the opposite of the intuition that an undefined
filter matches nothing. Fourteen sites were fixed by hand across #2113 and
#2114 with nothing stopping the sixteenth.

**What it cannot see.** Whether a variable is assigned on every path reaching
the `deleteMany` is a data-flow fact, and this rule does no data-flow analysis
at all. It matches a syntactic shape:

- It does not know whether `beforeAll` can actually throw, so it flags
  teardowns that are fine in practice.
- It does not track assignments — `let id; id = 'x';` at module scope is still
  a bare `let` to it.
- It recognises exactly one guard shape: the call in the truthy branch of an
  `if` / ternary that tests the same variable, or on the right of an `&&` that
  tests it. **An early return (`if (!id) return;`) is a correct guard and the
  rule flags it anyway**, because recognising it needs statement-order
  reasoning the rule deliberately does not do.
- It only inspects `Identifier` filter values. `where: { id: fixture.id }` and
  `where: { id: getId() }` are invisible to it, so a green rule is **not** a
  proof that a teardown is safe.

Those biases point the same way on purpose — flag something fine rather than
stay quiet about something that is not, because a false positive costs one
`if (…)` and a false negative costs a table in a shared database.

But **"the rule fails CLOSED" is not true as an absolute**, and the first
version of this file said it was. Three shapes were measured failing OPEN and
have since been fixed: a negated guard (`if (!x) { … }`, strictly *worse* than
no guard, since the delete then runs exactly when the filter is undefined), an
`AND` / `NOT` combinator array, and `where: <bare let>`. The two bullets above
are what remains open. A green rule proves this one syntactic shape is absent —
not that the teardown is safe.

**One shape it deliberately leaves alone, and the line is narrower than it
looks.** `where: { id: { in: [a, b] } }` — an array literal of SCALARS — is
already safe, because Prisma validates array members and throws on an undefined
element. An array literal of OBJECTS is not: `{ AND: [{ id: undefined }] }`
matched every row of 331 when measured, so combinator arrays are recursed into
and flagged. `where: { id: { in: ids } }`, where the
identifier stands for the whole array, is **not** safe and IS flagged: an
undefined array is dropped exactly like a bare scalar. There is no live
instance of that in the repo; #2114 wrote the trap down precisely because
spot-checking the two safe `in` shapes leads to the wrong conclusion that
wrapping in `in` is the protection.

**The fix**, and the idiom already on main:

```ts
afterAll(async () => {
    if (tenantA) {
        await prisma.risk.deleteMany({ where: { tenantId: tenantA } });
    }
});
```
