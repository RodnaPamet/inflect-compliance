import { Trash as LucideTrash } from "lucide-react";
import type { SVGProps } from "react";

/** `Trash` — lucide-react `Trash`, at the set's 18px default size. */
export function Trash(props: SVGProps<SVGSVGElement>) {
  return <LucideTrash size={18} {...props} />;
}
