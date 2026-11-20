import { Search as LucideSearch } from "lucide-react";
import type { SVGProps } from "react";

/** `Magnifier` — lucide-react `Search`, at the set's 18px default size. */
export function Magnifier(props: SVGProps<SVGSVGElement>) {
  return <LucideSearch size={18} {...props} />;
}
