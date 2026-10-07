#!/usr/bin/env node
/**
 * PR-1 codemod — migrate raw status-color Tailwind classes to semantic
 * tokens. Run once, committed as a record of what changed.
 *
 *   node scripts/codemods/raw-status-colors.js          # apply
 *   node scripts/codemods/raw-status-colors.js --dry    # report only
 *
 * Mapping rules (preserves any prefix chain like hover: / focus: / dark: /
 * group-hover: / md: etc):
 *
 *   text-{red,rose}-{shade}            -> text-content-error
 *   text-{emerald,green}-{shade}       -> text-content-success
 *   text-{amber,yellow}-{shade}        -> text-content-warning
 *   text-{blue,sky}-{shade}            -> text-content-info
 *   text-...-{shade}/{alpha}           -> text-content-{status}/{alpha}  (alpha preserved)
 *
 *   bg-{color}-{shade}/{alpha}         -> bg-bg-{status}        (alpha dropped — token is already 15% alpha)
 *   bg-{color}-{shade}                 -> bg-bg-{status}-emphasis (solid surface)
 *
 *   border-{color}-{shade}/{alpha}     -> border-border-{status} (alpha dropped — token is 30% alpha)
 *   border-{color}-{shade}             -> border-border-{status}
 *
 * Excluded paths (left alone):
 *   - chart files (legitimately use raw colors as chart palette)
 *   - icon SVG components (raw colors are part of the icon definition)
 *   - tests
 *   - tokens.css
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const TARGETS = ["src/app", "src/components"];
const EXCLUDE_DIR_NAMES = new Set([
  "icons",        // matched by path SEGMENT, so it covers packages/ui/.../icons too
                  // (#3046 step 2b) — raw colors are part of icon defs
  "charts",       // src/components/ui/charts — chart palette uses raw colors
  "node_modules",
  "__tests__",
  "__mocks__",
]);
const EXCLUDE_FILE_PATTERNS = [
  /\.test\.tsx?$/,
  /\.spec\.tsx?$/,
  /\.stories\.tsx?$/,
  /tokens\.css$/,
];

// Files that legitimately use raw colors for visualization where the
// semantic-token mapping doesn't fit:
//   - heatmaps that use multiple alpha levels per status (gradient)
//   - node/category palettes where colors distinguish kinds, not status
const EXCLUDE_VISUALIZATION_FILES = new Set([
  "src/components/ui/RiskHeatmap.tsx",     // 3-tier alpha gradient (/80, /60, /50)
  "src/components/ui/GraphExplorer.tsx",   // sky/rose/emerald/amber as 4-color category palette
  "src/components/ui/ExpiryCalendar.tsx",  // 3-tier urgency gradient (red/amber/yellow) — token system has only one warning tier
]);

const COLOR_TO_STATUS = {
  red: "error",
  rose: "error",
  emerald: "success",
  green: "success",
  amber: "warning",
  yellow: "warning",
  blue: "info",
  sky: "info",
};

const COLORS = Object.keys(COLOR_TO_STATUS).join("|");
// shade: 50..950 (Tailwind palette). ORDER MATTERS — JS regex alternation
// is first-match-wins, so list longer shades first. With `50` listed
// before `500`, `border-emerald-500/40` would match `50` + leave `0/40`
// behind because the optional alpha lets the short match succeed.
const SHADE = "(?:950|900|800|700|600|500|400|300|200|100|50)";
// optional alpha modifier like /10, /[0.08], /20
const ALPHA = "(?:\\/(?:\\d{1,3}|\\[[\\d.]+\\]))?";
// any prefix chain (hover:, focus:, dark:, group-hover/x:, md:, etc.)
// Stops matching at the property name boundary.
const PREFIX = "((?:[A-Za-z0-9_-]+(?:\\/[A-Za-z0-9_-]+)?:)*)";

const DRY = process.argv.includes("--dry");

function statusOf(color) {
  const s = COLOR_TO_STATUS[color];
  if (!s) throw new Error(`unmapped color: ${color}`);
  return s;
}

function migrate(content) {
  let changed = 0;

  // 1) text-{color}-{shade}{/alpha?} -> text-content-{status}{/alpha?}
  content = content.replace(
    new RegExp(`${PREFIX}text-(${COLORS})-${SHADE}(${ALPHA})`, "g"),
    (_m, prefix, color, alpha) => {
      changed++;
      return `${prefix}text-content-${statusOf(color)}${alpha || ""}`;
    },
  );

  // 2) border-{color}-{shade}{/alpha?} -> border-border-{status}
  //    (alpha dropped; token already carries its own alpha tint)
  content = content.replace(
    new RegExp(`${PREFIX}border-(${COLORS})-${SHADE}${ALPHA}`, "g"),
    (_m, prefix, color) => {
      changed++;
      return `${prefix}border-border-${statusOf(color)}`;
    },
  );

  // 3) bg-{color}-{shade}/{alpha} -> bg-bg-{status}  (alpha-tinted form)
  //    Must run BEFORE the solid bg pattern so alpha-tinted matches first.
  content = content.replace(
    new RegExp(
      `${PREFIX}bg-(${COLORS})-${SHADE}(?:\\/(?:\\d{1,3}|\\[[\\d.]+\\]))`,
      "g",
    ),
    (_m, prefix, color) => {
      changed++;
      return `${prefix}bg-bg-${statusOf(color)}`;
    },
  );

  // 4) bg-{color}-{shade} (solid, no alpha) -> bg-bg-{status}-emphasis
  content = content.replace(
    new RegExp(`${PREFIX}bg-(${COLORS})-${SHADE}\\b`, "g"),
    (_m, prefix, color) => {
      changed++;
      return `${prefix}bg-bg-${statusOf(color)}-emphasis`;
    },
  );

  // 5) divide-{color}-{shade}{/alpha?} -> divide-border-{status}
  //    (rare, but avoid leaving stragglers)
  content = content.replace(
    new RegExp(`${PREFIX}divide-(${COLORS})-${SHADE}${ALPHA}`, "g"),
    (_m, prefix, color) => {
      changed++;
      return `${prefix}divide-border-${statusOf(color)}`;
    },
  );

  // 6) ring-{color}-{shade}{/alpha?} -> ring-{status} via border token
  //    Tailwind doesn't auto-resolve `ring-border-error`; map to a CSS var
  //    inline to preserve themed behaviour.
  content = content.replace(
    new RegExp(`${PREFIX}ring-(${COLORS})-${SHADE}${ALPHA}`, "g"),
    (_m, prefix, color) => {
      changed++;
      return `${prefix}ring-[var(--border-${statusOf(color)})]`;
    },
  );

  return { content, changed };
}

function isExcluded(absPath) {
  const rel = path.relative(ROOT, absPath);
  if (EXCLUDE_VISUALIZATION_FILES.has(rel)) return true;
  // any segment of the path matches an excluded dir name?
  const segments = rel.split(path.sep);
  if (segments.some((s) => EXCLUDE_DIR_NAMES.has(s))) return true;
  if (EXCLUDE_FILE_PATTERNS.some((rx) => rx.test(rel))) return true;
  return false;
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (isExcluded(full)) continue;
    if (entry.isDirectory()) walk(full, files);
    else if (/\.(tsx|ts|jsx|js|css)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function main() {
  const files = TARGETS.flatMap((t) => walk(path.join(ROOT, t)));
  let totalFiles = 0;
  let totalReplacements = 0;
  for (const file of files) {
    const before = fs.readFileSync(file, "utf8");
    const { content: after, changed } = migrate(before);
    if (changed > 0) {
      totalFiles++;
      totalReplacements += changed;
      if (!DRY) fs.writeFileSync(file, after);
      const rel = path.relative(ROOT, file);
      console.log(`${changed.toString().padStart(4)}  ${rel}`);
    }
  }
  console.log(
    `\n${DRY ? "[dry-run]" : "[applied]"} ${totalReplacements} replacement(s) across ${totalFiles} file(s).`,
  );
}

main();
