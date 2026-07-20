import type { HTMLAttributes } from "react";

export function ComposerSurface({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`dock-surface${className ? ` ${className}` : ""}`} {...props} />;
}
