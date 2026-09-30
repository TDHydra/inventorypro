import { DayBoardScreen } from '../../../src/components/schedule/DayBoardScreen';

// #184: thin route — the screen body lives in DayBoardScreen so it's testable
// import-graph-wise the same way every other feature screen in this app is
// (route file just wires the component into expo-router).
//
// No _layout.tsx in this group: unlike the UI design doc's note to "mirror
// (myteam)/_layout.tsx", no route group in this codebase actually has its own
// _layout.tsx (checked (myteam), (jobs), (repairs)) — every simple group is
// just an index.tsx picked up by the parent (app)/_layout.tsx Stack, with the
// screen itself rendering `<Stack.Screen options={{ title, headerShown }} />`
// inline (see DayBoardScreen.tsx). Followed that established pattern instead.
export default function ScheduleRoute() {
  return <DayBoardScreen />;
}
