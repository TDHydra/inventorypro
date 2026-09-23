// Web shim for ../labels/printLabel (native uses expo-print). Builds the SAME
// label HTML — with an offline-generated QR / Code 128 embedded inline — and
// prints it via a hidden iframe + window.print() instead of the OS print module.
// Exports the SAME symbols/signatures so shared call sites work unchanged.
// Degrades gracefully (no throw) when there is no DOM.
//
// NOTE: the ambient `declare module 'qrcode'` lives in printLabel.ts and is
// program-global, so this file reuses it without redeclaring.
import * as QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';
import { buildPositionedDoc, type LabelTemplateModel, type LabelData } from './positioned';
import { signWithConfig } from '../scan/qrSignConfig';

export type LabelTemplate =
  | 'small'
  | 'standard'
  | 'large'
  | 'dymo30252'
  | 'dymo30336'
  | 'zebra2x1'
  | 'avery5160';

/** Which machine-readable symbol to render on the label. */
export type BarcodeFormat = 'qr' | 'code128';

export interface TemplateSpec {
  /** Human label shown in the picker chip. */
  name: string;
  widthIn: number;
  heightIn: number;
  /** Printer resolution the preset targets (informational; @page uses inches). */
  dpi: number;
  qrPx: number;
  fontPt: number;
}

// Presets are pure data (no schema/DB). Sizes cover the thermal + sheet printers
// crews actually use: generic small/standard/large plus DYMO LabelWriter, Zebra
// thermal and Avery sheet stock. widthIn is the long edge (labels print wide).
export const LABEL_TEMPLATES: Record<LabelTemplate, TemplateSpec> = {
  small: { name: 'Small 2.25×1.25″', widthIn: 2.25, heightIn: 1.25, dpi: 203, qrPx: 90, fontPt: 7 },
  standard: { name: 'Standard 4×2″', widthIn: 4.0, heightIn: 2.0, dpi: 203, qrPx: 140, fontPt: 10 },
  large: { name: 'Large 4×3″', widthIn: 4.0, heightIn: 3.0, dpi: 203, qrPx: 200, fontPt: 13 },
  dymo30252: { name: 'DYMO Address 3.5×1.125″', widthIn: 3.5, heightIn: 1.125, dpi: 300, qrPx: 96, fontPt: 8 },
  dymo30336: { name: 'DYMO Multi 2.125×1″', widthIn: 2.125, heightIn: 1.0, dpi: 300, qrPx: 82, fontPt: 7 },
  zebra2x1: { name: 'Zebra 2×1″', widthIn: 2.0, heightIn: 1.0, dpi: 203, qrPx: 80, fontPt: 7 },
  avery5160: { name: 'Avery 5160 2.625×1″', widthIn: 2.625, heightIn: 1.0, dpi: 300, qrPx: 84, fontPt: 7 },
};

export interface PrintLabelOpts {
  title: string;
  code: string;
  /**
   * Legacy prop kept for backward-compat with the [id] detail screens. The QR
   * is now generated offline in-browser, so this URL is only parsed to recover
   * the `INV:item:{id}` / `INV:unit:{tag}` scan payload — it is never fetched.
   */
  qrUrl: string;
  template: LabelTemplate;
  /** Explicit scan payload; overrides the one derived from `qrUrl`. */
  payload?: string;
  /** Symbology to print (default `qr`). */
  format?: BarcodeFormat;
}

/** One label in a batch print. */
export interface LabelItem {
  title: string;
  code: string;
  /** Scan payload, e.g. `INV:item:{id}` or `INV:unit:{tag}`. */
  payload: string;
  /** Per-item symbology override (falls back to the batch default). */
  format?: BarcodeFormat;
}

/**
 * Recover the scan payload from the legacy auth-QR URL. The detail screens pass
 * `${API}/labels/item/{id}/qr.png` or `${API}/labels/unit/{tag}/qr.png`; the
 * matching scan payloads are `INV:item:{id}` / `INV:unit:{tag}` (raw, un-decoded
 * so it round-trips with resolveScan). Falls back to the raw URL if it doesn't
 * match — a QR of the URL still resolves to something scannable.
 */
