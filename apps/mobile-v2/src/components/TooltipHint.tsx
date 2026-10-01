import { HintBanner } from '@invenpro/ui';
import { getAppSetting, setAppSetting } from '@invenpro/core';
import { HINTS } from '../constants/hints';
import { useSession } from '../hooks/useSession';
import { ROLE_TIER } from '../constants/roles';
import type { UserRole } from '../constants/roles';

interface Props {
  screenKey: string;
  style?: object;
}

/** How long a hint stays up before it dismisses itself. */
const AUTO_DISMISS_MS = 6000;

/**
 * Picks the right hint for this screen and this user's role tier, shows it once
 * ever, and remembers that it was seen. The strip itself is @invenpro/ui's
 * HintBanner — this component is only the policy half (which copy, who sees it,
 * has it been seen), the way OfflineBanner's state lives beside it in the kit.
 */
export function TooltipHint({ screenKey, style }: Props) {
  const { user } = useSession();
  const tier = user ? ROLE_TIER[user.role as UserRole] : 1;
  const hintText = HINTS[screenKey]?.[tier] ?? HINTS[screenKey]?.[1] ?? null;

  // Read during render, not in an effect: getAppSetting swallows its own errors
  // (null before the DB is open), and checking here is what stops an
  // already-seen hint from flashing for a frame on every mount.
  if (!hintText || getAppSetting(`hint_seen_${screenKey}`) === '1') return null;

  function markSeen() {
    try {
      setAppSetting(`hint_seen_${screenKey}`, '1');
    } catch {
      // Pre-DB-init dismissal: nothing to persist to, so the hint is simply due
      // again next time. Never let a bookkeeping write break the dismissal.
    }
  }

  return (
    <HintBanner
      // A new screenKey is a different hint, so it gets a fresh banner rather
      // than inheriting the previous one's dismissed state.
      key={screenKey}
      text={hintText}
      onDismiss={markSeen}
      autoDismissMs={AUTO_DISMISS_MS}
      style={style}
    />
  );
}
