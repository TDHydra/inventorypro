import { isWidgetType, type WidgetType } from './widgetRegistry';

// #226: composite star keys. #196 starred whole widgets by their WidgetType;
// a composite `widget:source` key stars one configured instance (today:
// work-list sources, e.g. 'work-list:my-jobs'). Stored in the same
// starred_widgets string array — old app versions filter unknown keys out via
// isWidgetType and simply don't render them (forward compat, no migration).

export interface ParsedStarKey {
  widget: WidgetType;
  source?: string;
}

export function makeStarKey(widget: WidgetType, source?: string): string {
  return source ? `${widget}:${source}` : widget;
}

// Null for anything that isn't `<known widget>` or `<known widget>:<source>`.
// The source half is returned raw — the consumer validates it against its own
// source registry (WORK_LIST_DEFS etc.), keeping this module registry-agnostic.
export function parseStarKey(key: string): ParsedStarKey | null {
  if (typeof key !== 'string' || !key) return null;
  const sep = key.indexOf(':');
  if (sep === -1) return isWidgetType(key) ? { widget: key } : null;
  const widget = key.slice(0, sep);
  const source = key.slice(sep + 1);
  if (!isWidgetType(widget) || !source) return null;
  return { widget, source };
}
