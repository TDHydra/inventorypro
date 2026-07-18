import { useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Stack, useNavigation, useRouter } from 'expo-router';
import { ChatBell } from '../../../src/components/ChatBell';
import { NotificationBell } from '../../../src/components/NotificationBell';
import { SyncIndicator } from '../../../src/components/SyncIndicator';
import { colors } from '../../../src/theme';

// Chat owns its own Stack so the list (index) and a thread ([id]) are DISTINCT
// navigator screens with independent, per-screen headers. Under the old <Slot/>
// both children shared the single parent (app) route, so [id]'s
// <Stack.Screen title> update was dropped (expo-router's Screen effect skips
// setOptions for a preloaded-but-unfocused screen) and the header stuck on the
// route-group name "(chat)" (#89a). As real focused routes each screen now
// applies its own title.
//
// The parent (app) Stack already renders a header for this group, so hide that
// one and let this nested Stack render the only header (no double bar). The
// global header actions (chat/notification bells, sync) are re-mounted here so
// the list keeps them; the account "Switch" affordance stays on every other
// screen and is intentionally dropped inside chat.
export default function ChatLayout() {
  const navigation = useNavigation();
  const router = useRouter();

  useEffect(() => {
    navigation.setOptions({ headerShown: false });
  }, [navigation]);

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.brand },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: '700' },
        headerRight: () => (
          <View style={s.headerRight}>
            <ChatBell />
            <NotificationBell />
            <SyncIndicator />
          </View>
        ),
      }}
    >
      {/* index is the nested-stack root — with the parent header hidden it has no
          native back button, so supply one that pops back out of the group. */}
      <Stack.Screen
        name="index"
        options={{
          title: 'Messages',
          headerLeft: () => (
            <TouchableOpacity onPress={() => router.back()} hitSlop={8} style={s.backBtn}>
              <Text style={s.backText}>‹ Back</Text>
            </TouchableOpacity>
          ),
        }}
      />
      {/* [id] sets its own dynamic title + Details button from the screen. */}
      <Stack.Screen name="[id]" options={{ title: 'Chat' }} />
    </Stack>
  );
}

const s = StyleSheet.create({
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12, marginRight: 4 },
  backBtn: { paddingHorizontal: 4, paddingVertical: 4, marginLeft: 4 },
  backText: { color: '#fff', fontSize: 17, fontWeight: '600' },
});
