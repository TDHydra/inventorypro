import { Slot } from 'expo-router';

// The inbox lives inside the parent (app) Stack (same pattern as the other
// route groups, which have no navigator of their own). A `<Slot />` passthrough
// keeps that single-header behaviour — index.tsx's <Stack.Screen> binds to the
// parent Stack — while still giving the group an explicit layout file.
export default function NotificationsLayout() {
  return <Slot />;
}
