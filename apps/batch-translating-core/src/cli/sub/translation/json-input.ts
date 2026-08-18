import { readFile } from 'node:fs/promises';

export async function readJsonInput<T>(inputPath: string): Promise<T> {
  const source =
    inputPath === '-'
      ? await readStandardInput()
      : await readFile(inputPath, 'utf8');
  if (!source.trim()) throw new Error('JSON input is empty');
  try {
    return JSON.parse(source) as T;
  } catch (error) {
    throw new Error(
      `Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
