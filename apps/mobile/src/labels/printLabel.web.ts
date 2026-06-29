// Web shim for ../labels/printLabel (native uses expo-print). Builds the SAME
// label HTML and prints it via the browser's window.print() instead of the OS
// print module. Exports the SAME symbols/signatures so shared call sites work
// unchanged. Degrades gracefully (no throw at import time).
import { getValidJwt } from '../auth/session';

export type LabelTemplate = 'small' | 'standard' | 'large';

export interface TemplateSpec {
  widthIn: number;
  heightIn: number;
  qrPx: number;
  fontPt: number;
}

export const LABEL_TEMPLATES: Record<LabelTemplate, TemplateSpec> = {
  small: { widthIn: 2.25, heightIn: 1.25, qrPx: 90, fontPt: 7 },
  standard: { widthIn: 4.0, heightIn: 2.0, qrPx: 140, fontPt: 10 },
  large: { widthIn: 4.0, heightIn: 3.0, qrPx: 200, fontPt: 13 },
};

export interface PrintLabelOpts {
  title: string;
  code: string;
  qrUrl: string;
  template: LabelTemplate;
}

/**
 * Fetch the auth-protected QR PNG, convert it to a base64 data URI, compose an
 * HTML label sized per the chosen template, and invoke the browser print dialog
 * (window.print() of a generated, off-screen label DOM in an iframe).
 */
export async function printLabel(opts: PrintLabelOpts): Promise<void> {
  const { title, code, qrUrl, template } = opts;
  const spec = LABEL_TEMPLATES[template];

  // Fetch the QR PNG from the auth-protected API endpoint.
  const jwt = await getValidJwt();
  const headers: Record<string, string> = {};
  if (jwt) {
    headers['Authorization'] = `Bearer ${jwt}`;
  }

  const response = await fetch(qrUrl, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch QR code: ${response.status} ${response.statusText}`);
  }

  // Convert the PNG blob to a base64 data URI so the print document is
  // self-contained (the print frame carries no auth headers).
  const arrayBuffer = await response.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < uint8.length; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  const base64 = btoa(binary);
  const dataUri = `data:image/png;base64,${base64}`;

  // Convert inches to mm for CSS (96 dpi → exact physical size via @page).
  const widthMm = (spec.widthIn * 25.4).toFixed(1);
  const heightMm = (spec.heightIn * 25.4).toFixed(1);

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page {
    size: ${widthMm}mm ${heightMm}mm;
    margin: 0;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: ${widthMm}mm;
    height: ${heightMm}mm;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2mm;
    font-family: -apple-system, Helvetica, Arial, sans-serif;
    background: #ffffff;
  }
  .title {
    font-size: ${spec.fontPt}pt;
    font-weight: 700;
    color: #1E293B;
    text-align: center;
    word-break: break-word;
    max-width: 100%;
    margin-bottom: 2mm;
    line-height: 1.2;
  }
  .qr {
    width: ${spec.qrPx}px;
    height: ${spec.qrPx}px;
    display: block;
  }
  .code {
    font-size: ${Math.max(spec.fontPt - 1, 6)}pt;
    color: #64748B;
    text-align: center;
    margin-top: 2mm;
    word-break: break-all;
    max-width: 100%;
  }
</style>
</head>
<body>
  <div class="title">${escapeHtml(title)}</div>
  <img class="qr" src="${dataUri}" alt="QR code" />
  <div class="code">${escapeHtml(code)}</div>
</body>
</html>`;

  await printHtml(html);
}

/**
 * Render the label HTML into a hidden iframe and trigger the browser print
 * dialog, then clean up. Resolves once printing has been invoked. No-op when
 * there is no DOM (e.g. SSR/test environments).
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
      iframe.style.position = 'fixed';
      iframe.style.right = '0';
      iframe.style.bottom = '0';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = '0';

      const cleanup = () => {
        // Remove on the next tick so the print dialog has captured the doc.
        setTimeout(() => {
          if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        }, 1000);
      };

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

      document.body.appendChild(iframe);
      const doc = iframe.contentWindow?.document;
      if (!doc) {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        resolve();
        return;
      }
      doc.open();
      doc.write(html);
      doc.close();
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
