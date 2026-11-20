import { Calendar as LucideCalendar } from "lucide-react";
import type { SVGProps } from "react";

/** `CalendarIcon` — lucide-react `Calendar`, at the set's 18px default size. */
export function CalendarIcon(props: SVGProps<SVGSVGElement>) {
  return <LucideCalendar size={18} {...props} />;
}
