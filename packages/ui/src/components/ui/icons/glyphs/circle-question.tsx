import { CircleQuestionMark as LucideCircleQuestionMark } from "lucide-react";
import type { SVGProps } from "react";

/** `CircleQuestion` — lucide-react `CircleQuestionMark`, at the set's 18px default size. */
export function CircleQuestion(props: SVGProps<SVGSVGElement>) {
  return <LucideCircleQuestionMark size={18} {...props} />;
}
