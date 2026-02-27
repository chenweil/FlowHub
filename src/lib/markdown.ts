// src/lib/markdown.ts
import { escapeHtml, sanitizeMarkdownUrl } from './html';

export const MARKDOWN_CODE_BLOCK_PLACEHOLDER_PREFIX = '@@MD_CODE_BLOCK_';
export const MARKDOWN_CODE_SPAN_PLACEHOLDER_PREFIX = '@@MD_CODE_SPAN_';

export function normalizeTitleSource(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

export function formatMessageContent(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  return `<div class="markdown-content">${renderMarkdownContent(normalized)}</div>`;
}

export function renderInlineMarkdown(rawText: string): string {
  const codeSpanTokens: string[] = [];
  let html = escapeHtml(rawText);

  html = html.replace(/`([^`\n]+)`/g, (_match, code) => {
    const tokenIndex = codeSpanTokens.push(`<code>${code}</code>`) - 1;
    return `${MARKDOWN_CODE_SPAN_PLACEHOLDER_PREFIX}${tokenIndex}@@`;
  });

  html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (match, alt, url, title) => {
    const safeUrl = sanitizeMarkdownUrl(url, 'image');
    if (!safeUrl) {
      return match;
    }
    const titleAttr = title ? ` title="${title}"` : '';
    return `<img class="md-image" src="${safeUrl}" alt="${alt}" loading="lazy"${titleAttr}>`;
  });

  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (match, label, url, title) => {
    const safeUrl = sanitizeMarkdownUrl(url, 'link');
    if (!safeUrl) {
      return match;
    }
    const titleAttr = title ? ` title="${title}"` : '';
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow"${titleAttr}>${label}</a>`;
  });

  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  html = html.replace(/(^|[^\*])\*([^\*\n]+)\*/g, '$1<em>$2</em>');

  return html.replace(new RegExp(`${MARKDOWN_CODE_SPAN_PLACEHOLDER_PREFIX}(\\d+)@@`, 'g'), (_m, index) => {
    const tokenIndex = Number.parseInt(index, 10);
    return codeSpanTokens[tokenIndex] || '';
  });
}

export function splitMarkdownTableRow(line: string): string[] {
  const normalized = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return normalized.split('|').map((cell) => cell.trim());
}

export function isMarkdownTableDelimiter(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  if (cells.length < 2) {
    return false;
  }
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes('|')) {
    return false;
  }
  return splitMarkdownTableRow(trimmed).length >= 2;
}

export function normalizeMarkdownTableCells(rawCells: string[], columnCount: number): string[] {
  const rowCells: string[] = [];
  for (let col = 0; col < columnCount; col += 1) {
    rowCells.push(rawCells[col] || '');
  }
  return rowCells;
}

export function collectMarkdownTableBodyRows(
  lines: string[],
  startIndex: number,
  columnCount: number
): { rows: string[][]; nextIndex: number } {
  const rows: string[][] = [];
  let index = startIndex;
  let pendingRow = '';

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      break;
    }

    const hasPipe = trimmed.includes('|');
    if (!hasPipe) {
      if (!pendingRow) {
        break;
      }
      // 历史日志里表格行可能被软换行，拼回上一行。
      pendingRow = `${pendingRow} ${trimmed}`.trim();
      index += 1;
    } else if (!pendingRow) {
      pendingRow = trimmed.startsWith('|') ? trimmed : `| ${trimmed}`;
      index += 1;
    } else {
      const pendingColumnCount = splitMarkdownTableRow(pendingRow).length;
      const startsAsNewRow = trimmed.startsWith('|');
      if (startsAsNewRow && pendingColumnCount >= columnCount) {
        rows.push(normalizeMarkdownTableCells(splitMarkdownTableRow(pendingRow), columnCount));
        pendingRow = trimmed;
      } else {
        const segment = startsAsNewRow ? trimmed.replace(/^\|/, '').trim() : trimmed;
        pendingRow = `${pendingRow} ${segment}`.trim();
      }
      index += 1;
    }

    if (!pendingRow) {
      continue;
    }

    const currentColumnCount = splitMarkdownTableRow(pendingRow).length;
    const rowLooksComplete = currentColumnCount >= columnCount && pendingRow.endsWith('|');
    if (rowLooksComplete) {
      rows.push(normalizeMarkdownTableCells(splitMarkdownTableRow(pendingRow), columnCount));
      pendingRow = '';
    }
  }

  if (pendingRow) {
    const rowCells = splitMarkdownTableRow(pendingRow);
    if (rowCells.length >= 2) {
      rows.push(normalizeMarkdownTableCells(rowCells, columnCount));
    }
  }

  return { rows, nextIndex: index };
}

