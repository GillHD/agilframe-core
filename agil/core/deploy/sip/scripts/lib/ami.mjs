/**
 * Local SIP lab — minimal Asterisk Manager Interface (AMI) client.
 *
 * Used only to originate the inbound-test leg ("the phone dials the app") and
 * to read the resulting channel events. No third-party dependency: AMI is a
 * line protocol over TCP (messages are separated by a blank line).
 *
 * AMI is bound to 127.0.0.1 by asterisk/manager.conf and uses the committed
 * LAB credential; never expose this port on a real PBX.
 */
import net from 'node:net';

const LOGIN_TIMEOUT_MS = 5000;
const ACTION_TIMEOUT_MS = 15000;

/** Splits a raw AMI buffer into complete `\r\n`-separated messages. */
export function splitMessages(buffer) {
  const messages = [];
  let rest = buffer;
  let index = rest.indexOf('\r\n\r\n');
  while (index !== -1) {
    messages.push(rest.slice(0, index));
    rest = rest.slice(index + 4);
    index = rest.indexOf('\r\n\r\n');
  }
  return { messages, rest };
}

/** Parses one AMI message into a `{ key: value }` object (keys are case-sensitive). */
export function parseMessage(text) {
  const fields = {};
  for (const line of text.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fields;
}

export class AmiClient {
  constructor({ host = '127.0.0.1', port = 5038, username = 'agil', secret = 'agil-lab-ami' } = {}) {
    this.options = { host, port, username, secret };
    this.socket = null;
    this.buffer = '';
    this.pending = new Map();
    this.events = [];
    this.eventWaiters = [];
    this.actionSeq = 0;
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.options.host, port: this.options.port });
      this.socket = socket;
      socket.setEncoding('utf8');
      socket.setNoDelay(true);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`AMI connect timeout to ${this.options.host}:${this.options.port}`));
      }, LOGIN_TIMEOUT_MS);
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on('data', (chunk) => this.#onData(chunk));
      socket.on('close', () => {
        this.closed = true;
        for (const waiter of this.pending.values()) waiter.reject(new Error('AMI connection closed'));
        this.pending.clear();
      });
      socket.once('connect', async () => {
        try {
          await this.#login();
          clearTimeout(timer);
          resolve(this);
        } catch (error) {
          clearTimeout(timer);
          socket.destroy();
          reject(error);
        }
      });
    });
  }

  async #login() {
    // The banner arrives before we can send Login; wait for the response event.
    const login = await this.#action('Login', { Username: this.options.username, Secret: this.options.secret });
    if (login.Response !== 'Success') {
      throw new Error(`AMI login failed: ${login.Message ?? login.Response ?? 'unknown'}`);
    }
  }

  #onData(chunk) {
    this.buffer += chunk;
    const { messages, rest } = splitMessages(this.buffer);
    this.buffer = rest;
    for (const text of messages) {
      const message = parseMessage(text);
      if (message.Response || message.Privilege) {
        const waiter = this.pending.get(message.ActionID);
        if (waiter) {
          this.pending.delete(message.ActionID);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
          continue;
        }
        if (!message.Event) continue;
      }
      if (message.Event) {
        this.events.push(message);
        for (const waiter of [...this.eventWaiters]) {
          if (waiter.predicate(message)) {
            this.eventWaiters.splice(this.eventWaiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(message);
          }
        }
      }
    }
  }

  #action(name, fields = {}) {
    if (!this.socket || this.closed) return Promise.reject(new Error('AMI is not connected'));
    this.actionSeq += 1;
    const actionId = `agil-${this.actionSeq}`;
    const lines = [`Action: ${name}`, `ActionID: ${actionId}`];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      lines.push(`${key}: ${value}`);
    }
    const payload = `${lines.join('\r\n')}\r\n\r\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(actionId);
        reject(new Error(`AMI ${name} timed out`));
      }, ACTION_TIMEOUT_MS);
      this.pending.set(actionId, { resolve, reject, timer });
      this.socket.write(payload);
    });
  }

  /** Waits for the next event matching `predicate` (already-received events included). */
  waitForEvent(predicate, timeoutMs = ACTION_TIMEOUT_MS) {
    const existing = this.events.find((event) => predicate(event));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.eventWaiters.splice(
          this.eventWaiters.findIndex((waiter) => waiter.timer === timer),
          1,
        );
        reject(new Error('AMI event timeout'));
      }, timeoutMs);
      this.eventWaiters.push({ predicate, resolve, reject, timer });
    });
  }

  /**
   * Originates a call and waits for Asterisk's answer.
   * Returns `{ uniqueid, channel }` when the leg is answered.
   */
  async originate({ channel, application, data, context, extension, priority, timeout = 20000, callerId = 'AGIL SIP Lab <600>' }) {
    const response = await this.#action('Originate', {
      Channel: channel,
      Application: application,
      Data: data,
      Context: context,
      Exten: extension,
      Priority: priority,
      Timeout: timeout,
      Async: 'true',
      CallerID: callerId,
    });
    if (response.Response !== 'Success') {
      throw new Error(`AMI Originate rejected: ${response.Message ?? response.Response}`);
    }
    const actionId = response.ActionID;
    // OriginateResponse is emitted for the same ActionID when the leg answers
    // (Response: Success, Reason: 4) or fails.
    const outcome = await this.waitForEvent(
      (event) => event.Event === 'OriginateResponse' && event.ActionID === actionId,
      timeout + 5000,
    );
    if (outcome.Response !== 'Success') {
      throw new Error(`AMI Originate failed: reason=${outcome.Reason ?? 'unknown'} response=${outcome.Response}`);
    }
    return { uniqueid: outcome.Uniqueid, channel: outcome.Channel };
  }

  /** Runs a CLI command through AMI (needs `command` write); returns its output. */
  async command(command) {
    const response = await this.#action('Command', { Command: command });
    return String(response.Output ?? response.Message ?? '');
  }

  /** Lists channels currently up (used to prove the inbound leg is answered). */
  async channels() {
    const response = await this.#action('CoreShowChannels');
    const events = this.events.filter((event) => event.Event === 'CoreShowChannel');
    return events;
  }

  close() {
    if (!this.socket) return;
    try {
      this.socket.write('Action: Logoff\r\n\r\n');
    } catch {
      /* already gone */
    }
    this.socket.destroy();
    this.socket = null;
  }
}

/** Connects, logs in and returns a ready AMI client. */
export async function connectAmi(options) {
  return new AmiClient(options).connect();
}
