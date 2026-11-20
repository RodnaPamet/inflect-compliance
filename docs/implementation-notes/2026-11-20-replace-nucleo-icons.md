# 2026-11-20 — Replace the Nucleo icon set with lucide-react (#5772)

## Design

`packages/ui/src/components/ui/icons/nucleo/` held 269 Nucleo icons and a
README carrying Nucleo's notice: redistribution is prohibited, and the icons
are restricted to the product they ship in. This repository is public, so the
set sitting in it is redistribution whatever licence Inflect's own code
carries (BUSL-1.1, and its Apache-2.0 Change License, cannot relicense a third
party's work). The owner confirmed Inflect holds no licence that permits a
public source tree, and chose option 2 of the issue: remove the set, replace
it with a permissively licensed one.

The replacement is `packages/ui/src/components/ui/icons/glyphs/`: one module
per local name, each a thin function over one lucide-react icon (ISC, already
a dependency of the app and of `@inflect/ui`):

```tsx
export function Plus(props: SVGProps<SVGSVGElement>) {
  return <LucidePlus size={18} {...props} />;
}
```

- **Same names, same prop type.** Every caller keeps its import names, and
  the prop type is the `SVGProps<SVGSVGElement>` the Nucleo functions took, so
  every slot typed `ComponentType<SVGProps<SVGSVGElement>>` (`NavGlyph`,
  `PaletteGlyph`, `EmptyStateIcon`, `Icon`) still accepts them. Import paths
  moved from `icons/nucleo` to `icons/glyphs`, nothing else at the call site.
- **Same size and weight.** Nucleo drew on an 18-unit grid at stroke 1.5 and
  rendered 18×18 by default. Lucide draws on 24 at stroke 2; at the 18px
  default each wrapper passes, that is 1.5px on screen. A caller's
  `className` (`h-4 w-4`, `size-4`) or `width`/`height` overrides the default
  exactly as before (lucide lets `width`/`height` beat `size`).
- **Only the names in use.** 105 of the 269 Nucleo exports were imported
  anywhere (directly, or through the `@/components/ui/icons` barrel); the
  other 164 had no caller and were not recreated.
- **Same bundling mechanism.** One module per glyph behind an `export *`
  barrel listed in `optimizePackageImports`, as the Nucleo barrel was, so
  Next rewrites a barrel import to the one module it names. Each module
  imports its lucide icon by name, and `lucide-react` is in the same list.

Git history still holds the removed files. Rewriting history is an owner
action and is out of scope here.

## Mapping

Weak matches are where lucide has no glyph with the Nucleo one's meaning; the
nearest meaning was chosen, not the nearest name.

| Local name | Module | lucide-react | Note |
|---|---|---|---|
| `ArrowLeft` | `arrow-left` | `ArrowLeft` |  |
| `ArrowRight` | `arrow-right` | `ArrowRight` |  |
| `ArrowTrendUp` | `arrow-trend-up` | `TrendingUp` |  |
| `ArrowUpRight` | `arrow-up-right` | `ArrowUpRight` |  |
| `BadgeCheck` | `badge-check` | `BadgeCheck` |  |
| `Bolt` | `bolt` | `Zap` |  |
| `Book2` | `book2` | `Book` |  |
| `BoxArchive` | `box-archive` | `Archive` |  |
| `BulletList` | `bullet-list` | `List` |  |
| `Calendar6` | `calendar6` | `CalendarDays` |  |
| `CalendarIcon` | `calendar` | `Calendar` |  |
| `CalendarRefresh` | `calendar-refresh` | `CalendarSync` |  |
| `ChartActivity2` | `chart-activity2` | `Activity` |  |
| `ChartLine` | `chart-line` | `ChartLine` |  |
| `Check` | `check` | `Check` |  |
| `Check2` | `check2` | `Check` |  |
| `CheckboxCheckedFill` | `checkbox-checked-fill` | `SquareCheck` | **weak:** outlined, not filled |
| `CheckboxUnchecked` | `checkbox-unchecked` | `Square` |  |
| `ChevronLeft` | `chevron-left` | `ChevronLeft` |  |
| `ChevronRight` | `chevron-right` | `ChevronRight` |  |
| `ChevronUp` | `chevron-up` | `ChevronUp` |  |
| `CircleCheck` | `circle-check` | `CircleCheck` |  |
| `CircleCheckFill` | `circle-check-fill` | `CircleCheck` | **weak:** outlined, not filled |
| `CircleDotted` | `circle-dotted` | `CircleDashed` |  |
| `CircleHalfDottedCheck` | `circle-half-dotted-check` | `CircleFadingCheck` | **weak:** near: half-faded ring |
| `CircleHalfDottedClock` | `circle-half-dotted-clock` | `ClockFading` | **weak:** near: half-faded clock |
| `CircleInfo` | `circle-info` | `Info` |  |
| `CirclePercentage` | `circle-percentage` | `CirclePercent` |  |
| `CircleQuestion` | `circle-question` | `CircleQuestionMark` |  |
| `CircleUser` | `circle-user` | `CircleUser` |  |
| `CircleWarning` | `circle-warning` | `CircleExclamationPoint` |  |
| `Cloud` | `cloud` | `Cloud` |  |
| `CloudUpload` | `cloud-upload` | `CloudUpload` |  |
| `ConnectedDots4` | `connected-dots4` | `Waypoints` | **weak:** connected waypoints |
| `Cube` | `cube` | `Box` | **weak:** box |
| `CurrencyDollar` | `currency-dollar` | `DollarSign` |  |
| `CursorRays` | `cursor-rays` | `MousePointerClick` |  |
| `DatabaseKey` | `database-key` | `DatabaseZap` | **weak:** no database-with-key glyph; the card is audit streaming |
| `Desktop` | `desktop` | `Monitor` |  |
| `Download` | `download` | `Download` |  |
| `Eye` | `eye` | `Eye` |  |
| `EyeSlash` | `eye-slash` | `EyeOff` |  |
| `FileContent` | `file-content` | `FileText` |  |
| `FileZip2` | `file-zip2` | `FileArchive` |  |
| `Flask` | `flask` | `FlaskConical` |  |
| `Folder` | `folder` | `Folder` |  |
| `Folder5` | `folder5` | `Folder` |  |
| `FolderBookmark` | `folder-bookmark` | `FolderBookmark` |  |
| `Gauge6` | `gauge6` | `Gauge` |  |
| `Gear` | `gear` | `Settings` |  |
| `Gear3` | `gear3` | `Cog` | **weak:** cog |
| `Gift` | `gift` | `Gift` |  |
| `Globe` | `globe` | `Globe` |  |
| `GridIcon` | `grid` | `LayoutGrid` |  |
| `GripDotsVertical` | `grip-dots-vertical` | `GripVertical` |  |
| `Hyperlink` | `hyperlink` | `Link` |  |
| `InvoiceDollar` | `invoice-dollar` | `Receipt` | **weak:** receipt with dollar |
| `Key` | `key` | `Key` |  |
| `License` | `license` | `Certificate` | **weak:** certificate |
| `LifeRing` | `life-ring` | `LifeBuoy` |  |
| `Lock` | `lock` | `Lock` |  |
| `Magnifier` | `magnifier` | `Search` |  |
| `MarketingTarget` | `marketing-target` | `Target` |  |
| `Menu3` | `menu3` | `Menu` |  |
| `Minus` | `minus` | `Minus` |  |
| `MoneyBills2` | `money-bills2` | `Banknote` |  |
| `Msgs` | `msgs` | `MessagesSquare` |  |
| `Note` | `note` | `NotepadText` | **weak:** notepad |
| `OfficeBuilding` | `office-building` | `BuildingComplex` |  |
| `PaperPlane` | `paper-plane` | `Send` |  |
| `Pen2` | `pen2` | `Pen` |  |
| `PenWriting` | `pen-writing` | `PenLine` |  |
| `PercentageArrowDown` | `percentage-arrow-down` | `TrendingDown` | **weak:** no percent sign |
| `Plug2` | `plug2` | `Plug` |  |
| `Plus` | `plus` | `Plus` |  |
| `Receipt2` | `receipt2` | `ReceiptText` |  |
| `Robot` | `robot` | `Bot` |  |
| `ShieldAlert` | `shield-alert` | `ShieldExclamationPoint` |  |
| `ShieldCheck` | `shield-check` | `ShieldCheck` |  |
| `ShieldKeyhole` | `shield-keyhole` | `ShieldKeyhole` |  |
| `ShieldSlash` | `shield-slash` | `ShieldOff` |  |
| `Shop` | `shop` | `Store` |  |
| `Shuffle` | `shuffle` | `Shuffle` |  |
| `Sitemap` | `sitemap` | `Network` |  |
| `Sparkle3` | `sparkle3` | `Sparkles` |  |
| `SquareChart` | `square-chart` | `ChartColumnBig` | **weak:** bar chart on axes, no frame |
| `SquareCheck` | `square-check` | `SquareCheck` |  |
| `SquareLayoutGrid5` | `square-layout-grid5` | `LayoutDashboard` | **weak:** dashboard panels |
| `Timer2` | `timer2` | `Timer` |  |
| `Trash` | `trash` | `Trash` |  |
| `TriangleWarning` | `triangle-warning` | `TriangleExclamationPoint` |  |
| `Trophy` | `trophy` | `Trophy` |  |
| `UserArrowRight` | `user-arrow-right` | `LogOut` | **weak:** sign-out meaning, no person |
| `UserCrown` | `user-crown` | `UserStar` | **weak:** star, not crown |
| `UserFocus` | `user-focus` | `ScanFace` | **weak:** face in a scan frame, not a framed person |
| `UserMinus` | `user-minus` | `UserMinus` |  |
| `UserPlus` | `user-plus` | `UserPlus` |  |
| `Users` | `users` | `Users` |  |
| `Users2` | `users2` | `UsersRound` |  |
| `Users6` | `users6` | `UserGroup` | **weak:** group, not six people |
| `UsersSettings` | `users-settings` | `UserCog` |  |
| `Versions2` | `versions2` | `Layers` | **weak:** stacked layers |
| `Webhook` | `webhook` | `Webhook` |  |
| `Workflow` | `workflow` | `Workflow` |  |
| `Xmark` | `xmark` | `X` |  |

## Files

| File | Role |
|---|---|
| `packages/ui/src/components/ui/icons/glyphs/*.tsx`, `index.ts` | The 105 wrappers and their barrel |
| `packages/ui/src/components/ui/icons/glyphs/README.md` | Where the icons come from, how to add one |
| `packages/ui/src/components/ui/icons/nucleo/**` | Deleted: 269 icons, the barrel, the README |
| `src/components/ui/icons/index.tsx` and 111 other importing files | Import path `icons/nucleo` → `icons/glyphs` |
| `next.config.js` | `optimizePackageImports` names the new barrel |
| `tests/guards/no-nucleo-icon-set.test.ts` | New: no Nucleo-named path or Nucleo notice outside `docs/` |
| `tests/guards/no-lucide.test.ts` | Deleted (see Decisions) |
| `tests/guards/icon-import-discipline.test.ts`, `rq4-2-arrow-left-icon.test.ts`, `datatable-row-chevron-affordance.test.ts` | Repointed at the glyph set |
| `tests/guards/ui-core-classification.test.ts`, `shared-ui-coupling-ratchet.test.ts`, `tests/helpers/shared-ui-couplings.ts` | Population floor 600 → 450 |
| `docs/_status/ui-core-classification.json` | 270 Nucleo entries out, 106 glyph entries in |
| `tests/rendered/org-sidebar-glyphs.test.tsx` | Renamed from `org-sidebar-nucleo-icons.test.tsx` |

## Decisions

- **`no-lucide.test.ts` is retired, not inverted.** It froze ~130 files that
  import lucide-react as a migration list towards Nucleo, on the ground that
  two families drift apart in stroke and cap geometry. With Nucleo gone every
  general-purpose icon in the product is lucide's, so the drift it guarded
  against cannot occur, and its allowlist had nothing left to migrate to.
  What keeps the single family is the new guard: the other family cannot
  come back. Comments that cited the old guard as present-tense law were
  rewritten; ones recording why something happened at the time now say it
  was retired here.
- **The new guard is a test, not an ESLint rule.** The harm is a file being
  in the public tree, which no import rule sees: a copied set with no
  importer is still redistribution. It checks two things that cannot drift
  into each other: a path named for Nucleo, and Nucleo's licence notice in
  any tracked text file. `docs/` is excluded because prose may name Nucleo.
  It cannot recognise one glyph pasted in without its notice; that stays a
  review question, and the glyph README says where icons come from.
- **The population floor moved from 600 to 450.** Two guards assert the
  shared-UI population stays above a floor, to catch files moving OUT of the
  roots while every per-file assertion stays green. This change deletes 270
  files and adds 106, so the live count fell from 626 to 462 by deletion,
  not by a move; the floor keeps a margin of the same size, and the helper's
  docstring records why.
- **Filled glyphs became outlined.** `CheckboxCheckedFill` and
  `CircleCheckFill` were solid shapes; lucide draws outlines only. Both still
  read as checked, beside text that says so.
- **Not done here.** Other icons under `packages/ui/src/components/ui/icons/`
  (`file-send.tsx`, `user-clock.tsx`) are drawn on the same 18-unit,
  1.5-stroke grid and carry no attribution; neither has a caller. Whether they
  are Nucleo-derived is not established by anything in the tree.
