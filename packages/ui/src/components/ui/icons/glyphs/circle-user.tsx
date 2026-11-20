import { CircleUser as LucideCircleUser } from "lucide-react";
import type { SVGProps } from "react";

/** `CircleUser` — lucide-react `CircleUser`, at the set's 18px default size. */
export function CircleUser(props: SVGProps<SVGSVGElement>) {
  return <LucideCircleUser size={18} {...props} />;
}