export function renderMarkdownContent(text: string): string {
  const codeBlockTokens: string[] = [];
  const withPlaceholders = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const language = escapeHtml(String(lang || '').trim().split(/\s+/)[0]);
    const escapedCode = escapeHtml(String(code || '').replace(/\n$/, ''));
    const languageClass = language ? ` class="language-${language}"` : '';
    const tokenIndex =
      codeBlockTokens.push(
        `<pre class="md-code-block"><code${languageClass}>${escapedCode}</code></pre>`
      ) - 1;
    return `\n${MARKDOWN_CODE_BLOCK_PLACEHOLDER_PREFIX}${tokenIndex}@@\n`;
  });

  const lines = withPlaceholders.split('\n');
  const blocks: string[] = [];
  let paragraphLines: string[] = [];
  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }
    blocks.push(`<p>${paragraphLines.map((line) => renderInlineMarkdown(line)).join('<br>')}</p>`);
    paragraphLines = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      index += 1;
      continue;
    }

    const codeBlockMatch = trimmed.match(/^@@MD_CODE_BLOCK_(\d+)@@$/);
    if (codeBlockMatch) {
      flushParagraph();
      const tokenIndex = Number.parseInt(codeBlockMatch[1], 10);
      blocks.push(codeBlockTokens[tokenIndex] || '');
      index += 1;
      continue;
    }

    const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      index += 1;
      continue;
    }

    const hrMatch = line.match(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/);
    if (hrMatch) {
      flushParagraph();
      blocks.push('<hr>');
      index += 1;
      continue;
    }

    if (
      index + 1 < lines.length &&
      isMarkdownTableRow(line) &&
      isMarkdownTableDelimiter(lines[index + 1])
    ) {
      flushParagraph();

      const headerCells = splitMarkdownTableRow(line);
      const columnCount = headerCells.length;
      index += 2;

      const tableBody = collectMarkdownTableBodyRows(lines, index, columnCount);
      const bodyRows = tableBody.rows;
      index = tableBody.nextIndex;

      const headerHtml = `<tr>${headerCells.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join('')}</tr>`;
      const bodyHtml = bodyRows
        .map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`)
        .join('');
      blocks.push(
        `<div class="md-table-wrap"><table class="md-table"><thead>${headerHtml}</thead><tbody>${bodyHtml}</tbody></table></div>`
      );
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      flushParagraph();
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
        index += 1;
      }
      blocks.push(`<blockquote>${quoteLines.map((item) => renderInlineMarkdown(item)).join('<br>')}</blockquote>`);
      continue;
    }

    if (/^\s{0,3}[-*+]\s+/.test(line)) {
      flushParagraph();
      const items: string[] = [];
      while (index < lines.length && /^\s{0,3}[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s{0,3}[-*+]\s+/, ''));
        index += 1;
      }
      blocks.push(`<ul>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\s{0,3}\d+\.\s+/.test(line)) {
      flushParagraph();
      const items: string[] = [];
      while (index < lines.length && /^\s{0,3}\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s{0,3}\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push(`<ol>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</ol>`);
      continue;
    }

    paragraphLines.push(line);
    index += 1;
  }
  flushParagraph();

  return blocks.join('').replace(new RegExp(`${MARKDOWN_CODE_BLOCK_PLACEHOLDER_PREFIX}(\\d+)@@`, 'g'), (_m, token) => {
    const tokenIndex = Number.parseInt(token, 10);
    return codeBlockTokens[tokenIndex] || '';
  });
}
