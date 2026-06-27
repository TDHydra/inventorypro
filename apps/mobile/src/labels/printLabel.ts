import * as Print from 'expo-print';
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
 * HTML label sized per the chosen template, and invoke the OS print dialog.
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

  // Convert the PNG blob to a base64 data URI so the print HTML is self-contained
  // (the WebView that renders it has no auth headers).
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

  await Print.printAsync({ html });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
