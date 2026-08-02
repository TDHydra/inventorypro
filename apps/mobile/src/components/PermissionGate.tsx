import React from 'react';
import { View, Text, Pressable, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { usePermission } from '../hooks/usePermission';
import { useSession } from '../hooks/useSession';
import { Permission, PERMISSION_LABELS } from '../constants/roles';
import type { Theme } from '../themes/types';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { appToastBus } from '../lib/toastBus';
import { pickAccessGrantor } from '../auth/pickAccessGrantor';
import { createDmConversation } from '../db/queries/chat';
import { isWriteBlocked } from '../db/maintenance';
import { EmptyState } from './ui/EmptyState';

interface Props {
  permission: Permission;
  teamId?: string | null;
  children?: React.ReactNode;
  fallback?: React.ReactNode;
  /**
   * 'hide' (default, backward compatible): render `fallback` (default null)
   * when denied — the control disappears entirely.
   * 'disable' (#197 "show-but-locked"): render `children` anyway, dimmed and
   * inert (`pointerEvents: 'none'`), with a 🔒 glyph overlay on top. The
   * dimmed region itself is tappable — a tap fires `toastBus.push` with
   * "Requires <label>" (a themed snackbar, never a second Modal) instead of a
   * silent no-op or a sync conflict (#76). Generalizes the {editable, reason}
   * shape roles.tsx already renders for per-permission role-editor cells.
   * 'screen' (#197/#198): whole-screen gate for route components that show
   * real entity data (teams/locations list + detail) rather than a single
   * control — denied renders the same house 🔒 `EmptyState` full-screen
   * pattern already used for "not a member"/"not found" guards (see
   * app/(app)/(teams)/[id].tsx), with the Request-access CTA wired the same
   * way as 'disable' mode's toast action, NOT a dimmed peek at `children` —
   * the whole point is that no real content renders when denied.
   */
  mode?: 'hide' | 'disable' | 'screen';
  /**
   * 'disable' only: dense-grid variant for dashboard tile grids etc. Swaps
   * the full centered 🔒 overlay for a small corner lock badge that doesn't
   * obscure the tile's own icon/label. The reason is still delivered by a
   * tap-toast either way.
   */
  compact?: boolean;
  /**
   * 'disable' only (#197 follow-up): applied to BOTH wrapper Views (outer +
   * disabledContent) so a gated tile's own layout style — e.g. a half-width
   * dashboard tile's flex:1 — reaches through the wrapper instead of
   * collapsing to content width next to its full-width sibling. This is the
   * exact hazard the dashboard file's own comment documents for the ungated
   * branch ("a plain View here breaks the half tiles' flex:1"); 'hide' mode
   * needs no style since it renders `<>{children}</>`/`<>{fallback}</>`
   * directly with no wrapper at all.
   */
  style?: StyleProp<ViewStyle>;
}

/**
 * Renders children only if the current user has the given permission.
 * Pass fallback to show something instead (default: null = nothing shown).
 */
export function PermissionGate({ permission, teamId, children, fallback = null, mode = 'hide', compact = false, style }: Props) {
  const allowed = usePermission(permission, teamId);
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const router = useRouter();

  if (allowed) return <>{children}</>;
  if (mode === 'hide') return <>{fallback}</>;

  const reason = `Requires ${PERMISSION_LABELS[permission]}`;

  // #203: find someone who could grant this, lazily (only on tap — never on
  // every render) and only when we have a real signed-in user to exclude/
  // anchor tier-distance against. Opening (or reusing) a DM with them,
  // prefilled with a draft asking for it, is shared by both 'disable' (via
  // the toast action below) and 'screen' (via the EmptyState CTA) — the user
  // still has to actually send it, this only removes the "who do I even ask"
  // friction.
  const openRequestAccessDm = (grantor: { id: string; name: string }) => {
    if (!user) return;
    // #203: this is a write (a local conversations/participants INSERT) like
    // any other — during maintenance lock or "Preview as role" it must
    // silently no-op instead of letting an uncaught MaintenanceLockedError
    // escape the tap handler (matches the silent-return guard
    // EditMyDashboardSheet.tsx and roles.tsx use ahead of every write).
    // Guarding here covers BOTH callers: 'disable' mode's toast action and
    // 'screen' mode's EmptyState CTA.
    if (isWriteBlocked()) return;
    const conversationId = createDmConversation(user.id, grantor.id);
    router.push({
      pathname: '/(app)/(chat)/[id]',
      params: {
        id: conversationId,
        draft: `Hi ${grantor.name} — could I get access to "${PERMISSION_LABELS[permission]}"? I need it for `,
      },
    });
  };

  if (mode === 'screen') {
    const grantor = user ? pickAccessGrantor(permission, user) : null;
    return (
      <View style={s.screenWrap}>
        <EmptyState
          icon="🔒"
          title="Access restricted"
          subtitle={reason}
          cta={grantor ? { label: 'Request access', onPress: () => openRequestAccessDm(grantor) } : undefined}
        />
      </View>
    );
  }

  const explain = () => {
    const grantor = user ? pickAccessGrantor(permission, user) : null;
    appToastBus.push({
      message: reason,
      action: grantor
        ? { label: 'Request access', onPress: () => openRequestAccessDm(grantor) }
        : undefined,
    });
  };

  return (
    <View style={style}>
      <View style={[s.disabledContent, style]} pointerEvents="none">
        {children}
      </View>
      {/* Overlays the whole dimmed region so a tap ANYWHERE on it explains why,
          rather than requiring a precise tap on the tiny lock glyph. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={explain}
        accessibilityRole="button"
        accessibilityLabel={reason}
      >
        {!compact && (
          <View style={s.lockCenter} pointerEvents="none">
            <Text style={s.lockGlyph}>🔒</Text>
          </View>
        )}
      </Pressable>
      {compact && (
        <View style={s.lockBadge} pointerEvents="none">
          <Text style={s.lockBadgeGlyph}>🔒</Text>
        </View>
      )}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  // Children can be arbitrary controls (buttons, switches, inputs) with their
  // own colors, so "reduced emphasis" is expressed as opacity rather than a
  // literal textDisabled recolor — the same 0.5 dim already used for disabled
  // buttons/rows across the app (PrimaryButton, BulkActionBar, pickers).
  disabledContent: { opacity: 0.5 },
  // 'screen' mode: fills the route's content area (the caller's own
  // Stack.Screen header still renders above this).
  screenWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.background },
  lockCenter: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  lockGlyph: { fontSize: 20 },
  lockBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: t.colors.surface,
    borderWidth: 1,
    borderColor: t.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockBadgeGlyph: { fontSize: 10, lineHeight: 12 },
});
