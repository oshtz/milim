const WORDMARK_ASPECT_RATIO = 424.58 / 352.98;

/** The milim wordmark. Monochrome - inherits `currentColor`, so it adapts to
 *  the active theme (light/dark/custom accent). */
export function Logo({ height = 28, className }: { height?: number; className?: string }) {
  return (
    <span
      className={className}
      role="img"
      aria-label="milim"
      style={{
        display: "inline-block",
        width: height * WORDMARK_ASPECT_RATIO,
        height,
        backgroundColor: "currentColor",
        WebkitMask: "url('/milim-wordmark.svg') center / contain no-repeat",
        mask: "url('/milim-wordmark.svg') center / contain no-repeat",
      }}
    />
  );
}
