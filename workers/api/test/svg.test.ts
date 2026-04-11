import { describe, it, expect } from 'vitest';
import { generateBadgeSvg } from '../src/lib/svg';

describe('generateBadgeSvg', () => {
  it('returns a well-formed SVG document', () => {
    const svg = generateBadgeSvg('Hot', '85', 'hot');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('includes the trend label and score in the right-hand text', () => {
    const svg = generateBadgeSvg('Rising', '60', 'rising');
    expect(svg).toContain('Rising 60');
  });

  it('uses the hot color (#dc2626) for hot trend', () => {
    const svg = generateBadgeSvg('Hot', '90', 'hot');
    expect(svg).toContain('#dc2626');
  });

  it('uses the rising color (#059669) for rising trend', () => {
    const svg = generateBadgeSvg('Rising', '50', 'rising');
    expect(svg).toContain('#059669');
  });

  it('falls back to steady color for unknown trend label', () => {
    const svg = generateBadgeSvg('Cooling', '10', 'banana');
    expect(svg).toContain('#6b7280');
  });

  it('left text is the constant brand label', () => {
    const svg = generateBadgeSvg('New', '0', 'new');
    expect(svg).toContain('trending on AI Digital Crew');
  });
});
