export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const MAX_QUERY_LEN = 200;
const MAX_REPO_NAME_LEN = 200;
const MIN_BATCH = 1;
const MAX_BATCH = 12;

export function validateQuery(input: unknown): string {
  if (typeof input !== 'string') {
    throw new ValidationError('query must be a string');
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('query must not be empty');
  }
  if (input.length > MAX_QUERY_LEN) {
    throw new ValidationError(`query must be ${MAX_QUERY_LEN} characters or fewer`);
  }
  return input;
}

export function validateRepoName(input: unknown): string {
  if (typeof input !== 'string') {
    throw new ValidationError('repo must be a string');
  }
  if (input.length === 0) {
    throw new ValidationError('repo must not be empty');
  }
  if (input.length > MAX_REPO_NAME_LEN) {
    throw new ValidationError(`repo must be ${MAX_REPO_NAME_LEN} characters or fewer`);
  }
  return input;
}

export function validateFindSimilar(input: unknown): string {
  // Same constraints as repo name; separated for clarity at call sites.
  return validateRepoName(input);
}

export function validateFindSimilarBatch(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new ValidationError('findSimilarBatch must be an array');
  }
  if (input.length < MIN_BATCH || input.length > MAX_BATCH) {
    throw new ValidationError(`findSimilarBatch must contain between ${MIN_BATCH} and ${MAX_BATCH} entries`);
  }
  for (const entry of input) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_REPO_NAME_LEN) {
      throw new ValidationError(`findSimilarBatch entries must be non-empty strings of ${MAX_REPO_NAME_LEN} characters or fewer`);
    }
  }
  return input as string[];
}
