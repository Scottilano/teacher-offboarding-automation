export const MIB = 1024 * 1024;
export const DEFAULT_MAX_FILE_MB = 50;
export function importLimits(config = {}) {
  const maxFileMb = config.import?.maxFileMb ?? DEFAULT_MAX_FILE_MB;
  if (!Number.isInteger(maxFileMb) || maxFileMb < 1 || maxFileMb > 100) {
    throw new Error('import.maxFileMb must be an integer from 1 to 100.');
  }
  const maxFileBytes = maxFileMb * MIB;
  return { maxFileMb, maxFileBytes, maxRequestBytes: Math.ceil(maxFileBytes / 3) * 4 + MIB,
    maxExtractedBytes: maxFileBytes * 4, timeoutMs: 60000 };
}
