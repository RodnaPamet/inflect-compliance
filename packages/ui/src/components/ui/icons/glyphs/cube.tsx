import { Box as LucideBox } from "lucide-react";
import type { SVGProps } from "react";

/** `Cube` — lucide-react `Box`, at the set's 18px default size. */
export function Cube(props: SVGProps<SVGSVGElement>) {
  return <LucideBox size={18} {...props} />;
}
