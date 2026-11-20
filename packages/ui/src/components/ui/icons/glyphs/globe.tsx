import { Globe as LucideGlobe } from "lucide-react";
import type { SVGProps } from "react";

/** `Globe` — lucide-react `Globe`, at the set's 18px default size. */
export function Globe(props: SVGProps<SVGSVGElement>) {
  return <LucideGlobe size={18} {...props} />;
}
