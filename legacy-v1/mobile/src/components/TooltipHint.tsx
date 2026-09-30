import { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated,
} from 'react-native';
import type { Theme } from '../themes/types';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { HINTS } from '../constants/hints';
import { useSession } from '../hooks/useSession';
import { ROLE_TIER } from '../constants/roles';
import type { UserRole } from '../constants/roles';
import { getAppSetting, setAppSetting } from '../db/appSettings';

interface Props {
  screenKey: string;
  style?: object;
  onReady?: (reshow: () => void) => void;
}

export function TooltipHint({ screenKey, style, onReady }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const [visible, setVisible] = useState(false);
  const [opacity] = useState(new Animated.Value(0));

  const tier = user ? ROLE_TIER[user.role as UserRole] : 1;
  const hintText = HINTS[screenKey]?.[tier] ?? HINTS[screenKey]?.[1] ?? null;

  useEffect(() => {
    if (!hintText) return;
    if (getAppSetting(`hint_seen_${screenKey}`) !== '1') {
      setVisible(true);
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
      setTimeout(dismiss, 6000);
    }
  }, [screenKey, hintText]);

  function dismiss() {
    Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
      setVisible(false);
    });
    setAppSetting(`hint_seen_${screenKey}`, '1');
  }

  function reshowHint() {
    if (!hintText) return;
    setVisible(true);
    Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    setTimeout(dismiss, 6000);
  }

  useEffect(() => { onReady?.(reshowHint); }, []);

  if (!hintText) return null;

  return (
    <>
      {visible && (
        <Animated.View style={[s.tooltip, { opacity }, style]}>
          <Text style={s.icon}>💡</Text>
          <Text style={s.text}>{hintText}</Text>
          <TouchableOpacity onPress={dismiss} style={s.close}>
            <Text style={s.closeText}>✕</Text>
          </TouchableOpacity>
        </Animated.View>
      )}
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  tooltip: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#EFF6FF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    padding: 12,
    gap: 10,
    marginHorizontal: 12,
    marginBottom: 8,
  },
  icon: { fontSize: 16 },
  text: { flex: 1, fontSize: 13, color: t.colors.primaryText, lineHeight: 19 },
  close: { paddingLeft: 8 },
  closeText: { color: '#93C5FD', fontSize: 15 },
});
