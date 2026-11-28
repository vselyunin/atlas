import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionActivityDetailSchema, SessionActivitySchema } from '@atlas/contracts';
import type { SessionActivity, SessionActivityDetail } from '@atlas/contracts';

export interface AgentActivity {
  activity: SessionActivity;
  detail: SessionActivityDetail | null;
}

export const MAX_STATUS_FILE_BYTES = 65_536;
const MAX_LINE_LENGTH = 64;
const DEFAULT_INTERVAL_MS = 500;
const NO_DETAIL = '-';
const NEWLINE = 0x0a;

// The hook script runs by plain `node` in the agent's sandbox, so it is standalone CommonJS with
// no imports beyond `node:fs`. It carries its own copy of the failure kinds, generated from the
// contract so the copy cannot drift. It writes one `<activity> <detail or ->` line and never the
// message text, never prints and always exits 0.
function hookScriptText(): string {
  const kinds = JSON.stringify(SessionActivityDetailSchema.options);
  return `'use strict';
const fs = require('node:fs');
const KINDS = ${kinds};
function main() {
  const event = process.argv[2];
  const file = process.argv[3];
  let input = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (parsed !== null && typeof parsed === 'object') input = parsed;
  } catch {
    // Unreadable input still gives a line for the events that do not need it.
  }
  let line;
  if (event === 'UserPromptSubmit' || event === 'PostToolUse') {
    line = 'working -';
  } else if (event === 'PreToolUse' || event === 'PermissionRequest') {
    line = 'needs_input -';
  } else if (event === 'Stop') {
    const message = input.last_assistant_message;
    line = typeof message === 'string' && /\\?\\s*$/.test(message) ? 'needs_input asked_in_text' : 'idle -';
  } else if (event === 'StopFailure') {
    const raw = typeof input.error === 'string' ? input.error : input.error_type;
    line = 'error ' + (typeof raw === 'string' && KINDS.includes(raw) ? raw : 'unknown');
  }
  if (line === undefined || typeof file !== 'string') return;
  fs.appendFileSync(file, line + '\\n');
}
try {
  main();
} catch {
  // A status line is best effort; the agent must never be blocked by it.
}
process.exit(0);
`;
}

// Creates `<base>/hook.cjs` (mode 0444) once. `base` is a private folder made with mkdtemp.
export async function writeHookScript(base: string): Promise<string> {
  const path = join(base, 'hook.cjs');
  try {
    await writeFile(path, hookScriptText(), { mode: 0o444, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await chmod(path, 0o444);
  return path;
}

function shellQuote(path: string): string {
  const hasControl = [...path].some((char) => char.charCodeAt(0) < 0x20 || char === '\x7f');
  if (!path.startsWith('/') || hasControl) {
    throw new Error('A hook path must be absolute and free of control characters.');
  }
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

// The JSON for `claude --settings`: hooks that run `node <script> <event> <statusFile>`.
export function hookSettings(scriptPath: string, statusFile: string): string {
  const script = shellQuote(scriptPath);
  const status = shellQuote(statusFile);
  const entry = (event: string, matcher?: string) => ({
    ...(matcher === undefined ? {} : { matcher }),
    hooks: [{ type: 'command', command: `node ${script} ${event} ${status}` }],
  });
  return JSON.stringify({
    hooks: {
      UserPromptSubmit: [entry('UserPromptSubmit')],
      PreToolUse: [entry('PreToolUse', 'AskUserQuestion')],
      PermissionRequest: [entry('PermissionRequest')],
      // Every tool, so that a granted permission clears `needs_input`.
      PostToolUse: [entry('PostToolUse')],
      Stop: [entry('Stop')],
      StopFailure: [entry('StopFailure')],
    },
  });
}

function parseLine(line: string): AgentActivity | null {
  if (line.length > MAX_LINE_LENGTH) return null;
  const parts = line.split(' ');
  if (parts.length !== 2) return null;
  const activity = SessionActivitySchema.safeParse(parts[0]);
  if (!activity.success) return null;
  if (parts[1] === NO_DETAIL) return { activity: activity.data, detail: null };
  const detail = SessionActivityDetailSchema.safeParse(parts[1]);
  return detail.success ? { activity: activity.data, detail: detail.data } : null;
}

// Lines the hook script wrote, in order; anything else is dropped.
export function parseStatus(text: string): AgentActivity[] {
  return text
    .split('\n')
    .map(parseLine)
    .filter((entry): entry is AgentActivity => entry !== null);
}

// Polls the status file and reports the last valid line of each read. A missing file is waited
// for; a file that is not a regular file is never read again. At most MAX_STATUS_FILE_BYTES of
// unread lines are read per tick, so a long session keeps reporting while an oversized burst is
// skipped unread and the lines after it still count.
export function watchStatus(
  file: string,
  onActivity: (activity: AgentActivity) => void,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): { stop(): void } {
  let offset = 0;
  // After a skip, the bytes up to the next newline may be the tail of a skipped line.
  let midLine = false;
  let finished = false;
  const timer = setInterval(() => {
    if (finished) return;
    try {
      // Never follow a link or wait on a pipe: the agent can swap the file at any moment.
      let fd: number;
      try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || code === 'EISDIR') finish();
        return;
      }
      let chunk: Buffer;
      try {
        const entry = fstatSync(fd);
        if (!entry.isFile()) {
          finish();
          return;
        }
        const size = entry.size;
        if (size <= offset) return;
        if (size - offset > MAX_STATUS_FILE_BYTES) {
          // Too much at once for the hook's short lines: skip it without reading it.
          const last = Buffer.alloc(1);
          midLine = readSync(fd, last, 0, 1, size - 1) !== 1 || last[0] !== NEWLINE;
          offset = size;
          return;
        }
        const buffer = Buffer.alloc(size - offset);
        chunk = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, offset));
      } finally {
        closeSync(fd);
      }
      // Only whole lines count; the rest is read again once the hook has finished it.
      const end = chunk.lastIndexOf(NEWLINE) + 1;
      if (end === 0) return;
      offset += end;
      let start = 0;
      if (midLine) {
        start = chunk.indexOf(NEWLINE) + 1;
        midLine = false;
      }
      const last = parseStatus(chunk.subarray(start, end).toString('utf8')).at(-1);
      if (last !== undefined) onActivity(last);
    } catch {
      // The next tick tries again; a timer must never throw.
    }
  }, intervalMs);
  timer.unref();

  function finish(): void {
    finished = true;
    clearInterval(timer);
  }

  return { stop: finish };
}
