import nodemailer from 'nodemailer';
import type { Config } from '../../config.ts';
import { loggableError } from '../../http/errors.ts';
import type { Alerter } from '../../ports.ts';

/**
 * Operator alerts (docs/api-v1.md, "Alerts"): always a log line; also an
 * e-mail when ALERT_SMTP_URL, ALERT_EMAIL_FROM and ALERT_EMAIL_TO are all
 * set, at most one per kind per hour (later ones are counted and mentioned in
 * the next mail). Callers build messages from ids, counts and error classes
 * only — never user text. Sending never throws.
 */

export interface AlertLogger {
  warn(obj: object, msg: string): void;
}

export type AlertConfig = Pick<Config, 'ALERT_SMTP_URL' | 'ALERT_EMAIL_FROM' | 'ALERT_EMAIL_TO'>;

export interface AlertMail {
  subject: string;
  text: string;
}

export interface AlertMailer {
  send(mail: AlertMail): Promise<void>;
}

export interface AlerterOptions {
  /** Milliseconds clock for the per-kind throttle (tests). */
  now?: () => number;
  /** Replaces the SMTP mailer (tests); null → log only. */
  mailer?: AlertMailer | null;
}

export const ALERT_MAIL_INTERVAL_MS = 60 * 60_000;
const MESSAGE_MAX_CHARS = 1000;
const SMTP_TIMEOUT_MS = 15_000;

/** SMTP via nodemailer, or null when alert mail is not fully configured. */
export function smtpMailer(config: AlertConfig): AlertMailer | null {
  const { ALERT_SMTP_URL: url, ALERT_EMAIL_FROM: from, ALERT_EMAIL_TO: to } = config;
  if (!url || !from || !to) return null;
  const transport = nodemailer.createTransport({
    url,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  return {
    async send({ subject, text }) {
      await transport.sendMail({ from, to, subject, text });
    },
  };
}

export function createAlerter(config: AlertConfig, log: AlertLogger, options: AlerterOptions = {}): Alerter {
  const mailer = options.mailer === undefined ? smtpMailer(config) : options.mailer;
  const now = options.now ?? Date.now;
  const lastMailAt = new Map<string, number>();
  const suppressed = new Map<string, number>();

  return {
    async alert(kind, message) {
      const text = message.length > MESSAGE_MAX_CHARS ? `${message.slice(0, MESSAGE_MAX_CHARS)}…` : message;
      log.warn({ alertKind: kind, alertMessage: text }, 'alert');
      if (!mailer) return;

      const at = now();
      const last = lastMailAt.get(kind);
      if (last !== undefined && at - last < ALERT_MAIL_INTERVAL_MS) {
        suppressed.set(kind, (suppressed.get(kind) ?? 0) + 1);
        return;
      }
      lastMailAt.set(kind, at);
      const skipped = suppressed.get(kind) ?? 0;
      suppressed.delete(kind);
      const footer = skipped > 0 ? `\n\n${skipped} more "${kind}" alert(s) since the last mail were only logged.` : '';
      try {
        await mailer.send({ subject: `[t-cli] ${kind}`, text: `${text}${footer}` });
      } catch (error) {
        // Only the error class: SMTP errors can echo the server's reply, and the URL holds a password.
        log.warn({ alertKind: kind, ...loggableError(error) }, 'alert mail failed');
      }
    },
  };
}
