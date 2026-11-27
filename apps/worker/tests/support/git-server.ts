import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface GitServerRequest {
  method: string;
  url: string;
  authorized: boolean;
  headers: IncomingHttpHeaders;
}

export interface GitServer {
  /** Loopback HTTP base address, such as `http://127.0.0.1:4711`. */
  url: string;
  /** Creates a bare repository served at `/<owner>/<name>`, with one commit when files are given. */
  addRepository(fullName: string, files?: Record<string, string>): Promise<void>;
  /** Every request the server received, in order. */
  requests: GitServerRequest[];
  close(): Promise<void>;
}

// Git for the stand-in itself: no user or system configuration, a fixed identity.
const gitEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('GIT_') && !name.startsWith('ATLAS_')) env[name] = value;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Stand-in',
    GIT_AUTHOR_EMAIL: 'stand-in@example.com',
    GIT_COMMITTER_NAME: 'Stand-in',
    GIT_COMMITTER_EMAIL: 'stand-in@example.com',
  };
};

async function git(args: string[], cwd?: string): Promise<void> {
  await run('git', args, { cwd, env: gitEnvironment(), timeout: 10_000 });
}

function headerEnd(buffer: Buffer): { index: number; length: number } | null {
  const crlf = buffer.indexOf('\r\n\r\n');
  const lf = buffer.indexOf('\n\n');
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  if (lf !== -1) return { index: lf, length: 2 };
  return null;
}

/**
 * Serves bare repositories through `git http-backend` as CGI behind Basic authentication with the
 * user `x-access-token` and the given token, on loopback HTTP. Requests without the right
 * credentials get 401, which makes Git ask its credential helper.
 */
export async function startGitServer(options: { token: string }): Promise<GitServer> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'atlas-git-server-'));
  const expected = `Basic ${Buffer.from(`x-access-token:${options.token}`).toString('base64')}`;
  const requests: GitServerRequest[] = [];
  const sockets = new Set<Socket>();

  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const authorized = request.headers.authorization === expected;
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      authorized,
      headers: request.headers,
    });
    if (!authorized) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="atlas-test"' });
      response.end();
      return;
    }
    const address = new URL(request.url ?? '/', 'http://127.0.0.1');
    const env: NodeJS.ProcessEnv = {
      ...gitEnvironment(),
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: decodeURIComponent(address.pathname),
      QUERY_STRING: address.search.slice(1),
      REQUEST_METHOD: request.method ?? 'GET',
      REMOTE_USER: 'x-access-token',
      REMOTE_ADDR: '127.0.0.1',
      CONTENT_TYPE: request.headers['content-type'] ?? '',
    };
    if (request.headers['content-length'] !== undefined)
      env.CONTENT_LENGTH = request.headers['content-length'];
    if (typeof request.headers['content-encoding'] === 'string')
      env.HTTP_CONTENT_ENCODING = request.headers['content-encoding'];
    if (typeof request.headers['git-protocol'] === 'string')
      env.HTTP_GIT_PROTOCOL = request.headers['git-protocol'];
    const backend = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    request.pipe(backend.stdin);
    let head = Buffer.alloc(0);
    let headersSent = false;
    backend.stdout.on('data', (chunk: Buffer) => {
      if (headersSent) {
        response.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = headerEnd(head);
      if (!end) return;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end.index).toString('latin1').split(/\r?\n/)) {
        const separator = line.indexOf(':');
        if (separator === -1) continue;
        const name = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
        else headers[name] = value;
      }
      response.writeHead(status, headers);
      headersSent = true;
      response.write(head.subarray(end.index + end.length));
    });
    backend.on('close', () => {
      if (!headersSent) response.writeHead(500);
      response.end();
    });
    backend.on('error', () => {
      if (!headersSent) response.writeHead(500);
      response.end();
    });
  };

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
    async addRepository(fullName, files) {
      const bare = join(projectRoot, `${fullName}.git`);
      await mkdir(dirname(bare), { recursive: true });
      await git(['init', '--quiet', '--bare', '--initial-branch=main', bare]);
      if (!files || Object.keys(files).length === 0) return;
      const work = await mkdtemp(join(tmpdir(), 'atlas-git-source-'));
      try {
        await git(['init', '--quiet', '--initial-branch=main', work]);
        for (const [path, content] of Object.entries(files)) {
          await mkdir(dirname(join(work, path)), { recursive: true });
          await writeFile(join(work, path), content);
        }
        await git(['add', '--all'], work);
        await git(['commit', '--quiet', '--message', 'Initial commit'], work);
        await git(['tag', 'v1'], work);
        await git(['push', '--quiet', '--tags', bare, 'main'], work);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(projectRoot, { recursive: true, force: true });
    },
  };
}
