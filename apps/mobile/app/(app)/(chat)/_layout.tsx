import { Slot } from 'expo-router';

// Chat lives inside the parent (app) Stack (same pattern as the other route
// groups). A <Slot /> passthrough keeps the single-header behaviour — each
// screen's <Stack.Screen> binds to the parent Stack.
export default function ChatLayout() {
  return <Slot />;
}
