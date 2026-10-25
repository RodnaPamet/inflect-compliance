# 2026-10-25 — External MCP tool names refuse control and invisible characters

**Commit:** `fix(mcp): refuse an external tool name carrying control or invisible characters`

## Design

#4238 bounded an advertised tool name's LENGTH at `listTools`, the one reader
every name enters through. This change makes the same reader refuse one more
kind of name, with the same refusal and the same count.

A name is refused when it holds any code point in:

| class | what it is | why it is refused |
|---|---|---|
| `Cc` | C0 and C1 controls, `DEL`; includes `\n`, `\r`, `\t`, `NUL` | a line break forges a log line; `NUL` and its kin break the stores downstream |
| `Zl`, `Zp` | U+2028, U+2029 | line breaks that are not `\n` |
| `Cf` | format characters: bidi overrides and isolates, `LRM`/`RLM`, zero-width space and joiners, `BOM`, soft hyphen, tag characters | change how a name READS without changing what it IS |
| `Default_Ignorable_Code_Point` | everything Unicode says renders as nothing: the `Cf` set above plus variation selectors, Hangul fillers, `CGJ` | the same, for code points outside `Cf` |
| `Cs` | a lone surrogate | not a character at all; encoded to UTF-8 it becomes U+FFFD, so two different names would store as one |

Every other printable character is accepted, including `/`, `:`, spaces,
accented letters, CJK and plain emoji. A real server may already use those, and
refusing a name hides that tool from the catalogue and makes any grant or pin
on it unreachable.

The owner chose this scope on 2026-10-25 over the two alternatives: the
specification's recommended set (`A-Z a-z 0-9 _ - .`), and counting
without refusing.

## Files

| File | Role |
|---|---|
| `src/app-layer/integrations/mcp/client.ts` | `UNSAFE_NAME_CHARACTER` and the widened `isUsableToolName` |
| `messages/{en,bg}.json` | The catalogue notice gives the new reason |

## Decisions

- **One count, not one per reason.** The operator's next step is the same
  either way: the server owner has to rename the tool. A breakdown would also
  have to be kept in step with this list.
- **A union of classes, not one property.** `Default_Ignorable_Code_Point` is
  most of what "invisible" means. A visible `Cf` character, such as an Arabic
  number sign, is refused too, because `Cf` is what holds the bidi controls.
  Neither class covers `Cc` or a lone surrogate.
- **An emoji with a variation selector or a ZWJ sequence is refused.** Both
  carry a default-ignorable code point. That costs little for a tool name, and
  exempting them would mean writing an emoji grammar.
- **Not normalised, and no homoglyph check.** A precomposed `é` and `e` plus
  U+0301 still read alike, and so do Cyrillic `а` and Latin `a`. Both are
  visible text, and refusing them is a different decision with a much wider
  effect.
- **A pin under a name refused now** becomes unreachable at the next read,
  exactly as with #4238's length bound; the runtime log line
  `mcp.external_tool_names_refused` is the trace.
