// A small SMTP client (RFC 5321) and MIME builder for client emails, with no dependencies so it runs
// in the notifier Edge Function (Deno) and in unit tests (Node). The socket is injected: the Edge
// Function passes Deno.connect / Deno.connectTls / Deno.startTls.

export interface EmailAttachment {
  filename: string;
  /** e.g. 'text/calendar; method=REQUEST' */
  contentType: string;
  content: string;
}

export interface EmailMessage {
  /** "Name <address>" or a bare address. */
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
  /** Extra headers, e.g. List-Unsubscribe on marketing email. Names must be plain tokens. */
  headers?: Record<string, string>;
}

/** A send failure. `permanent` (e.g. 5xx, bad address) won't be retried. */
export class EmailSendError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent = false) {
    super(message);
    this.name = 'EmailSendError';
    this.permanent = permanent;
  }
}

/** The subset of Deno.Conn the client needs. */
export interface SmtpConn {
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
}

export interface SmtpConnector {
  connect(options: { hostname: string; port: number; tls: boolean }): Promise<SmtpConn>;
  /** Upgrades a plain connection after STARTTLS. */
  startTls?(conn: SmtpConn, hostname: string): Promise<SmtpConn>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  /** 'tls' = implicit TLS (465), 'starttls' = upgrade (587), 'none' = plain (local Mailpit). */
  security: 'tls' | 'starttls' | 'none';
  user?: string;
  pass?: string;
  /** Name sent with EHLO. */
  clientName?: string;
  timeoutMs?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function base64(text: string | Uint8Array): string {
  const bytes = typeof text === 'string' ? enc.encode(text) : text;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, (line) => `${line}\r\n`);
}

/** RFC 2047 encoded-word for non-ASCII header text. */
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${base64(clean)}?=`;
}

/** The bare address from "Name <address>" or "address". */
export function addressOf(mailbox: string): string {
  const m = /<([^<>\s]+)>\s*$/.exec(mailbox);
  return (m?.[1] ?? mailbox).trim();
}

/** "Name <address>" with the name encoded when needed. */
function formatMailbox(mailbox: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<([^<>\s]+)>\s*$/.exec(mailbox);
  if (!m) return mailbox.trim();
  const name = m[1]?.trim();
  return name ? `${encodeHeader(name.replace(/"/g, ''))} <${m[2]}>` : `<${m[2]}>`;
}

function randomBoundary(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** A multipart/mixed message: text + HTML alternatives, then attachments (base64). */
export function buildMime(
  message: EmailMessage,
  options: { date?: Date; messageId?: string } = {},
): string {
  const domain = addressOf(message.from).split('@')[1] ?? 'chairside.local';
  const messageId = options.messageId ?? `<${randomBoundary('m')}@${domain}>`;
  const alt = randomBoundary('alt');
  const mixed = randomBoundary('mix');
  const headers = [
    `From: ${formatMailbox(message.from)}`,
    `To: ${formatMailbox(message.to)}`,
    ...(message.replyTo ? [`Reply-To: ${formatMailbox(message.replyTo)}`] : []),
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${(options.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${messageId}`,
    ...Object.entries(message.headers ?? {})
      .filter(([name]) => /^[A-Za-z][A-Za-z0-9-]*$/.test(name))
      .map(([name, value]) => `${name}: ${value.replace(/[\r\n]+/g, ' ')}`),
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ];
  const part = (contentType: string, body: string, extra: string[] = []) =>
    [
      `Content-Type: ${contentType}`,
      'Content-Transfer-Encoding: base64',
      ...extra,
      '',
      wrap76(base64(body)),
    ].join('\r\n');

  const body = [
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    part('text/plain; charset=utf-8', message.text),
    `--${alt}`,
    part('text/html; charset=utf-8', message.html),
    `--${alt}--`,
    '',
    ...(message.attachments ?? []).flatMap((a) => [
      `--${mixed}`,
      part(`${a.contentType}; charset=utf-8; name="${a.filename}"`, a.content, [
        `Content-Disposition: attachment; filename="${a.filename}"`,
      ]),
    ]),
    `--${mixed}--`,
    '',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${body.join('\r\n')}`;
}

/** Reads SMTP replies (possibly multi-line: "250-..." then "250 ...") from a connection. */
class ReplyReader {
  private buffer = '';
  constructor(
    private conn: SmtpConn,
    private timeoutMs: number,
  ) {}

  setConn(conn: SmtpConn) {
    this.conn = conn;
    this.buffer = '';
  }

  private async fill(): Promise<void> {
    const chunk = new Uint8Array(4096);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new EmailSendError('SMTP server timed out')), this.timeoutMs);
    });
    try {
      const n = await Promise.race([this.conn.read(chunk), timeout]);
      if (n === null) throw new EmailSendError('SMTP connection closed');
      this.buffer += dec.decode(chunk.subarray(0, n));
    } finally {
      clearTimeout(timer);
    }
  }

  async reply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      let idx = this.buffer.indexOf('\r\n');
      while (idx === -1) {
        await this.fill();
        idx = this.buffer.indexOf('\r\n');
      }
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      lines.push(line.slice(4));
      if (line[3] !== '-') {
        return { code: Number.parseInt(line.slice(0, 3), 10), text: lines.join('\n') };
      }
    }
  }
}

