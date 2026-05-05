'use client';

/**
 * Floating popover that is guaranteed to stay inside the viewport.
 *
 * Accepts viewport-space anchor coordinates (typically `getBoundingClientRect()`
 * output) and adjusts top/left after mount so the popover's right/bottom edge
 * never runs past the window edge, and its top/left never goes negative.
 *
 * Why a shared component: the app has multiple places that render absolute-
 * positioned detail popovers (purchasing day-cell detail, future tooltips)
 * and each had its own ad-hoc clamping (typically a fixed-buffer `Math.min`
 * that didn't actually measure the popover). This centralises the logic so
 * every popover behaves the same and picks up future improvements for free.
 */

import { useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';

export interface ClampedPopoverProps {
  /**
   * Anchor top in viewport space (pixels from top of visible viewport).
   * Typically `element.getBoundingClientRect().bottom` for a "below the anchor"
   * popover, or `.top` for "above". Do NOT add `window.scrollY` — this
   * component uses `position: fixed`, which is already viewport-relative.
   */
  top: number;
  /** Anchor left in viewport space. */
  left: number;
  /** Pixels to keep between the popover and the viewport edge. Default 8. */
  margin?: number;
  /** Tailwind / utility classes, merged with the default layering/shadow. */
  className?: string;
  /** Extra inline styles (background, border, width, etc.). */
  style?: CSSProperties;
  /** Popover contents. */
  children: ReactNode;
  /** Optional z-index override. Default 50. */
  zIndex?: number;
}

export function ClampedPopover({
  top,
  left,
  margin = 8,
  className,
  style,
  children,
  zIndex = 50,
}: ClampedPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  /**
   * `adjusted` holds the post-measurement clamped coordinates. Kept in a
   * separate state so the first render can hide the popover until we know
   * where it actually belongs — otherwise callers that anchor near the edge
   * would see a one-frame flash where the popover pokes past the viewport.
   */
  const [adjusted, setAdjusted] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let t = top;
    let l = left;

    // Clamp right edge first — if the popover would poke past the right
    // margin, pull it leftwards. Only then clamp the left edge in case the
    // first adjustment pushed it past the left margin (possible for very
    // wide popovers in narrow viewports; they'll get margin-margin bounds).
    if (l + w + margin > vw) l = vw - w - margin;
    if (l < margin) l = margin;
    if (t + h + margin > vh) t = vh - h - margin;
    if (t < margin) t = margin;

    setAdjusted({ top: t, left: l });
  }, [top, left, margin, children]);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        position: 'fixed',
        top: adjusted?.top ?? top,
        left: adjusted?.left ?? left,
        // Hide the first paint so a pre-clamp flash never appears. Switches
        // to 'visible' as soon as the layout effect finishes measuring.
        visibility: adjusted ? 'visible' : 'hidden',
        zIndex,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
