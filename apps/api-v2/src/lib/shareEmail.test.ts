import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { defaultShareEmailSender } from './shareEmail';

// Same degrade-path discipline as lib/mail.test.ts: strip SMTP_* before each
// assertion so the unconfigured path is deterministic regardless of ambient env.
function clearSmtpEnv() {
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.SMTP_FROM;
}

let stubUserSeq = 0;
function withStubbedTransport(): { sent: Array<{ to: string; subject: string; text: string }>; restore: () => void } {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const fakeTransport = { sendMail: async (opts: { to: string; subject: string; text: string }) => { sent.push(opts); return { messageId: 'stub-id' }; } };
  const m = mock.method(nodemailer, 'createTransport', () => fakeTransport as never);
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_USER = `u${stubUserSeq++}`;
  process.env.SMTP_PASS = 'p';
  process.env.SMTP_FROM = 'from@example.com';
  return { sent, restore: () => { m.mock.restore(); clearSmtpEnv(); } };
}

test('sendMediaShareEmail degrades to { sent:false, reason:smtp-not-configured } when SMTP is unconfigured', async () => {
  clearSmtpEnv();
  const res = await defaultShareEmailSender.sendMediaShareEmail({
    to: 'nobody@example.com', senderName: 'Jane Tech', note: 'Kitchen', mediaId: 'media-1',
  });
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'smtp-not-configured');
});

test('sendMediaShareEmail sends under the Notification category with a deep link and the note', async () => {
  const { sent, restore } = withStubbedTransport();
  try {
    const res = await defaultShareEmailSender.sendMediaShareEmail({
      to: 'crew@example.com', senderName: 'Jane Tech', note: 'Kitchen', mediaId: 'media-1',
    });
    assert.equal(res.sent, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'crew@example.com');
    assert.equal(sent[0].subject, 'Notification: Jane Tech shared a photo with you');
    assert.match(sent[0].text, /Jane Tech shared a photo with you — Kitchen\./);
    assert.match(sent[0].text, /media\?id=media-1/);
  } finally {
    restore();
  }
});

test('sendMediaShareEmail omits the note clause when note is null', async () => {
  const { sent, restore } = withStubbedTransport();
  try {
    await defaultShareEmailSender.sendMediaShareEmail({
      to: 'crew@example.com', senderName: 'Jane Tech', note: null, mediaId: 'media-2',
    });
    assert.match(sent[0].text, /^Jane Tech shared a photo with you\.\n\n/);
  } finally {
    restore();
  }
});
