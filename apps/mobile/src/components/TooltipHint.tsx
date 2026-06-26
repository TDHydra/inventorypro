import { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated,
} from 'react-native';
import { HINTS } from '../constants/hints';
import { useSession } from '../hooks/useSession';
import { ROLE_TIER } from '../constants/roles';
import type { UserRole } from '../constants/roles';
import { getDb } from '../db/schema';

interface Props {
  screenKey: string;
  style?: object;
}

function hintSeen(screenKey: string): boolean {
  try {
    const db = getDb();
    const result = db.executeSync(
      `SELECT value FROM app_settings WHERE key = ?`,
      [`hint_seen_${screenKey}`]
    );
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

function markHintSeen(screenKey: string): void {
  try {
    const db = getDb();
    db.executeSync(
      `INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, '1')`,
      [`hint_seen_${screenKey}`]
    );
  } catch {
    // non-fatal
  }
}

export function TooltipHint({ screenKey, style }: Props) {
  const { user } = useSession();
  const [visible, setVisible] = useState(false);
  const [opacity] = useState(new Animated.Value(0));

  const tier = user ? ROLE_TIER[user.role as UserRole] : 1;
  const hintText = HINTS[screenKey]?.[tier] ?? HINTS[screenKey]?.[1] ?? null;

  useEffect(() => {
    if (!hintText) return;
    if (!hintSeen(screenKey)) {
      setVisible(true);
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
      setTimeout(dismiss, 6000);
    }
  }, [screenKey, hintText]);

  function dismiss() {
    Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
      setVisible(false);
    });
    markHintSeen(screenKey);
  }

  function reshowHint() {
    if (!hintText) return;
    setVisible(true);
    Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    setTimeout(dismiss, 6000);
  }

  if (!hintText) return null;

  return (
    <>
      {visible && (
        <Animated.View style={[styles.tooltip, { opacity }, style]}>
          <Text style={styles.icon}>💡</Text>
          <Text style={styles.text}>{hintText}</Text>
          <TouchableOpacity onPress={dismiss} style={styles.close}>
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>
        </Animated.View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
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
  text: { flex: 1, fontSize: 13, color: '#1D4ED8', lineHeight: 19 },
  close: { paddingLeft: 8 },
  closeText: { color: '#93C5FD', fontSize: 15 },
});
