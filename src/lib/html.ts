// src/lib/html.ts

export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function decodeHtmlEntities(value: string): string {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = value;
  return textarea.value;
}

export function sanitizeMarkdownUrl(rawUrl: string, usage: 'link' | 'image'): string | null {
  const decoded = decodeHtmlEntities(rawUrl).trim();
  if (!decoded || /\s/.test(decoded)) {
    return null;
  }

  if (decoded.startsWith('/') || decoded.startsWith('./') || decoded.startsWith('../')) {
    return escapeHtml(decoded);
  }

  if (decoded.startsWith('www.')) {
    return escapeHtml(`https://${decoded}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(decoded);
  } catch {
    return null;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (usage === 'image') {
    if (protocol === 'http:' || protocol === 'https:') {
      return escapeHtml(decoded);
    }
    if (protocol === 'data:' && decoded.toLowerCase().startsWith('data:image/')) {
      return escapeHtml(decoded);
    }
    return null;
  }

  if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
    return escapeHtml(decoded);
  }
  return null;
}
