import { Key as LucideKey } from "lucide-react";
import type { SVGProps } from "react";

/** `Key` — lucide-react `Key`, at the set's 18px default size. */
export function Key(props: SVGProps<SVGSVGElement>) {
  return <LucideKey size={18} {...props} />;
}
