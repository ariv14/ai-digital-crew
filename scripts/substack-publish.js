/**
 * substack-publish.js — Substack API client for newsletter posts
 *
 * Uses the substack.sid session cookie to authenticate against Substack's
 * internal API. Get your token from browser DevTools:
 *   Application → Cookies → substack.com → substack.sid
 *
 * Set SUBSTACK_SID as a GitHub Actions secret.
 */

const SUBSTACK_SID = process.env.SUBSTACK_SID;
const SUBSTACK_URL = process.env.SUBSTACK_URL; // e.g. https://arimatch1.substack.com

/**
 * Build a ProseMirror doc JSON string from writeup content.
 */
function buildProseMirrorDoc(writeup, quickStart, repoUrl, repoFullName) {
  const content = [];

  // Writeup paragraphs
  for (const line of writeup.split('\n')) {
    if (line.trim()) {
      content.push({ type: 'paragraph', content: [{ type: 'text', text: line }] });
    } else {
      content.push({ type: 'paragraph' });
    }
  }

  // Quick Start heading
  content.push({ type: 'paragraph' });
  content.push({
    type: 'paragraph',
    content: [{ type: 'text', text: '⚡ Quick Start', marks: [{ type: 'bold' }] }],
  });

  // Quick Start steps
  content.push({
    type: 'orderedList',
    content: quickStart.map(step => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: step }] }],
    })),
  });

  // GitHub link
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

  // Footer
  content.push({ type: 'paragraph' });
  content.push({
    type: 'paragraph',
    content: [{ type: 'text', text: '— Auto-discovered by AI Digital Crew • aidigitalcrew.com' }],
  });

  return JSON.stringify({ type: 'doc', content });
}

/**
 * Main export: publish one "Project of the Day" post via Substack API.
 */
export async function publishToSubstack({ repoMeta, writeup, quickStart }) {
  if (!SUBSTACK_URL) {
    console.warn('SUBSTACK_URL not set — skipping Substack publish');
    return;
  }
  if (!SUBSTACK_SID) {
    console.warn('SUBSTACK_SID not set — skipping Substack publish');
    return;
  }

  const pub = SUBSTACK_URL.replace(/\/$/, '');
  const title = `🤖 Project of the Day: ${repoMeta.name}`;
  const subtitle = `Today's featured AI project: ${repoMeta.full_name} ⭐ ${repoMeta.stargazers_count}`;
  const draftBody = buildProseMirrorDoc(writeup, quickStart, repoMeta.html_url, repoMeta.full_name);

  const headers = {
    'Content-Type': 'application/json',
    Cookie: `substack.sid=${SUBSTACK_SID}`,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  };

  // 1. Create draft
  console.log('Creating Substack draft...');
  const draftRes = await fetch(`${pub}/api/v1/drafts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      draft_title: title,
      draft_subtitle: subtitle,
      draft_body: draftBody,
      audience: 'everyone',
      type: 'newsletter',
    }),
  });

  if (!draftRes.ok) {
    const text = await draftRes.text();
    throw new Error(`Failed to create draft (${draftRes.status}): ${text}`);
  }

  const draft = await draftRes.json();
  console.log(`Draft created: id=${draft.id}`);

  // 2. Publish draft
  console.log('Publishing draft...');
  const publishRes = await fetch(`${pub}/api/v1/posts/${draft.id}/publish`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ send_email: true, audience: 'everyone' }),
  });

  if (!publishRes.ok) {
    const text = await publishRes.text();
    throw new Error(`Failed to publish post (${publishRes.status}): ${text}`);
  }

  const published = await publishRes.json();
  console.log(`Post published: ${pub}/p/${published.slug || draft.id}`);
}
