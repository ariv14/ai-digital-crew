export type TrendLabel = 'hot' | 'rising' | 'steady' | 'declining' | 'new';

const COLORS: Record<TrendLabel, { bg: string; text: string }> = {
  hot:       { bg: '#dc2626', text: '#fff' },
  rising:    { bg: '#059669', text: '#fff' },
  steady:    { bg: '#6b7280', text: '#fff' },
  declining: { bg: '#6b7280', text: '#d1d5db' },
  new:       { bg: '#2563eb', text: '#fff' },
};

const ICONS: Record<TrendLabel, string> = {
  hot:       '\uD83D\uDD25', // 🔥
  rising:    '\u2B06\uFE0F', // ⬆️
  steady:    '\u2796',       // ➖
  declining: '\u2B07\uFE0F', // ⬇️
  new:       '\u2728',       // ✨
};

const FALLBACK_LABEL: TrendLabel = 'steady';

/**
 * Generate the dynamic SVG badge served by /api/badge.
 * Direct port of the trendBadge function in functions/index.js.
 */
export function generateBadgeSvg(label: string, score: string, trendLabel: TrendLabel | string): string {
  const key = (trendLabel in COLORS ? trendLabel : FALLBACK_LABEL) as TrendLabel;
  const c = COLORS[key];
  const icon = ICONS[key] ?? '';
  const leftText = 'trending on AI Digital Crew';
  const rightText = `${icon} ${label} ${score}`;
  const leftW = leftText.length * 6.2 + 20;
  const rightW = rightText.length * 6.2 + 20;
  const totalW = leftW + rightW;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${leftText}: ${rightText}">
  <title>${leftText}: ${rightText}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${leftW}" height="20" fill="#555"/>
    <rect x="${leftW}" width="${rightW}" height="20" fill="${c.bg}"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="${leftW / 2}" y="14">${leftText}</text>
    <text x="${leftW + rightW / 2}" y="14" fill="${c.text}">${rightText}</text>
  </g>
</svg>`;
}
