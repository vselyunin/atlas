import { CREDENTIAL_REPLY_TIMEOUT_MS } from '@atlas/contracts';
import type { CredentialGrant, ErrorInfo } from '@atlas/contracts';

export type GrantedCredential = CredentialGrant['payload'];

/** Asks the API for a credential for one command. The token is held in memory only. */
export type CredentialRequester = (
  commandId: string,
  signal: AbortSignal,
) => Promise<GrantedCredential>;

/** The API answered with a refusal; the command fails with its message. */
export class CredentialRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CredentialRefused';
    this.code = code;
  }
}

/** No answer arrived: timeout, dropped connection or shutdown. The outcome is uncertain. */
export class CredentialUnavailable extends Error {
  constructor(message = 'No credential reply arrived') {
    super(message);
    this.name = 'CredentialUnavailable';
  }
}

interface Pending {
  resolve(value: GrantedCredential): void;
  reject(error: Error): void;
}

/**
 * Pending credential requests on one Worker connection, keyed by command ID. A request is
 * rejected with CredentialUnavailable when no reply arrives within the reply timeout, when the
 * connection drops, or when its signal aborts. Replies for unknown command IDs are dropped.
 */
export class CredentialExchange {
  private readonly pending = new Map<string, Pending>();

  /**
   * @param send sends the request for a command ID and returns false when there is no registered
   * connection to send it on.
   */
  constructor(
    private readonly send: (commandId: string) => boolean,
    private readonly timeoutMs = CREDENTIAL_REPLY_TIMEOUT_MS,
  ) {}

  readonly request: CredentialRequester = (commandId, signal) =>
    new Promise<GrantedCredential>((resolve, reject) => {
      if (signal.aborted) {
        reject(new CredentialUnavailable('The command was stopped'));
        return;
      }
      this.pending.get(commandId)?.reject(new CredentialUnavailable('Superseded by a new request'));
      // Both handlers run only after the timer and listener below exist.
      const settle = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (this.pending.get(commandId) === entry) this.pending.delete(commandId);
      };
      const entry: Pending = {
        resolve: (value) => {
          settle();
          resolve(value);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      };
      const onAbort = () => entry.reject(new CredentialUnavailable('The command was stopped'));
      const timer = setTimeout(
        () => entry.reject(new CredentialUnavailable('No credential reply arrived in time')),
        this.timeoutMs,
      );
      this.pending.set(commandId, entry);
      signal.addEventListener('abort', onAbort, { once: true });
      if (!this.send(commandId))
        entry.reject(new CredentialUnavailable('The Worker is not connected to the API'));
    });

  /** Resolves the request for this command ID. Returns false when none is pending. */
  grant(commandId: string, credential: GrantedCredential): boolean {
    const entry = this.pending.get(commandId);
    entry?.resolve(credential);
    return entry !== undefined;
  }

  /** Rejects the request for this command ID with the refusal. */
  refuse(commandId: string, error: ErrorInfo): boolean {
    const entry = this.pending.get(commandId);
    entry?.reject(new CredentialRefused(error.code, error.message));
    return entry !== undefined;
  }

  /** Rejects every pending request, for a dropped connection. */
  dropAll(): void {
    for (const entry of [...this.pending.values()])
      entry.reject(new CredentialUnavailable('The connection to the API dropped'));
  }
}
