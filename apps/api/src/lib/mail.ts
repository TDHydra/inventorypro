// SMTP mail primitive (nodemailer). Config comes entirely from env; when SMTP is
// unconfigured we DEGRADE — log a warning and return { sent: false } rather than
// throw — so business flows (e.g. the admin "reset & email access code" endpoint)
// keep working and can fall back to handing the code off in-band. Nothing here
// ever throws into a request handler.
import nodemailer, { type Transporter } from 'nodemailer';

// Message type used to prefix the final subject (#66), e.g. 'Account: …'. Lets a
// recipient triage InventoryPro mail by kind at a glance. Optional — omit it and
// the subject is sent verbatim (backward compatible).
export type MailCategory = 'Notification' | 'Alert' | 'Stock' | 'Account';

export interface SendMailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  category?: MailCategory;
}

export interface SendMailResult {
  sent: boolean;
  reason?: 'smtp-not-configured' | 'send-failed';
  messageId?: string;
  error?: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

// Read + validate SMTP env. Requires host + from + user + pass; port defaults to
// 587. Returns null (→ degrade) when the minimum isn't present.
export function readSmtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  const from = env.SMTP_FROM?.trim();
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS;
  if (!host || !from || !user || !pass) return null;
  const port = env.SMTP_PORT ? parseInt(env.SMTP_PORT, 10) : 587;
  return { host, port: Number.isFinite(port) ? port : 587, user, pass, from };
}

// Lazily build (and memoize) the transport so importing this module has no side
// effects and tests can run without any SMTP env.
let cachedTransport: Transporter | null = null;
let cachedConfigKey: string | null = null;

function getTransport(cfg: SmtpConfig): Transporter {
  const key = `${cfg.host}:${cfg.port}:${cfg.user}`;
  if (cachedTransport && cachedConfigKey === key) return cachedTransport;
  cachedTransport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465, // implicit TLS on 465; STARTTLS otherwise
    auth: { user: cfg.user, pass: cfg.pass },
  });
  cachedConfigKey = key;
  return cachedTransport;
}

export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  const cfg = readSmtpConfig();
  if (!cfg) {
    console.warn('[mail] SMTP not configured (set SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM) — skipping send to', input.to);
    return { sent: false, reason: 'smtp-not-configured' };
  }
  // Prefix the subject with the message type when a category is present (#66);
  // otherwise send the subject unchanged.
  const subject = input.category ? `${input.category}: ${input.subject}` : input.subject;
  try {
    const info = await getTransport(cfg).sendMail({
      from: cfg.from,
      to: input.to,
      subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
    });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    // Never throw into business logic — surface the failure as a result.
    console.error('[mail] send failed:', (err as Error).message);
    return { sent: false, reason: 'send-failed', error: (err as Error).message };
  }
}

// One-time enrollment code email. The 6-digit code lets a not-yet-onboarded user
// set their first PIN via /auth/set-pin. Plain + HTML bodies.
export async function sendEnrollmentCodeEmail(
  to: string,
  code: string,
  userName: string,
): Promise<SendMailResult> {
  const subject = 'Your InventoryPro access code';
  const text =
    `Hi ${userName},\n\n` +
    `Your one-time InventoryPro access code is: ${code}\n\n` +
    `Open the InventoryPro app, choose your name, and enter this code to set your PIN. ` +
    `The code can only be used once.\n\n` +
    `If you didn't expect this, contact your administrator.`;
  const html =
    `<p>Hi ${escapeHtml(userName)},</p>` +
    `<p>Your one-time InventoryPro access code is:</p>` +
    `<p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:16px 0;">${escapeHtml(code)}</p>` +
    `<p>Open the InventoryPro app, choose your name, and enter this code to set your PIN. ` +
    `The code can only be used once.</p>` +
    `<p style="color:#888;font-size:12px;">If you didn't expect this, contact your administrator.</p>`;
  return sendMail({ to, subject, text, html, category: 'Account' });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}
