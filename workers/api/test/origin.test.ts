import { describe, it, expect } from 'vitest';
import { isOriginAllowed } from '../src/lib/origin';

const ALLOWED = 'https://aidigitalcrew.com';

describe('isOriginAllowed', () => {
  it('accepts requests with matching Origin header', () => {
    const req = new Request('https://aidigitalcrew.com/api/search', {
      headers: { Origin: ALLOWED },
    });
    expect(isOriginAllowed(req, ALLOWED)).toBe(true);
  });

  it('accepts requests with matching Referer when Origin is missing', () => {
    const req = new Request('https://aidigitalcrew.com/api/search', {
      headers: { Referer: 'https://aidigitalcrew.com/some/page' },
    });
    expect(isOriginAllowed(req, ALLOWED)).toBe(true);
  });

  it('rejects requests with no Origin and no Referer', () => {
    const req = new Request('https://aidigitalcrew.com/api/search');
    expect(isOriginAllowed(req, ALLOWED)).toBe(false);
  });

  it('rejects requests with mismatched Origin', () => {
    const req = new Request('https://aidigitalcrew.com/api/search', {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(isOriginAllowed(req, ALLOWED)).toBe(false);
  });

  it('rejects requests where Referer points to a different host', () => {
    const req = new Request('https://aidigitalcrew.com/api/search', {
      headers: { Referer: 'https://evil.example.com/spoof' },
    });
    expect(isOriginAllowed(req, ALLOWED)).toBe(false);
  });
});
