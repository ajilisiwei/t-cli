import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_MAIL_INTERVAL_MS, createAlerter, smtpMailer, type AlertMail } from '../src/modules/pipeline/alerts.ts';

function recordingLog() {
  const lines: { obj: Record<string, unknown>; msg: string }[] = [];
  return { lines, warn: (obj: object, msg: string) => void lines.push({ obj: obj as Record<string, unknown>, msg }) };
}

const NO_MAIL = { ALERT_SMTP_URL: undefined, ALERT_EMAIL_FROM: undefined, ALERT_EMAIL_TO: undefined };

describe('alerter', () => {
  test('without complete ALERT_* settings it only logs', async () => {
    assert.equal(smtpMailer(NO_MAIL), null);
    assert.equal(smtpMailer({ ...NO_MAIL, ALERT_SMTP_URL: 'smtps://u:p@smtp.example.com:465', ALERT_EMAIL_FROM: 'a@example.com' }), null);
    assert.notEqual(
      smtpMailer({ ALERT_SMTP_URL: 'smtps://u:p@smtp.example.com:465', ALERT_EMAIL_FROM: 'a@example.com', ALERT_EMAIL_TO: 'b@example.com' }),
      null,
    );
    const log = recordingLog();
    await createAlerter(NO_MAIL, log).alert('job_failed', 'job pipeline-nightly failed: TypeError');
    assert.deepEqual(log.lines, [{ obj: { alertKind: 'job_failed', alertMessage: 'job pipeline-nightly failed: TypeError' }, msg: 'alert' }]);
  });

  test('mails at most once per kind per hour and mentions what it held back', async () => {
    const sent: AlertMail[] = [];
    let now = 1_000_000;
    const log = recordingLog();
    const alerter = createAlerter(NO_MAIL, log, { now: () => now, mailer: { send: async (mail) => void sent.push(mail) } });

    await alerter.alert('pipeline_user_failed', 'account A failed');
    await alerter.alert('pipeline_user_failed', 'account B failed');
    await alerter.alert('item_needs_regen', '2 items need regeneration');
    now += ALERT_MAIL_INTERVAL_MS - 1;
    await alerter.alert('pipeline_user_failed', 'account C failed');
    assert.deepEqual(sent.map((mail) => mail.subject), ['[t-cli] pipeline_user_failed', '[t-cli] item_needs_regen']);

    now += 1;
    await alerter.alert('pipeline_user_failed', 'account D failed');
    assert.equal(sent.length, 3);
    assert.equal(sent[2]?.text, 'account D failed\n\n2 more "pipeline_user_failed" alert(s) since the last mail were only logged.');
    assert.equal(log.lines.filter((line) => line.msg === 'alert').length, 5, 'every alert is logged');
  });

  test('a failing mail server never throws and logs only the error class', async () => {
    const log = recordingLog();
    const alerter = createAlerter(NO_MAIL, log, {
      mailer: {
        send: async () => {
          throw new Error('535 Authentication failed for user secret-password');
        },
      },
    });
    await alerter.alert('token_budget_exceeded', 'stopped early');
    const failure = log.lines.find((line) => line.msg === 'alert mail failed');
    assert.equal(failure?.obj.errName, 'Error');
    assert.ok(!JSON.stringify(log.lines).includes('secret-password'));
  });

  test('the real SMTP mailer: an unreachable server is a logged failure, and the URL never reaches the log', async () => {
    const log = recordingLog();
    const config = { ALERT_SMTP_URL: 'smtp://alerts:hunter2-password@127.0.0.1:1', ALERT_EMAIL_FROM: 'a@example.com', ALERT_EMAIL_TO: 'b@example.com' };
    await createAlerter(config, log).alert('job_failed', 'job x failed');
    assert.ok(log.lines.some((line) => line.msg === 'alert mail failed'));
    assert.ok(!JSON.stringify(log.lines).includes('hunter2'));
  });

  test('long messages are cut', async () => {
    const log = recordingLog();
    await createAlerter(NO_MAIL, log).alert('job_failed', 'x'.repeat(5000));
    assert.equal(String(log.lines[0]?.obj.alertMessage).length, 1001);
  });
});
