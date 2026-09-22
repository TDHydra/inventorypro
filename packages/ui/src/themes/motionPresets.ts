import { Animated } from 'react-native';
import type { AlertPresentation, SheetPresentation, Theme } from './types';

/**
 * Core-Animated presets for the popup presentation enums. One place maps a
 * theme's presentation choice to enter/exit animation recipes, so ModalSheet
 * and themedAlert stay single implementations. NO reanimated/moti — native
 * driver transform/opacity only (layout properties never spring).
 */

export interface EnterAnimation {
  /** Initial value for the driver (0 = hidden, 1 = shown). */
  from: number;
  /** Build the enter animation toward 1. */
  enter: (v: Animated.Value, theme: Theme) => Animated.CompositeAnimation;
  /** Build the exit animation toward 0. */
  exit: (v: Animated.Value, theme: Theme) => Animated.CompositeAnimation;
}

function timing(v: Animated.Value, to: number, duration: number, theme: Theme): Animated.CompositeAnimation {
  return Animated.timing(v, { toValue: to, duration, easing: theme.motion.easing, useNativeDriver: true });
}

function spring(v: Animated.Value, to: number, theme: Theme): Animated.CompositeAnimation {
  const cfg = theme.motion.spring ?? { damping: 15, stiffness: 180 };
  return Animated.spring(v, { toValue: to, damping: cfg.damping, stiffness: cfg.stiffness, mass: 1, useNativeDriver: true });
}

/** Slide/fade drivers per sheet presentation. Consumers interpolate translateY/opacity/scale off the single driver. */
export const sheetAnimations: Record<SheetPresentation, EnterAnimation> = {
  'slide-bottom': {
    from: 0,
    enter: (v, t) => timing(v, 1, t.motion.duration.base, t),
    exit: (v, t) => timing(v, 0, t.motion.duration.fast, t),
  },
  'slide-fast': {
    from: 0,
    enter: (v, t) => timing(v, 1, t.motion.duration.fast, t),
    exit: (v, t) => timing(v, 0, t.motion.duration.fast, t),
  },
  'spring-bottom': {
    from: 0,
    enter: (v, t) => spring(v, 1, t),
    exit: (v, t) => timing(v, 0, t.motion.duration.fast, t),
  },
  'center-dialog': {
    from: 0,
    enter: (v, t) => timing(v, 1, t.motion.duration.fast, t),
    exit: (v, t) => timing(v, 0, t.motion.duration.fast, t),
  },
};

export const alertAnimations: Record<AlertPresentation, EnterAnimation> = {
  fade: {
    from: 0,
    enter: (v, t) => timing(v, 1, t.motion.duration.fast, t),
    exit: (v, t) => timing(v, 0, t.motion.duration.fast, t),
  },
  'fade-scale': {
    from: 0,
    enter: (v, t) => timing(v, 1, t.motion.duration.base, t),
    exit: (v, t) => timing(v, 0, t.motion.duration.fast, t),
  },
  'slide-up': {
    from: 0,
    enter: (v, t) => timing(v, 1, t.motion.duration.fast, t),
    exit: (v, t) => timing(v, 0, t.motion.duration.fast, t),
  },
  'spring-pop': {
    from: 0,
    enter: (v, t) => spring(v, 1, t),
    exit: (v, t) => timing(v, 0, t.motion.duration.fast, t),
  },
};
