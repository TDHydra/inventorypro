import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  View,
  Animated,
  PanResponder,
  StyleSheet,
  type GestureResponderHandlers,
} from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

// Generic drag-to-reorder list — a reusable extraction of the DragRow/
// DraggableTypeList pattern in app/(app)/(admin)/manage-types.tsx (absolutely
// positioned rows within a fixed-height container; a lifted row floats under the
// finger via a shared Animated.Value while the others shift to open a gap). The
// caller owns the row visuals via `renderRow` and receives the grab handle's
// panHandlers plus up/down helpers (a no-drag accessibility fallback).

export type DragRowApi = {
  index: number;
  isFirst: boolean;
  isLast: boolean;
  dragging: boolean;
  locked: boolean;
  panHandlers: GestureResponderHandlers;
  moveUp: () => void;
  moveDown: () => void;
};

type Props<T> = {
  items: T[];
  keyExtractor: (item: T, index: number) => string;
  rowHeight: number;
  locked?: boolean;
  // Receives the reordered keys (in the new visual order).
  onReorder: (orderedKeys: string[]) => void;
  // Fires true when a drag gesture begins and false when it ends (on both
  // release and terminate) so a parent ScrollView can disable scrolling while a
  // row is being dragged.
  onDragActiveChange?: (active: boolean) => void;
  renderRow: (item: T, api: DragRowApi) => ReactNode;
};

export function DragList<T>({
  items,
  keyExtractor,
  rowHeight,
  locked = false,
  onReorder,
  onDragActiveChange,
  renderRow,
}: Props<T>) {
  const s = useThemedStyles(makeStyles);
  const dragY = useRef(new Animated.Value(0)).current;
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [targetIndex, setTargetIndex] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const targetIndexRef = useRef<number | null>(null);
  const lenRef = useRef(items.length);
  lenRef.current = items.length;

  const keys = items.map(keyExtractor);

  function commit(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return;
    const next = [...keys];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorder(next);
  }

  function handleDragStart(index: number) {
    dragIndexRef.current = index;
    targetIndexRef.current = index;
    setDragIndex(index);
    setTargetIndex(index);
    dragY.setValue(0);
    onDragActiveChange?.(true);
  }

  function handleDragMove(startIndex: number, dy: number) {
    dragY.setValue(dy);
    const raw = startIndex + Math.round(dy / rowHeight);
    const clamped = Math.max(0, Math.min(lenRef.current - 1, raw));
    if (clamped !== targetIndexRef.current) {
      targetIndexRef.current = clamped;
      setTargetIndex(clamped);
    }
  }

  function handleDragEnd() {
    const from = dragIndexRef.current;
    const to = targetIndexRef.current;
    dragIndexRef.current = null;
    targetIndexRef.current = null;
    setDragIndex(null);
    setTargetIndex(null);
    dragY.setValue(0);
    onDragActiveChange?.(false);
    if (from == null || to == null) return;
    commit(from, to);
  }

  // Vertical offset for a non-dragged row so the list opens a gap at the target.
  function slotShift(i: number): number {
    if (dragIndex == null || targetIndex == null || i === dragIndex) return 0;
    if (dragIndex < targetIndex && i > dragIndex && i <= targetIndex) return -rowHeight;
    if (dragIndex > targetIndex && i >= targetIndex && i < dragIndex) return rowHeight;
    return 0;
  }

  return (
    <View style={[s.list, { height: items.length * rowHeight }]}>
      {items.map((item, i) => (
        <DragListRow
          key={keys[i]}
          rowHeight={rowHeight}
          index={i}
          total={items.length}
          locked={locked}
          dragging={dragIndex === i}
          shift={slotShift(i)}
          dragY={dragY}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragEnd={handleDragEnd}
          moveUp={() => commit(i, i - 1)}
          moveDown={() => commit(i, i + 1)}
        >
          {(api) => renderRow(item, api)}
        </DragListRow>
      ))}
    </View>
  );
}

function DragListRow({
  rowHeight,
  index,
  total,
  locked,
  dragging,
  shift,
  dragY,
  onDragStart,
  onDragMove,
  onDragEnd,
  moveUp,
  moveDown,
  children,
}: {
  rowHeight: number;
  index: number;
  total: number;
  locked: boolean;
  dragging: boolean;
  shift: number;
  dragY: Animated.Value;
  onDragStart: (index: number) => void;
  onDragMove: (index: number, dy: number) => void;
  onDragEnd: () => void;
  moveUp: () => void;
  moveDown: () => void;
  children: (api: DragRowApi) => ReactNode;
}) {
  const s = useThemedStyles(makeStyles);
  // Mirror per-render values into a ref so the once-created PanResponder always
  // reads this row's current index / locked flag / callbacks.
  const cfg = useRef({ index, locked, onDragStart, onDragMove, onDragEnd });
  cfg.current = { index, locked, onDragStart, onDragMove, onDragEnd };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !cfg.current.locked,
        onMoveShouldSetPanResponder: () => !cfg.current.locked,
        onPanResponderGrant: () => cfg.current.onDragStart(cfg.current.index),
        onPanResponderMove: (_e, g) => cfg.current.onDragMove(cfg.current.index, g.dy),
        onPanResponderRelease: () => cfg.current.onDragEnd(),
        onPanResponderTerminate: () => cfg.current.onDragEnd(),
      }),
    [],
  );

  const transform = dragging ? [{ translateY: dragY }] : [{ translateY: shift }];

  return (
    <Animated.View
      style={[
        s.row,
        { top: index * rowHeight, height: rowHeight, transform },
        dragging && s.lifted,
      ]}
    >
      {children({
        index,
        isFirst: index === 0,
        isLast: index === total - 1,
        dragging,
        locked,
        panHandlers: responder.panHandlers,
        moveUp,
        moveDown,
      })}
    </Animated.View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  list: { position: 'relative' },
  row: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: t.colors.surface,
  },
  lifted: {
    zIndex: 10,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
});
