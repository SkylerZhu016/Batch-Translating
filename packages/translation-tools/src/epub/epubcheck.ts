import { spawn } from 'node:child_process';

import type { EpubcheckResult } from '../types.js';

export async function runEpubcheck(
  epubPath: string,
  executable = 'epubcheck',
  timeoutMs = 120_000,
): Promise<EpubcheckResult> {
  const isJar = executable.toLowerCase().endsWith('.jar');
  const command = isJar ? 'java' : executable;
  const args = isJar ? ['-jar', executable, epubPath] : [epubPath];
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let totalLength = 0;
    let timedOut = false;
    const collect = (chunk: Buffer): void => {
      if (totalLength >= 1_000_000) return;
      const remaining = 1_000_000 - totalLength;
      const selected = chunk.subarray(0, remaining);
      chunks.push(selected);
      totalLength += selected.byteLength;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (error.code === 'ENOENT') {
        resolve({ status: 'unavailable', command: executable, output: error.message });
        return;
      }
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      const output = Buffer.concat(chunks).toString('utf8');
      if (timedOut) {
        resolve({ status: 'timed_out', command: executable, output });
      } else if (code === 0) {
        resolve({ status: 'passed', command: executable, exit_code: 0, output });
      } else {
        resolve({ status: 'failed', command: executable, ...(code === null ? {} : { exit_code: code }), output });
      }
    });
  });
}
