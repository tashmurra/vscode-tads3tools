export const MAX_PARSE_INPUT_CHARS = 10 * 1024 * 1024;
export const MAX_INLINE_PARSE_INPUT_CHARS = 256 * 1024;
export const MAX_PROJECT_PARSE_CHARS = 100 * 1024 * 1024;
export const MAX_PROJECT_PARSE_FILES = 4096;
export const WORKER_TIMEOUT_MS = 120_000;

export function isParseInputWithinLimit(text: string): boolean {
  return text.length <= MAX_PARSE_INPUT_CHARS;
}

export function limitProjectParseInputs(paths: string[], getText: (path: string) => string): {
  accepted: string[];
  skipped: string[];
} {
  const accepted: string[] = [];
  const skipped: string[] = [];
  let totalCharacters = 0;
  const uniquePaths = [...new Set(paths)];
  for (const path of uniquePaths) {
    const length = getText(path).length;
    if (
      accepted.length >= MAX_PROJECT_PARSE_FILES ||
      length > MAX_PARSE_INPUT_CHARS ||
      totalCharacters + length > MAX_PROJECT_PARSE_CHARS
    ) {
      skipped.push(path);
      continue;
    }
    totalCharacters += length;
    accepted.push(path);
  }
  return { accepted, skipped };
}

export async function withWorkerTimeout<T>(
  operation: Promise<T>,
  label: string,
  isCancelled: () => boolean = () => false,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  let cancellationCheck: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`TIMEOUT after ${WORKER_TIMEOUT_MS / 1000}s parsing ${label}`)),
      WORKER_TIMEOUT_MS,
    );
  });
  const cancellationPromise = new Promise<never>((_, reject) => {
    cancellationCheck = setInterval(() => {
      if (isCancelled()) reject(new Error(`CANCELLED while parsing ${label}`));
    }, 50);
  });

  try {
    return await Promise.race([operation, timeoutPromise, cancellationPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (cancellationCheck) clearInterval(cancellationCheck);
  }
}
