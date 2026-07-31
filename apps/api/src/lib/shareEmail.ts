// #171 email leg: a provider-agnostic stub for "a shared photo landed in your
// pool" email, sitting behind MEDIA_SHARE_EMAIL=1 (default OFF — this ships as
// a dormant stub, not a live provider decision). No new dependency: it
// delegates straight to the existing SMTP-env mailer (lib/mail.ts), which
// already degrades to { sent:false, reason:'smtp-not-configured' } instead of
// throwing when SMTP isn't configured — "no real provider" here just means
// nobody has set SMTP_* in prod yet.
import { sendMail } from './mail';

// Web app deep-link base (invenpro.app, split-origin from api.invenpro.app —
// see index.ts CORS comments). Overridable for non-prod environments; the
// email body degrades to a plain sentence if the link never resolves, so a
// wrong/missing env value here is cosmetic, not a failure mode.
const APP_URL = (process.env.PUBLIC_APP_URL ?? 'https://invenpro.app').replace(/\/+$/, '');

export interface ShareEmailInput {
  to: string;
  senderName: string;
  note: string | null;
  mediaId: string;
}

export interface ShareEmailResult {
  sent: boolean;
  reason?: string;
}

// Injectable seam (the me.ts:51-56 injected-sendCode pattern): production uses
// `defaultShareEmailSender` (real SMTP mailer, or a graceful degrade); tests
// inject a stub to assert on recipients/content without touching SMTP env.
export interface ShareEmailSender {
  sendMediaShareEmail(input: ShareEmailInput): Promise<ShareEmailResult>;
}

export const defaultShareEmailSender: ShareEmailSender = {
  async sendMediaShareEmail({ to, senderName, note, mediaId }): Promise<ShareEmailResult> {
    const subject = `${senderName} shared a photo with you`;
    const intro = note
      ? `${senderName} shared a photo with you — ${note}.`
      : `${senderName} shared a photo with you.`;
    const text = `${intro}\n\nOpen it in InventoryPro: ${APP_URL}/media?id=${mediaId}`;
    const result = await sendMail({ to, subject, text, category: 'Notification' });
    return result.reason ? { sent: result.sent, reason: result.reason } : { sent: result.sent };
  },
};
