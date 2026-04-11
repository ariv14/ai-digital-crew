import { describe, it, expect } from 'vitest';
import {
  validateQuery,
  validateRepoName,
  validateFindSimilar,
  validateFindSimilarBatch,
  ValidationError,
} from '../src/lib/validation';

describe('validateQuery', () => {
  it('accepts a normal query string', () => {
    expect(validateQuery('vector database')).toBe('vector database');
  });

  it('rejects empty string', () => {
    expect(() => validateQuery('')).toThrow(ValidationError);
  });

  it('rejects whitespace-only string', () => {
    expect(() => validateQuery('   ')).toThrow(ValidationError);
  });

  it('rejects non-string input', () => {
    expect(() => validateQuery(42)).toThrow(ValidationError);
  });

  it('rejects strings over 200 chars', () => {
    expect(() => validateQuery('a'.repeat(201))).toThrow(ValidationError);
  });

  it('accepts strings exactly 200 chars', () => {
    expect(validateQuery('a'.repeat(200))).toBe('a'.repeat(200));
  });
});

describe('validateRepoName', () => {
  it('accepts owner/repo style', () => {
    expect(validateRepoName('infiniflow/ragflow')).toBe('infiniflow/ragflow');
  });

  it('rejects empty', () => {
    expect(() => validateRepoName('')).toThrow(ValidationError);
  });

  it('rejects too long', () => {
    expect(() => validateRepoName('a'.repeat(201))).toThrow(ValidationError);
  });

  it('rejects non-string', () => {
    expect(() => validateRepoName(null)).toThrow(ValidationError);
  });
});

describe('validateFindSimilar', () => {
  it('accepts a valid repo name', () => {
    expect(validateFindSimilar('infiniflow/ragflow')).toBe('infiniflow/ragflow');
  });
  it('shares the same constraints as validateRepoName', () => {
    expect(() => validateFindSimilar('a'.repeat(201))).toThrow(ValidationError);
  });
});

describe('validateFindSimilarBatch', () => {
  it('accepts a 1-element array', () => {
    expect(validateFindSimilarBatch(['a/b'])).toEqual(['a/b']);
  });
  it('accepts a 12-element array', () => {
    const arr = Array.from({ length: 12 }, (_, i) => `owner/repo${i}`);
    expect(validateFindSimilarBatch(arr)).toEqual(arr);
  });
  it('rejects a 13-element array', () => {
    const arr = Array.from({ length: 13 }, (_, i) => `owner/repo${i}`);
    expect(() => validateFindSimilarBatch(arr)).toThrow(ValidationError);
  });
  it('rejects an empty array', () => {
    expect(() => validateFindSimilarBatch([])).toThrow(ValidationError);
  });
  it('rejects a non-array', () => {
    expect(() => validateFindSimilarBatch('not-an-array')).toThrow(ValidationError);
  });
  it('rejects an array containing a non-string', () => {
    expect(() => validateFindSimilarBatch(['ok', 42])).toThrow(ValidationError);
  });
});
