/**
 * The public surface of `@inflect/ui`. Empty — step 1 of #3046's Roadmap
 * creates the package and moves nothing.
 *
 * `export {}` is not decoration. A `.ts` file with no import or export is a
 * global SCRIPT, not a module, and `package.json`'s `main`/`types`/`exports` all
 * point here — so a zero-byte file would make `import … from '@inflect/ui'` the
 * error "File is not a module" the first time anyone tried it. One line now, or
 * a confusing failure for whoever adds the first export.
 *
 * The surface is re-exported from here rather than deep-imported by consumers,
 * so the package can move a file internally without breaking a caller. Nothing
 * to re-export yet: the icons arrive at step 2, the 93 non-icon modules at
 * step 3.
 */
export {};
