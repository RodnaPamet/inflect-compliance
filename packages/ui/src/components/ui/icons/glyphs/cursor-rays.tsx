import { MousePointerClick as LucideMousePointerClick } from "lucide-react";
import type { SVGProps } from "react";

/** `CursorRays` — lucide-react `MousePointerClick`, at the set's 18px default size. */
export function CursorRays(props: SVGProps<SVGSVGElement>) {
  return <LucideMousePointerClick size={18} {...props} />;
}
