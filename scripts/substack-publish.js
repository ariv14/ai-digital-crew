/**
 * substack-publish.js — fires a Pipedream webhook to publish to Substack
 *
 * The actual Substack API call is made from Pipedream (trusted IP, bypasses
 * Cloudflare). This script builds the post payload and POSTs it to Pipedream.
 */

const PIPEDREAM_WEBHOOK_URL = process.env.PIPEDREAM_WEBHOOK_URL;

/**
 * Build a ProseMirror doc JSON string from writeup content.
 */
function buildProseMirrorDoc(writeup, quickStart, repoUrl, repoFullName) {
  const content = [];

  // Inbox prompt — helps Gmail deliver to Primary
  content.push({
    type: 'paragraph',
    content: [{ type: 'text', text: '📥 Found this in Promotions? Move it to Primary so you never miss a pick.', marks: [{ type: 'italic' }] }],
  });
  content.push({ type: 'paragraph' });

  for (const line of writeup.split('\n')) {
    if (line.trim()) {
      content.push({ type: 'paragraph', content: [{ type: 'text', text: line }] });
    } else {
      content.push({ type: 'paragraph' });
    }
  }

  content.push({ type: 'paragraph' });
  content.push({
    type: 'paragraph',
    content: [{ type: 'text', text: '⚡ Quick Start', marks: [{ type: 'bold' }] }],
  });

  content.push({
    type: 'orderedList',
    content: quickStart.map(step => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: step }] }],
    })),
  });

  content.push({ type: 'paragraph' });
  content.push({
    type: 'paragraph',
    content: [
      { type: 'text', text: '🔗 ' },
      {
        type: 'text',
        text: `View ${repoFullName} on GitHub`,
        marks: [{ type: 'link', attrs: { href: repoUrl, target: '_blank' } }],
      },
    ],
  });

  content.push({ type: 'paragraph' });
  content.push({
    type: 'paragraph',
    content: [{ type: 'text', text: '— Auto-discovered by AI Digital Crew • aidigitalcrew.com' }],
  });

  return JSON.stringify({ type: 'doc', content });
}

/**
 * Main export: sends post data to Pipedream which calls the Substack API.
 */
export async function publishToSubstack({ repoMeta, writeup, quickStart }) {
  if (!PIPEDREAM_WEBHOOK_URL) {
    console.warn('PIPEDREAM_WEBHOOK_URL not set — skipping Substack publish');
    return;
  }

  const payload = {
    title: `🤖 Project of the Day: ${repoMeta.name}`,
    subtitle: `Today's featured AI project: ${repoMeta.full_name} ⭐ ${repoMeta.stargazers_count}`,
    draftBody: buildProseMirrorDoc(writeup, quickStart, repoMeta.html_url, repoMeta.full_name),
    repoUrl: repoMeta.html_url,
    repoFullName: repoMeta.full_name,
  };

  console.log('Sending to Pipedream...');
  const res = await fetch(PIPEDREAM_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pipedream webhook failed (${res.status}): ${text}`);
  }

  console.log('Substack publish triggered via Pipedream ✓');
}
