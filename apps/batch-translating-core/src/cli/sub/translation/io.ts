interface WritableLike {
  write(chunk: string): boolean;
}

export interface TranslationJsonCommandIo {
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly setExitCode: (code: number) => void;
}

export function resolveTranslationIo(
  overrides?: Partial<TranslationJsonCommandIo>,
): TranslationJsonCommandIo {
  return {
    stdout: overrides?.stdout ?? process.stdout,
    stderr: overrides?.stderr ?? process.stderr,
    setExitCode:
      overrides?.setExitCode ??
      ((code) => {
        process.exitCode = code;
      }),
  };
}

export async function runTranslationJsonCommand(
  io: TranslationJsonCommandIo,
  operation: () => unknown | Promise<unknown>,
  options: {
    readonly errorCode: string;
    readonly secrets?: readonly string[];
    readonly failureExitCode?: number;
  },
): Promise<void> {
  try {
    const result = await operation();
    const serialized = JSON.stringify(result === undefined ? null : result) ?? 'null';
    io.stdout.write(
      `${redactSecrets(
        serialized,
        options.secrets ?? [],
      )}\n`,
    );
  } catch (error) {
    io.setExitCode(options.failureExitCode ?? 1);
    io.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: {
          code: options.errorCode,
          message: redactSecrets(errorMessage(error), options.secrets ?? []),
        },
      })}\n`,
    );
  }
}

export function setTranslationExitCode(io: TranslationJsonCommandIo, code: number): void {
  if (code !== 0) io.setExitCode(code);
}

function redactSecrets(message: string, secrets: readonly string[]): string {
  let redacted = message;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
