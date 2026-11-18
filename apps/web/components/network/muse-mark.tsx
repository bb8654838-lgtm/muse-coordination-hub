"use client";

import { useId } from "react";

type MuseMarkProps = {
  className?: string;
  active?: boolean;
  label?: string;
};

export function MuseMark({ className = "", active = false, label = "Muse core" }: MuseMarkProps) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      aria-label={label}
      className={`muse-mark ${active ? "muse-mark-active" : ""} ${className}`}
      role="img"
      viewBox="0 0 96 96"
    >
      <defs>
        <radialGradient id={`${id}-orb`} cx="32%" cy="24%" r="78%">
          <stop offset="0" stopColor="#effffb" />
          <stop offset="0.18" stopColor="#6ee7c7" />
          <stop offset="0.58" stopColor="#238c89" />
          <stop offset="1" stopColor="#071c27" />
        </radialGradient>
        <linearGradient id={`${id}-glyph`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#f8fffd" />
          <stop offset="1" stopColor="#9ef4dd" />
        </linearGradient>
        <filter id={`${id}-glow`} x="-70%" y="-70%" width="240%" height="240%">
          <feGaussianBlur stdDeviation="5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle className="muse-mark-halo" cx="48" cy="48" r="42" fill="none" stroke="#6ee7c7" strokeOpacity=".34" />
      <circle cx="48" cy="48" r="32" fill={`url(#${id}-orb)`} filter={`url(#${id}-glow)`} />
      <ellipse cx="38" cy="32" rx="13" ry="8" fill="#ffffff" opacity=".22" transform="rotate(-24 38 32)" />
      <path
        d="M29 61V34.5c0-2.2 2.7-3.3 4.2-1.7L48 48l14.8-15.2c1.5-1.6 4.2-.5 4.2 1.7V61h-8.5V48.7L48 59.2 37.5 48.7V61z"
        fill={`url(#${id}-glyph)`}
      />
      <circle cx="69" cy="28" r="3" fill="#fbbf24" />
    </svg>
  );
}
