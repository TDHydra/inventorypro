import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { readSmtpConfig, sendMail, sendEnrollmentCodeEmail } from './mail';

// Ensure the unconfigured-degrade path is deterministic regardless of the ambient
// environment the test runs in: strip SMTP_* before each assertion.
function clearSmtpEnv() {
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.SMTP_FROM;
}

// Configure minimal SMTP env so sendMail takes the send path (rather than the
// unconfigured-degrade path), and stub nodemailer's transport so we can observe
// the composed message without opening a socket. Returns the captured-sends array
// plus a restore() that undoes both the mock and the env.
let stubUserSeq = 0;
function withStubbedTransport(): { sent: Array<{ subject: string }>; restore: () => void } {
  const sent: Array<{ subject: string }> = [];
  const fakeTransport = { sendMail: async (opts: { subject: string }) => { sent.push(opts); return { messageId: 'stub-id' }; } };
  const m = mock.method(nodemailer, 'createTransport', () => fakeTransport as never);
  process.env.SMTP_HOST = 'smtp.example.com';
  // Unique user per call so getTransport's host:port:user cache key differs and it
  // rebuilds the (mocked) transport — otherwise the first stub is reused and this
  // call's `sent` array never receives the message.
  process.env.SMTP_USER = `u${stubUserSeq++}`;
  process.env.SMTP_PASS = 'p';
  process.env.SMTP_FROM = 'from@example.com';
  return { sent, restore: () => { m.mock.restore(); clearSmtpEnv(); } };
}

test('readSmtpConfig returns null when SMTP env is unconfigured', () => {
  clearSmtpEnv();
  assert.equal(readSmtpConfig(), null);
});

test('readSmtpConfig returns null when only some SMTP vars are set', () => {
  clearSmtpEnv();
  assert.equal(readSmtpConfig({ SMTP_HOST: 'smtp.example.com' } as NodeJS.ProcessEnv), null);
});

test('readSmtpConfig parses a full config and defaults port to 587', () => {
  const cfg = readSmtpConfig({
    SMTP_HOST: 'smtp.example.com',
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    SMTP_FROM: 'from@example.com',
  } as NodeJS.ProcessEnv);
  assert.ok(cfg);
  assert.equal(cfg!.port, 587);
});

test('sendMail degrades to { sent:false } (no throw) when SMTP is unconfigured', async () => {
  clearSmtpEnv();
  const res = await sendMail({ to: 'nobody@example.com', subject: 'x', text: 'y' });
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'smtp-not-configured');
});

test('sendEnrollmentCodeEmail degrades to { sent:false } (no throw) when unconfigured', async () => {
  clearSmtpEnv();
  const res = await sendEnrollmentCodeEmail('nobody@example.com', '123456', 'Jane Tech');
  assert.equal(res.sent, false);
  assert.equal(res.reason, 'smtp-not-configured');
});

// #66 — the message-type subject convention.
test('sendMail prefixes the subject with the category when one is present', async () => {
  const { sent, restore } = withStubbedTransport();
  try {
    const res = await sendMail({ to: 't@example.com', subject: 'Low on gloves', text: 'body', category: 'Stock' });
    assert.equal(res.sent, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, 'Stock: Low on gloves');
  } finally {
    restore();
  }
});

test('sendMail leaves the subject unchanged when no category is given (backward compatible)', async () => {
  const { sent, restore } = withStubbedTransport();
  try {
    const res = await sendMail({ to: 't@example.com', subject: 'Plain subject', text: 'body' });
    assert.equal(res.sent, true);
    assert.equal(sent[0].subject, 'Plain subject');
  } finally {
    restore();
  }
});

test('sendEnrollmentCodeEmail sends under the Account category', async () => {
  const { sent, restore } = withStubbedTransport();
  try {
    const res = await sendEnrollmentCodeEmail('jane@example.com', '123456', 'Jane Tech');
    assert.equal(res.sent, true);
    assert.equal(sent[0].subject, 'Account: Your InventoryPro access code');
  } finally {
    restore();
  }
});
