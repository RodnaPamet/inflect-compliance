import { cn } from "@inflect/ui/lib/cn";
import {
  cloneElement,
  isValidElement,
  PropsWithChildren,
  useCallback,
  useRef,
  type ReactElement,
  type Ref,
  type UIEventHandler,
} from "react";
import { useScrollProgress } from "@inflect/ui/components/ui/hooks/use-scroll-progress";

type ScrollerProps = {
  className?: string;
  ref?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
};

export function ScrollContainer({
  children,
  className,
  asChild = false,
}: PropsWithChildren<{
  className?: string;
  /**
   * Make the single child element the scroller instead of wrapping it in one.
   *
   * For a child whose role the scroller has to carry. A combobox's option
   * list is the case: axe's `scrollable-region-focusable` exempts a scroller
   * that IS the combobox's `role="listbox"` popup (focus stays in the search
   * box and `aria-activedescendant` walks the options), but not a plain div
   * scrolling around one. The child must forward `ref`, `className` and
   * `onScroll` to its DOM element.
   */
  asChild?: boolean;
}>) {
  const ref = useRef<HTMLDivElement>(null);

  const { scrollProgress, updateScrollProgress } = useScrollProgress(ref);
  // For the asChild clone: a callback that fills `ref`, not the ref object
  // itself, which would be read during render.
  const attachRef = useCallback((node: HTMLDivElement | null) => {
    ref.current = node;
  }, []);

  // clip-path is used to fix a weird bug in WebKit where scrolled-out-of-view content is still interactible
  const scrollerClassName =
    "scrollbar-hide h-full w-screen max-w-[calc(100vw-0.5rem)] overflow-y-scroll [clip-path:inset(0)] sm:w-auto sm:max-w-none";

  const scroller =
    asChild && isValidElement<ScrollerProps>(children) ? (
      // attachRef is a callback React calls on commit; nothing reads a ref here.
      // eslint-disable-next-line react-hooks/refs
      cloneElement(children as ReactElement<ScrollerProps>, {
        ref: attachRef,
        onScroll: updateScrollProgress,
        // The child's own classes first, so the scroller's sizing wins a
        // conflict exactly as it did when it was the wrapper.
        className: cn(children.props.className, scrollerClassName, className),
      })
    ) : (
      <div
        className={cn(scrollerClassName, className)}
        ref={ref}
        onScroll={updateScrollProgress}
      >
        {children}
      </div>
    );

  return (
    <div className="relative">
      {scroller}
      {/* Bottom scroll fade — tokenised so the gradient blends with the
          parent surface regardless of theme. The legacy `from-white`
          broke inside any dark Modal/Sheet body. */}
      <div
        className="pointer-events-none absolute bottom-0 left-0 z-10 hidden h-16 w-full rounded-b-lg bg-gradient-to-t from-bg-default to-transparent sm:block"
        style={{ opacity: 1 - Math.pow(scrollProgress, 2) }}
      />
    </div>
  );
}
