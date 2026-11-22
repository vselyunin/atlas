import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// How the fake `srt` behaves:
// - exec: the readiness check passes and the agent command is run in place of srt;
// - fail: every call fails with `bwrap: nope`, as when bubblewrap cannot start;
// - slow: like exec, but the readiness check takes a second and marks when it began.
export type FakeSrtMode = 'exec' | 'fail' | 'slow';

export interface FakeSrt {
  directory: string;
  // One entry per call, holding the arguments srt was given.
  calls(): Promise<string[][]>;
  checkStarted(): Promise<boolean>;
}

const readOrEmpty = (path: string) => readFile(path, 'utf8').catch(() => '');

export async function writeFakeSrt(directory: string, mode: FakeSrtMode): Promise<FakeSrt> {
  const log = join(directory, 'srt-calls.log');
  const marker = join(directory, 'srt-check-started');
  const check = {
    exec: 'exit 0',
    fail: 'exit 1',
    slow: `: > '${marker}'\n  sleep 1\n  exit 0`,
  }[mode];
  const script = `#!/bin/sh
(IFS="$(printf '\\t')"; printf '%s\\n' "$*") >> '${log}'
${mode === 'fail' ? "echo 'bwrap: nope' >&2\nexit 1\n" : ''}if [ "$1" != --settings ] || [ ! -f "$2" ]; then
  echo 'fake srt: expected --settings <file>' >&2
  exit 64
fi
shift 2
if [ "$1" = sh ] && [ "$2" = -c ]; then
  ${check}
fi
exec "$@"
`;
  const path = join(directory, 'srt');
  await writeFile(path, script);
  await chmod(path, 0o755);
  return {
    directory,
    calls: async () =>
      (await readOrEmpty(log))
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t')),
    checkStarted: async () =>
      readFile(marker).then(
        () => true,
        () => false,
      ),
  };
}
