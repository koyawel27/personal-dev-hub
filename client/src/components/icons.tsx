/**
 * Restrained navigation/action icons for Personal Dev Hub.
 *
 * Drawn on a 16px grid with 2px units: crisp squares, no curves, fitting
 * the subtle retro-computing character. Icons are SECONDARY to labels —
 * they improve scanning, never carry meaning alone.
 * All use currentColor so state colors come from CSS.
 */

type IconProps = { size?: number };

function Svg({ size = 16, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Stepped pixel mark used as the brand glyph. */
export function BrandMark({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="1" width="6" height="6" fill="var(--accent)" />
      <rect x="7" y="7" width="4" height="4" fill="var(--accent-strong)" />
      <rect x="11" y="11" width="2" height="2" fill="var(--text-faint)" />
      <rect x="13" y="13" width="2" height="2" fill="var(--border-strong)" />
    </svg>
  );
}

export function IconDashboard(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1" y="1" width="6" height="6" />
      <rect x="9" y="1" width="6" height="6" opacity="0.45" />
      <rect x="1" y="9" width="6" height="6" opacity="0.45" />
      <rect x="9" y="9" width="6" height="6" />
    </Svg>
  );
}

export function IconProjects(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M1 3h5l2 2h7v8H1z" />
    </Svg>
  );
}

export function IconActivity(props: IconProps) {
  return (
    <Svg {...props}>
      {/* stepped pulse */}
      <rect x="1" y="9" width="2" height="2" />
      <rect x="3" y="7" width="2" height="4" />
      <rect x="5" y="3" width="2" height="8" />
      <rect x="7" y="5" width="2" height="6" />
      <rect x="9" y="7" width="2" height="4" />
      <rect x="11" y="6" width="2" height="5" />
      <rect x="13" y="8" width="2" height="3" />
    </Svg>
  );
}

export function IconContributions(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1" y="1" width="4" height="4" opacity="0.45" />
      <rect x="6" y="1" width="4" height="4" opacity="0.7" />
      <rect x="11" y="1" width="4" height="4" />
      <rect x="1" y="6" width="4" height="4" opacity="0.7" />
      <rect x="6" y="6" width="4" height="4" />
      <rect x="11" y="6" width="4" height="4" opacity="0.25" />
      <rect x="1" y="11" width="4" height="4" />
      <rect x="6" y="11" width="4" height="4" opacity="0.45" />
      <rect x="11" y="11" width="4" height="4" opacity="0.7" />
    </Svg>
  );
}

export function IconPortfolio(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1" y="4" width="10" height="10" />
      <rect x="5" y="1" width="10" height="10" opacity="0.55" />
    </Svg>
  );
}

export function IconSources(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M1 2h6l1 2h7v3H1z" opacity="0.55" />
      <path d="M1 6h14v8H1z" />
    </Svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <Svg {...props}>
      {/* sliders */}
      <rect x="1" y="3" width="14" height="2" />
      <rect x="4" y="1" width="4" height="6" />
      <rect x="1" y="11" width="14" height="2" />
      <rect x="9" y="9" width="4" height="6" />
    </Svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="7" y="2" width="2" height="12" />
      <rect x="2" y="7" width="12" height="2" />
    </Svg>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <Svg {...props}>
      {/* square refresh arrows */}
      <path d="M13 6V3H3v4H1V1h4v2H5V3h6v3z" />
      <path d="M3 10v3h10V9h2v6h-4v-2h1v-2H5v3z" transform="translate(0 -1)" />
    </Svg>
  );
}

export function IconAttention(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 1l7 13H1z" />
      <rect x="7" y="6" width="2" height="4" fill="var(--surface)" />
      <rect x="7" y="11" width="2" height="2" fill="var(--surface)" />
    </Svg>
  );
}

export function IconCalendar(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1" y="2" width="14" height="13" opacity="0.35" />
      <rect x="1" y="2" width="14" height="3" />
      <rect x="4" y="0" width="2" height="4" />
      <rect x="10" y="0" width="2" height="4" />
      <rect x="3" y="7" width="2" height="2" />
      <rect x="7" y="7" width="2" height="2" />
      <rect x="11" y="7" width="2" height="2" opacity="0.6" />
    </Svg>
  );
}

export function IconJournal(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="1" width="12" height="14" />
      <rect x="4" y="4" width="8" height="1" opacity="0.5" />
      <rect x="4" y="7" width="8" height="1" opacity="0.5" />
      <rect x="4" y="10" width="5" height="1" opacity="0.5" />
    </Svg>
  );
}

export function IconMaintenance(props: IconProps) {
  return (
    <Svg {...props}>
      {/* stepped toolkit / maintenance mark */}
      <rect x="1" y="2" width="10" height="2" />
      <rect x="1" y="2" width="2" height="12" />
      <rect x="1" y="12" width="10" height="2" />
      <rect x="9" y="6" width="2" height="4" />
      <rect x="11" y="5" width="4" height="6" />
    </Svg>
  );
}
