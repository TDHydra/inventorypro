import { useMemo, useRef, type ReactNode } from 'react';
import type { StyleProp, ViewStyle, GestureResponderEvent, PanResponderGestureState } from 'react-native';

// react-native's index ships Flow syntax that the pure test runner (tsx/esbuild)
// cannot parse, so we never *statically* import runtime values from it here.
// All gesture/geometry logic below is RN-free and unit-tested directly; only the
// React component (rendered on-device by Metro) reaches for RN, lazily.
declare const require: (module: string) => unknown;

// ── Pure geometry (unit-tested) ─────────────────────────────────────────────
export const MIN_SIZE = 0.06;

export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export interface BoxRect { x: number; y: number; w: number; h: number }

/** New normalized top-left after dragging by (dx,dy) px on a canvasW×canvasH canvas, kept on-canvas. */
export function clampMove(rect: BoxRect, dx: number, dy: number, canvasW: number, canvasH: number): { x: number; y: number } {
  return {
    x: clamp(rect.x + dx / canvasW, 0, 1 - rect.w),
    y: clamp(rect.y + dy / canvasH, 0, 1 - rect.h),
  };
}

/** New normalized size, anchored to the size captured on grant so cumulative delta isn't double-counted. */
export function clampResize(
  startW: number, startH: number, rect: BoxRect,
  dx: number, dy: number, canvasW: number, canvasH: number,
  minSize = MIN_SIZE,
): { w: number; h: number } {
  return {
    w: clamp(startW + dx / canvasW, minSize, 1 - rect.x),
    h: clamp(startH + dy / canvasH, minSize, 1 - rect.y),
  };
}

// ── PanResponder configs (arbitration, unit-tested) ─────────────────────────
type GState = Pick<PanResponderGestureState, 'dx' | 'dy'>;

/** Subset of PanResponder config we build/test; superset of what PanResponder.create accepts. */
export interface ResponderConfig {
  onStartShouldSetPanResponder: () => boolean;
  onMoveShouldSetPanResponder: () => boolean;
  onPanResponderTerminationRequest?: () => boolean;
  onPanResponderGrant: () => void;
  onPanResponderMove: (e: GestureResponderEvent | null, g: GState) => void;
  onPanResponderRelease: (e: GestureResponderEvent | null, g: GState) => void;
  onPanResponderTerminate: () => void;
}

export interface BoxResponderDeps {
  getRect: () => BoxRect;
  getCanvas: () => { w: number; h: number };
  getId: () => string;
  getMinSize: () => number;
  onChange: (id: string, patch: Partial<BoxRect>) => void;
  onSelect: (id: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** Animated.event handler that maps the gesture delta onto the pan value (RN side). */
  dragMove: (e: GestureResponderEvent | null, g: GState) => void;
  /** Reset the pan translate back to 0 (RN side). */
  resetPan: () => void;
}

/**
 * Build the body-drag and corner-resize PanResponder configs.
 *
 * Gesture arbitration fix: the corner handle is a descendant of the body, so it
 * wins the touch *start* (bubbling, deepest node first). But the body drag uses
 * `onMoveShouldSetPanResponder: () => true`, which would ask the corner to
 * terminate on the very first move and steal the gesture — turning a resize into
 * a move. The resize responder therefore returns `false` from
 * `onPanResponderTerminationRequest`, refusing to hand the gesture to the body.
 */
export function buildBoxResponders(d: BoxResponderDeps): { drag: ResponderConfig; resize: ResponderConfig } {
  const drag: ResponderConfig = {
    onStartShouldSetPanResponder: () => true,
    // Claim on any move so the parent ScrollView cannot steal it mid-drag.
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      d.onDragStart();
      d.onSelect(d.getId());
    },
    onPanResponderMove: d.dragMove,
    onPanResponderRelease: (_e, g) => {
      d.onDragEnd();
      d.resetPan();
      d.onChange(d.getId(), clampMove(d.getRect(), g.dx, g.dy, d.getCanvas().w, d.getCanvas().h));
    },
    onPanResponderTerminate: () => {
      d.onDragEnd();
      d.resetPan();
    },
  };

