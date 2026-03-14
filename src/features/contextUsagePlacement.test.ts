import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

function loadDocument() {
  const html = readFileSync('index.html', 'utf-8');
  return new JSDOM(html, { url: 'http://localhost' }).window.document;
}

describe('context usage placement', () => {
  it('places context usage inside input hints row', () => {
    const document = loadDocument();
    const wrapper = document.getElementById('context-usage-wrapper');
    const hints = document.querySelector('.input-hints');
    expect(wrapper?.parentElement).toBe(hints);
  });
});
