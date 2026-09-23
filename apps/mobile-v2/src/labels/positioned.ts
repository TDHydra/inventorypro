// Shared, platform-agnostic renderer for CUSTOM label templates (the visual
// label-designer feature). Produces a print-ready HTML string with each field
// ABSOLUTELY positioned per the template's coordinates — as opposed to the fixed
// flex layout of the built-in presets in printLabel.ts. Both printLabel.ts
// (native, expo-print) and printLabel.web.ts (web, iframe) import buildPositionedDoc
// from here and only supply their own print mechanism, so this render logic lives
// in ONE place (not duplicated across the two mirror files).
//
// Pure JS: qrcode → inline SVG, jsbarcode → hand-painted SVG. No canvas/DOM/network,
// so it runs on native + web + under node:test.
import * as QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';

// The `declare module 'qrcode'` ambient in printLabel.ts is program-global, so
// QRCode.toString is typed here without redeclaring.

export type LabelFieldType = 'qr' | 'code128' | 'item_name' | 'asset_tag' | 'static_text';

export interface LabelField {
  id: string;
  type: LabelFieldType;
  /** Position + size as a 0..1 fraction of the label's width/height. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Text fields only. */
  fontPt?: number;
  align?: 'left' | 'center' | 'right';
  /** static_text only — the literal string to print. */
  text?: string;
}

export interface LabelTemplateModel {
  id: string;
  name: string;
  widthIn: number;
  heightIn: number;
  dpi: number;
  fields: LabelField[];
}

/** The entity data a template binds to at print time (available at every call site). */
export interface LabelData {
  name: string;
  code: string;
  payload: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function qrSvg(payload: string): Promise<string> {
  // width is nominal — CSS (.pf svg { width/height:100% }) scales it into the
  // field box; the viewBox + default preserveAspectRatio keeps it square.
  return QRCode.toString(payload || ' ', { type: 'svg', margin: 0, width: 256 });
}

function code128Svg(value: string, widthPx = 480, heightPx = 160): string {
  const obj: { encodings?: Array<{ data: string }> } = {};
  try {
    JsBarcode(obj, value || ' ', { format: 'CODE128', displayValue: false, margin: 0 });
  } catch {
    return '';
  }
  const bin = obj.encodings?.[0]?.data ?? '';
  const n = bin.length;
  if (n === 0) return '';
  const unit = widthPx / n;
  let rects = '';
  let i = 0;
  while (i < n) {
    if (bin[i] === '1') {
      let j = i;
      while (j < n && bin[j] === '1') j++;
      rects += `<rect x="${(i * unit).toFixed(3)}" y="0" width="${((j - i) * unit).toFixed(3)}" height="${heightPx}" fill="#000"/>`;
      i = j;
    } else i++;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${widthPx} ${heightPx}" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges">${rects}</svg>`;
}

function pct(n: number): string {
  return `${(Math.max(0, Math.min(1, n)) * 100).toFixed(3)}%`;
}

/** Resolve a field's bound text (empty for graphic fields). */
export function fieldText(field: LabelField, data: LabelData): string {
  switch (field.type) {
    case 'item_name': return data.name;
    case 'asset_tag': return data.code;
    case 'static_text': return field.text ?? '';
    default: return '';
  }
}

async function renderField(field: LabelField, data: LabelData): Promise<string> {
  const box = `position:absolute;left:${pct(field.x)};top:${pct(field.y)};width:${pct(field.w)};height:${pct(field.h)};overflow:hidden;`;
  if (field.type === 'qr' || field.type === 'code128') {
    const svg = field.type === 'qr' ? await qrSvg(data.payload) : code128Svg(data.payload);
    return `<div class="pf pf-media" style="${box}">${svg}</div>`;
  }
  const align = field.align ?? 'center';
  const justify = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
  const fontPt = field.fontPt ?? 10;
  return `<div class="pf" style="${box}justify-content:${justify};">` +
    `<span style="font-size:${fontPt}pt;text-align:${align};">${escapeHtml(fieldText(field, data))}</span></div>`;
}

/** One positioned `.plabel` block (relative box + absolute field children). */
export async function buildPositionedLabelBlock(model: LabelTemplateModel, data: LabelData): Promise<string> {
  const widthMm = (model.widthIn * 25.4).toFixed(1);
  const heightMm = (model.heightIn * 25.4).toFixed(1);
  const fields = await Promise.all(model.fields.map((f) => renderField(f, data)));
  return `<div class="plabel" style="width:${widthMm}mm;height:${heightMm}mm;">${fields.join('')}</div>`;
}

/**
 * Full print HTML for N labels of ONE custom template, one page-broken block each.
 * `@page` is sized to the template's media so a single print job emits N labels.
 */
export async function buildPositionedDoc(model: LabelTemplateModel, dataList: LabelData[]): Promise<string> {
  const widthMm = (model.widthIn * 25.4).toFixed(1);
  const heightMm = (model.heightIn * 25.4).toFixed(1);
  const blocks = await Promise.all(dataList.map((d) => buildPositionedLabelBlock(model, d)));
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #ffffff; }
  .plabel {
    position: relative;
    background: #ffffff;
    overflow: hidden;
    font-family: -apple-system, Helvetica, Arial, sans-serif;
    page-break-after: always;
  }
  .plabel:last-child { page-break-after: auto; }
  /* Fields fill their absolutely-positioned box; viewBox keeps QR/barcode aspect. */
  .pf { display: flex; align-items: center; justify-content: center; }
  .pf svg { width: 100%; height: 100%; display: block; }
  .pf span { color: #1E293B; word-break: break-word; line-height: 1.1; width: 100%; }
</style>
</head>
<body>
${blocks.join('\n')}
</body>
</html>`;
}