  let startW = 0;
  let startH = 0;
  const resize: ResponderConfig = {
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    // ⬇ THE FIX: refuse to yield the responder to the body-drag PanResponder.
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      d.onDragStart();
      d.onSelect(d.getId());
      const r = d.getRect();
      startW = r.w;
      startH = r.h;
    },
    onPanResponderMove: (_e, g) => {
      const c = d.getCanvas();
      d.onChange(d.getId(), clampResize(startW, startH, d.getRect(), g.dx, g.dy, c.w, c.h, d.getMinSize()));
    },
    onPanResponderRelease: () => d.onDragEnd(),
    onPanResponderTerminate: () => d.onDragEnd(),
  };

  return { drag, resize };
}

// ── Component (RN, rendered on-device) ──────────────────────────────────────
export interface DraggableResizableBoxProps {
  id: string;
  /** Normalized position/size in [0,1] relative to the canvas. */
  x: number; y: number; w: number; h: number;
  canvasW: number; canvasH: number;
  selected: boolean;
  onSelect: (id: string) => void;
  onChange: (id: string, patch: Partial<BoxRect>) => void;
  /** Fired when a drag/resize starts — used to freeze parent scroll. */
  onDragStart: () => void;
  /** Fired when a drag/resize ends or is cancelled. */
  onDragEnd: () => void;
  minSize?: number;
  style?: StyleProp<ViewStyle>;
  selectedStyle?: StyleProp<ViewStyle>;
  /** Style of the corner resize handle; only rendered while `selected`. */
  handleStyle?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

export function DraggableResizableBox(props: DraggableResizableBoxProps) {
  const {
    id, x, y, w, h, canvasW, canvasH, selected,
    onSelect, onChange, onDragStart, onDragEnd,
    minSize = MIN_SIZE, style, selectedStyle, handleStyle, children,
  } = props;

  const RN = require('react-native') as typeof import('react-native');
  const { PanResponder, Animated, View } = RN;

  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;

  // Ref mirror so the once-created PanResponders always read fresh props.
  const cfg = useRef({ id, x, y, w, h, canvasW, canvasH, minSize, onSelect, onChange, onDragStart, onDragEnd });
  cfg.current = { id, x, y, w, h, canvasW, canvasH, minSize, onSelect, onChange, onDragStart, onDragEnd };

  const { drag, resize } = useMemo(() => {
    const dragMove = Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false });
    const configs = buildBoxResponders({
      getRect: () => ({ x: cfg.current.x, y: cfg.current.y, w: cfg.current.w, h: cfg.current.h }),
      getCanvas: () => ({ w: cfg.current.canvasW, h: cfg.current.canvasH }),
      getId: () => cfg.current.id,
      getMinSize: () => cfg.current.minSize,
      onChange: (i, p) => cfg.current.onChange(i, p),
      onSelect: (i) => cfg.current.onSelect(i),
      onDragStart: () => cfg.current.onDragStart(),
      onDragEnd: () => cfg.current.onDragEnd(),
      dragMove: (e, g) => dragMove(e as GestureResponderEvent, g as PanResponderGestureState),
      resetPan: () => pan.setValue({ x: 0, y: 0 }),
    });
    return {
      drag: PanResponder.create(configs.drag),
      resize: PanResponder.create(configs.resize),
    };
  }, [pan, PanResponder, Animated]);

  return (
    <Animated.View
      {...drag.panHandlers}
      style={[
        style,
        selected && selectedStyle,
        {
          position: 'absolute',
          left: x * canvasW, top: y * canvasH,
          width: w * canvasW, height: h * canvasH,
          transform: pan.getTranslateTransform(),
        },
      ]}
    >
      {children}
      {selected && <View {...resize.panHandlers} style={handleStyle} />}
    </Animated.View>
  );
}
