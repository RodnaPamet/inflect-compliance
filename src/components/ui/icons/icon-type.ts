import type { LucideIcon } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

/**
 * Any icon a primitive accepts: a Lucide icon or one of ours.
 *
 * Its own module so a primitive can name it without importing the icons
 * barrel, which re-exports every icon there is; a downstream copy that takes
 * only the primitives then carries only the icons they draw (projectZ #336).
 * The barrel re-exports it, so `import { Icon } from "./icons"` keeps
 * working.
 */
export type Icon = LucideIcon | ComponentType<SVGProps<SVGSVGElement>>;
