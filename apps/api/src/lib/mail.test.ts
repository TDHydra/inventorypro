import { test } from 'node:test';
import assert from 'node:assert/strict';
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
