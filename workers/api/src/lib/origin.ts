/**
 * Returns true if the request was made from an allowed origin.
 * Accepts a match on Origin OR Referer (Referer host must equal allowed host).
 *
 * Used only on /api/search. /api/badge intentionally does NOT call this
 * because badges are embedded in third-party markdown and the user-agent
 * controls whether Origin/Referer is sent.
 */
export function isOriginAllowed(request: Request, allowedOrigin: string): boolean {
  const origin = request.headers.get('Origin');
  if (origin && origin === allowedOrigin) return true;

  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      const refUrl = new URL(referer);
      const allowedUrl = new URL(allowedOrigin);
      if (refUrl.origin === allowedUrl.origin) return true;
    } catch {
      // Malformed Referer header — fall through to reject
    }
  }

  return false;
}
