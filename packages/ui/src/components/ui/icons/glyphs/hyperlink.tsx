import { Link as LucideLink } from "lucide-react";
import type { SVGProps } from "react";

/** `Hyperlink` — lucide-react `Link`, at the set's 18px default size. */
export function Hyperlink(props: SVGProps<SVGSVGElement>) {
  return <LucideLink size={18} {...props} />;
}
