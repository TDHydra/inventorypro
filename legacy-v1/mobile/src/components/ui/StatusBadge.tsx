// #220: StatusBadge/TypeBadge are now thin wrappers over StatusPill — the two
// near-identical tone-pill components diverged (#163/#168-class drift) and
// StatusPill is the surviving implementation (semantic bg/text theme pairs,
// square-tag variant support, uppercase-label themes). These wrappers keep the
// original prop APIs so the existing call sites don't churn; NEW call sites
// should use StatusPill directly.
//
// Both remain display-only (no onPress) — for an interactive/selectable pill
// use FilterChip instead.

import { StatusPill, type PillTone } from './StatusPill';
import { autoTypeColor } from '../../constants/typeColors';

export type BadgeTone = 'default' | 'primary' | 'accent' | 'success' | 'warning' | 'danger';

const TONE_MAP: Record<BadgeTone, PillTone> = {
  default: 'neutral',
  primary: 'primary',
  accent: 'accent',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
};

interface StatusBadgeProps {
  label: string;
  tone?: BadgeTone;
  size?: 'sm' | 'md';
}

export function StatusBadge({ label, tone = 'default', size = 'sm' }: StatusBadgeProps) {
  if (!label?.trim()) return null;
  return <StatusPill label={label} tone={TONE_MAP[tone]} size={size} />;
}

interface TypeBadgeProps {
  type: string;
  icon?: string;
  size?: 'sm' | 'md';
}

// Append an alpha channel to the hashed 6-digit type color to derive a light
// tint, rather than inventing a new "*Bg" token per type.
export function TypeBadge({ type, icon, size = 'sm' }: TypeBadgeProps) {
  const trimmed = type?.trim();
  if (!trimmed) return <StatusPill label={type ?? ''} size={size} />;
  // Always hash the bare type so the same type gets the same color whether or
  // not an icon is shown alongside it.
  const accent = autoTypeColor(trimmed);
  const label = icon ? `${icon} ${trimmed}` : trimmed;
  return <StatusPill label={label} color={{ bg: `${accent}1A`, text: accent }} size={size} />;
}
