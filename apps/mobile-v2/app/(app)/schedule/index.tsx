import { DayBoardScreen } from '../../../src/components/schedule/DayBoardScreen';

// Station C2: thin route — the screen body lives in DayBoardScreen so it's
// testable import-graph-wise the same way every other feature screen in this
// app is (route file just wires the component into expo-router). Ported from
// apps/mobile/app/(app)/(schedule)/index.tsx (plain route here, not a
// parenthesized group, per docs/REBUILD-PORTING.md and the jobs/index.tsx
// precedent from Station C1).
export default function ScheduleRoute() {
  return <DayBoardScreen />;
}
