import { LayoutGrid as LucideLayoutGrid } from "lucide-react";
import type { SVGProps } from "react";

/** `GridIcon` — lucide-react `LayoutGrid`, at the set's 18px default size. */
export function GridIcon(props: SVGProps<SVGSVGElement>) {
  return <LucideLayoutGrid size={18} {...props} />;
}
