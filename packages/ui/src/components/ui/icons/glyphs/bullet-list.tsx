import { List as LucideList } from "lucide-react";
import type { SVGProps } from "react";

/** `BulletList` — lucide-react `List`, at the set's 18px default size. */
export function BulletList(props: SVGProps<SVGSVGElement>) {
  return <LucideList size={18} {...props} />;
}
