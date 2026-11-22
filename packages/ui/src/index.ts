/**
 * The package root of `@inflect/ui`. It exports nothing, on purpose.
 *
 * Consumers import each module by its subpath, which the `exports` map in
 * `package.json` resolves to a file under `src/`:
 *
 *   import { cn } from '@inflect/ui/lib/cn';
 *   import { Button } from '@inflect/ui/components/ui/button';
 *   import { useMediaQuery } from '@inflect/ui/components/ui/hooks/use-media-query';
 *
 * A barrel here would re-export every component, chart, hook and icon, so a
 * file that wanted `cn` would load the chart stack too, and a module with a
 * client-only side would reach every importer. Subpaths keep each import to
 * the module it names.
 *
 * `export {}` keeps this file a module. `main`, `types` and `exports["."]`
 * point here, and a file with no import or export is a script, so without the
 * line `import … from '@inflect/ui'` would fail with "File is not a module"
 * rather than the clearer "has no exported member".
 */
export {};
