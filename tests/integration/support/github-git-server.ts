import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { GithubStandIn } from '../../../apps/api/tests/support/github-stand-in.js';
import { startGitServer } from '../../../apps/worker/tests/support/git-server.js';

// A Git host for end-to-end tests. It serves repositories like GitHub does: a request is
// answered only when it carries an installation token that the GitHub stand-in issued, has not
// revoked, and that is limited to this repository with at least the Contents read right. The
// repositories themselves come from the Worker tests' Git server, which sits behind this one with
// a secret of its own.

export interface GitHostRequest {
  method: string;
  repository: string;
  // `anonymous` carried no credentials, `refused` carried a token the stand-in does not accept for
  // this repository, `accepted` carried a valid one.
  credentials: 'anonymous' | 'refused' | 'accepted';
  // The request was held back and never answered.
  stalled: boolean;
}

export interface GitHost {
  /** Loopback HTTP base address that the Worker's `gitHostUrl` is set to. */
  url: string;
  /** Creates a repository `owner/name` with one commit holding these files. */
  addRepository(fullName: string, files: Record<string, string>): Promise<void>;
  /** Never answers the fetch of this repository, so a clone of it stays mid-flight. */
  stall(fullName: string): void;
  /** Every request, in order. Holds no token. */
  requests: GitHostRequest[];
  /** Whether any accepted request carried this token. */
  sawToken(token: string): boolean;
  /** The tokens that accepted requests carried, for checks against the stand-in's records. */
  acceptedTokens(): string[];
  close(): Promise<void>;
}

const REPOSITORY_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:info\/refs|git-upload-pack)(?:\?|$)/;

export async function startGitHost(github: GithubStandIn): Promise<GitHost> {
  const innerToken = randomBytes(16).toString('hex');
  const inner = await startGitServer({ token: innerToken });
  const innerAddress = new URL(inner.url);
  const innerAuthorization = `Basic ${Buffer.from(`x-access-token:${innerToken}`).toString('base64')}`;
  const requests: GitHostRequest[] = [];
  const accepted = new Set<string>();
  const stalled = new Set<string>();
  const sockets = new Set<Socket>();

  function credentialsFor(
    request: IncomingMessage,
    fullName: string,
  ): { kind: 'anonymous' | 'refused' | 'accepted'; token?: string } {
    const header = request.headers.authorization;
    if (!header) return { kind: 'anonymous' };
    const [scheme, encoded] = header.split(' ');
    if (scheme !== 'Basic' || !encoded) return { kind: 'refused' };
    const separator = Buffer.from(encoded, 'base64').toString('utf8').indexOf(':');
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const user = decoded.slice(0, separator);
    const token = decoded.slice(separator + 1);
    const record = github.state.installationTokens.get(token);
    const repository = github.state.repositories.find(
      (candidate) => candidate.fullName.toLowerCase() === fullName.toLowerCase(),
    );
    const valid =
      user === 'x-access-token' &&
      record !== undefined &&
      repository !== undefined &&
      Date.parse(record.expiresAt) > Date.now() &&
      record.installationId === repository.installationId &&
      record.repositoryIds?.includes(repository.id) === true &&
      ['read', 'write'].includes(record.permissions.contents ?? '');
    return valid ? { kind: 'accepted', token } : { kind: 'refused' };
  }

  function handle(request: IncomingMessage, response: ServerResponse) {
    const match = REPOSITORY_PATH.exec(request.url ?? '');
    const fullName = match ? `${match[1]}/${match[2]}` : '';
    const method = request.method ?? '';
    if (!match) {
      response.writeHead(404).end();
      return;
    }
    const credentials = credentialsFor(request, fullName);
    const holdBack =
      credentials.kind === 'accepted' &&
      method === 'POST' &&
      stalled.has(fullName.toLowerCase()) &&
      (request.url ?? '').includes('/git-upload-pack');
    requests.push({
      method,
      repository: fullName,
      credentials: credentials.kind,
      stalled: holdBack,
    });
    if (credentials.kind !== 'accepted') {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="atlas-test"' }).end();
      return;
    }
    if (credentials.token) accepted.add(credentials.token);
    // The client waits for an answer that never comes, until its process is ended.
    if (holdBack) return;
    const upstream = httpRequest(
      {
        host: innerAddress.hostname,
        port: Number(innerAddress.port),
        method,
        path: request.url,
        headers: { ...request.headers, authorization: innerAuthorization, host: innerAddress.host },
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  }

  const server = createServer(handle);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    addRepository: (fullName, files) => inner.addRepository(fullName, files),
    stall(fullName) {
      stalled.add(fullName.toLowerCase());
    },
    sawToken: (token) => accepted.has(token),
    acceptedTokens: () => [...accepted],
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await inner.close();
    },
  };
}