export function payloadFromQrUrl(qrUrl: string): string {
  const m = qrUrl.match(/\/labels\/(item|unit)\/(.+)\/qr\.png(?:[?#].*)?$/);
  if (m) return `INV:${m[1]}:${m[2]}`;
  return qrUrl;
}

/**
 * Generate a QR code as an inline SVG string, fully offline (pure JS, no canvas
 * or network). Sized to `qrPx` so it drops straight into the label HTML.
 */
async function qrSvg(payload: string, qrPx: number): Promise<string> {
  return QRCode.toString(payload, { type: 'svg', margin: 0, width: qrPx });
}

/**
 * Generate a Code 128 barcode as an inline SVG string, fully offline. jsbarcode's
 * object renderer (`JsBarcode({}, value, …)`) yields the raw binary module string
 * with no DOM/canvas dependency; we paint it into `<rect>` runs ourselves so the
 * same path works on native and web.
 */
function code128Svg(value: string, widthPx: number, heightPx: number): string {
  const obj: { encodings?: Array<{ data: string }> } = {};
  JsBarcode(obj, value, { format: 'CODE128', displayValue: false, margin: 0 });
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
      const x = (i * unit).toFixed(3);
      const w = ((j - i) * unit).toFixed(3);
      rects += `<rect x="${x}" y="0" width="${w}" height="${heightPx}" fill="#000"/>`;
      i = j;
    } else {
      i++;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}" shape-rendering="crispEdges">${rects}</svg>`;
}

/** Build the machine-readable graphic (QR square or Code 128 strip) for a label. */
async function mediaSvg(payload: string, spec: TemplateSpec, format: BarcodeFormat): Promise<string> {
  if (format === 'code128') {
    const barWidth = Math.max(spec.qrPx * 2.2, 160);
    const barHeight = Math.round(spec.qrPx * 0.55);
    return code128Svg(payload, barWidth, barHeight);
  }
  return qrSvg(payload, spec.qrPx);
}

/**
 * Compose the full print HTML for N labels. Each label is one `@page`-sized
 * block separated by a CSS page break, so a single print job emits N labels.
 * Wide-and-short presets (DYMO/Avery) lay the graphic beside the text; taller
 * presets stack them.
 */
function buildDoc(
  blocks: string[],
  spec: TemplateSpec,
  format: BarcodeFormat,
): string {
  const widthMm = (spec.widthIn * 25.4).toFixed(1);
  const heightMm = (spec.heightIn * 25.4).toFixed(1);
  const wide = spec.widthIn / spec.heightIn >= 1.9;
  const mediaCss =
    format === 'code128'
      ? `.media svg { max-width: 100%; height: auto; }`
      : `.media svg { width: ${spec.qrPx}px; height: ${spec.qrPx}px; display: block; }`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page {
    size: ${widthMm}mm ${heightMm}mm;
    margin: 0;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #ffffff; }
  .label {
    width: ${widthMm}mm;
    height: ${heightMm}mm;
    display: flex;
    flex-direction: ${wide ? 'row' : 'column'};
    align-items: center;
    justify-content: center;
    gap: 2mm;
    padding: 2mm;
    overflow: hidden;
    font-family: -apple-system, Helvetica, Arial, sans-serif;
    background: #ffffff;
    page-break-after: always;
  }
  .label:last-child { page-break-after: auto; }
  .media { flex: 0 0 auto; display: flex; align-items: center; justify-content: center; }
  ${mediaCss}
  .txt {
    display: flex;
    flex-direction: column;
    align-items: ${wide ? 'flex-start' : 'center'};
    justify-content: center;
    min-width: 0;
    ${wide ? 'flex: 1 1 auto;' : ''}
  }
  .title {
    font-size: ${spec.fontPt}pt;
    font-weight: 700;
    color: #1E293B;
    text-align: ${wide ? 'left' : 'center'};
    word-break: break-word;
    max-width: 100%;
    line-height: 1.2;
  }
  .code {
    font-size: ${Math.max(spec.fontPt - 1, 6)}pt;
    color: #64748B;
    text-align: ${wide ? 'left' : 'center'};
    margin-top: 1.5mm;
    word-break: break-all;
    max-width: 100%;
  }
</style>
</head>
<body>
${blocks.join('\n')}
</body>
</html>`;
}

/** One `.label` block: graphic + title + code. */
function labelBlockHtml(title: string, code: string, media: string): string {
  return `<div class="label">
  <div class="media">${media}</div>
  <div class="txt">
    <div class="title">${escapeHtml(title)}</div>
    <div class="code">${escapeHtml(code)}</div>
  </div>
</div>`;
}

/**
 * Compose an HTML label sized per the chosen template with an offline-generated
 * QR (or Code 128) symbol embedded inline, then invoke the browser print dialog.
 */
export async function printLabel(opts: PrintLabelOpts): Promise<void> {
  const { title, code, qrUrl, template } = opts;
  const format = opts.format ?? 'qr';
  const payload = opts.payload ?? payloadFromQrUrl(qrUrl);
  await printLabels([{ title, code, payload, format }], template, format);
}

/**
 * Batch print: compose ONE HTML document with N page-broken label blocks and
 * hand it to the browser print dialog in a single job. `format` is the default
 * symbology; individual items may override it.
 */
export async function printLabels(
  items: LabelItem[],
  template: LabelTemplate,
  format: BarcodeFormat = 'qr',
): Promise<void> {
  if (items.length === 0) return;
  const spec = LABEL_TEMPLATES[template];
  const blocks = await Promise.all(
    items.map(async (it) => {
      const media = await mediaSvg(signWithConfig(it.payload), spec, it.format ?? format);
      return labelBlockHtml(it.title, it.code, media);
    }),
  );
  const html = buildDoc(blocks, spec, format);
  await printHtml(html);
}

/**
 * Print N labels using a CUSTOM (visual-designer) template — web mirror of
 * printLabel.ts's printLabelsWithModel. Same positioned render (shared via
 * ./positioned), web iframe print mechanism.
 */
export async function printLabelsWithModel(items: LabelItem[], model: LabelTemplateModel): Promise<void> {
  if (items.length === 0) return;
  const data: LabelData[] = items.map((it) => ({ name: it.title, code: it.code, payload: signWithConfig(it.payload) }));
  const html = await buildPositionedDoc(model, data);
  await printHtml(html);
}

/**
 * Render the label HTML into a hidden iframe and trigger the browser print
 * dialog, then clean up. Resolves once printing has been invoked. No-op when
 * there is no DOM (e.g. SSR/test environments).
 *
 * Uses `srcdoc` (not document.write) so that `onload` fires exactly ONCE —
 * after the label content is ready — rather than for the initial about:blank
 * page, which would have called win.print() on an empty document and caused
 * the browser to print the main app window (the label picker sheet) instead.
 */
function printHtml(html: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (typeof document === 'undefined') {
      // No DOM to print from — degrade gracefully rather than throwing.
      resolve();
      return;
    }
    try {
      const iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      // Position off-screen but keep non-zero dimensions so browsers include
      // the iframe in layout; a 0×0 iframe may be skipped during printing.
      iframe.style.cssText =
        'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:0;';

      const cleanup = () => {
        // Remove on the next tick so the print dialog has captured the doc.
        setTimeout(() => {
          if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        }, 1000);
      };

      // onload fires once — after srcdoc content is fully parsed — never for
      // the initial blank navigation that document.write() would have triggered.
      iframe.onload = () => {
        try {
          const win = iframe.contentWindow;
          if (!win) {
            cleanup();
            resolve();
            return;
          }
          win.focus();
          win.print();
          cleanup();
          resolve();
        } catch (err) {
          cleanup();
          reject(err as Error);
        }
      };

      // Set srcdoc BEFORE appending so the single load is the label content.
      iframe.srcdoc = html;
      document.body.appendChild(iframe);
    } catch (err) {
      reject(err as Error);
    }
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
