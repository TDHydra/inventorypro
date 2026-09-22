// Ported from apps/mobile/src/components/ui/PreviewBanner.tsx.
//
// Lives at src/components/ (not @invenpro/ui) because packages/ui edits
// aren't authorized for this station — see docs/REBUILD-PORTING.md.
//
// Persistent, unmissable strip while a role preview (started from the
// "Preview as…" picker on Roles & Permissions, app/(app)/roles/index.tsx) is
// active. Mounted once at the app shell root (app/_layout.tsx), ABOVE the
// `<Stack>` so it renders on every screen without competing with any screen's
// own navigation header for space. Not a Modal — a preview only swaps what
// permission-gated UI resolves to; the app underneath must stay fully
// interactive (writes are blocked centrally in db/maintenance.ts, not here).
//
// Self-contained: reads `previewRole` off `useSession()` and renders nothing
// when no preview is active, so the app shell can mount it unconditionally.
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles } from '@invenpro/ui';
import { useSession } from '../hooks/useSession';
import { ROLE_DISPLAY_NAMES } from '../constants/roles';

export function PreviewBanner() {
  const s = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { previewRole, setPreviewRole } = useSession();

  if (previewRole == null) return null;

  return (
    <View style={[s.banner, { paddingTop: insets.top + 8 }]}>
      <Text style={s.text} numberOfLines={1}>
        Previewing as {ROLE_DISPLAY_NAMES[previewRole]} — read-only
      </Text>
      <TouchableOpacity style={s.exitBtn} onPress={() => setPreviewRole(null)} hitSlop={8}>
        <Text style={s.exitText}>Exit preview</Text>
      </TouchableOpacity>
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    backgroundColor: t.colors.warning,
    paddingHorizontal: t.spacing.base,
    paddingBottom: 8,
  },
  text: {
    flex: 1,
    color: t.colors.onPrimary,
    fontWeight: t.typography.weights.bold,
    fontSize: t.typography.fontSizes.body2,
  },
  exitBtn: {
    backgroundColor: 'rgba(0,0,0,0.15)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  exitText: {
    color: t.colors.onPrimary,
    fontWeight: t.typography.weights.bold,
    fontSize: t.typography.fontSizes.caption,
  },
});