async function writeAll(conn: SmtpConn, data: string): Promise<void> {
  let bytes = enc.encode(data);
  while (bytes.length > 0) {
    const n = await conn.write(bytes);
    bytes = bytes.subarray(n);
  }
}

/** Sends one message. Resolves with the server's queue id (from the final 250) if it gave one. */
export async function sendSmtp(
  config: SmtpConfig,
  connector: SmtpConnector,
  message: EmailMessage,
): Promise<{ id?: string }> {
  const timeoutMs = config.timeoutMs ?? 20_000;
  let conn = await connector.connect({
    hostname: config.host,
    port: config.port,
    tls: config.security === 'tls',
  });
  const reader = new ReplyReader(conn, timeoutMs);

  const expect = async (command: string | null, ok: number[], what: string) => {
    if (command !== null) await writeAll(conn, `${command}\r\n`);
    const reply = await reader.reply();
    if (!ok.includes(reply.code)) {
      throw new EmailSendError(
        `SMTP ${what} failed: ${reply.code} ${reply.text}`.slice(0, 500),
        reply.code >= 500,
      );
    }
    return reply;
  };

  try {
    await expect(null, [220], 'greeting');
    const ehlo = `EHLO ${config.clientName ?? 'chairside'}`;
    await expect(ehlo, [250], 'EHLO');
    if (config.security === 'starttls') {
      if (!connector.startTls) throw new EmailSendError('STARTTLS is not supported here', true);
      await expect('STARTTLS', [220], 'STARTTLS');
      conn = await connector.startTls(conn, config.host);
      reader.setConn(conn);
      await expect(ehlo, [250], 'EHLO');
    }
    if (config.user) {
      const token = base64(`\u0000${config.user}\u0000${config.pass ?? ''}`);
      await expect(`AUTH PLAIN ${token}`, [235], 'AUTH');
    }
    await expect(`MAIL FROM:<${addressOf(message.from)}>`, [250], 'MAIL FROM');
    await expect(`RCPT TO:<${addressOf(message.to)}>`, [250, 251], 'RCPT TO');
    await expect('DATA', [354], 'DATA');
    // Dot-stuffing (RFC 5321 §4.5.2), then the terminating "."
    const data = buildMime(message).replace(/\r\n\./g, '\r\n..');
    const done = await expect(`${data}\r\n.`, [250], 'DATA');
    try {
      await writeAll(conn, 'QUIT\r\n');
    } catch {
      // The message is accepted; a failed QUIT doesn't matter.
    }
    const id = /(?:queued as|id=)\s*([^\s]+)/i.exec(done.text)?.[1] ?? done.text.trim();
    return { id: id ? id.slice(0, 200) : undefined };
  } finally {
    try {
      conn.close();
    } catch {
      // already closed
    }
  }
}
