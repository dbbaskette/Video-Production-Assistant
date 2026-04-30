import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const FETCH_TIMEOUT_MS = 30_000;

export async function extractUrlFallback(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html: string;
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'VPA-Brand-Extractor/1.0' } });
    if (!res.ok) throw new Error(`Fetch ${url} failed with status ${res.status}`);
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (!article) {
    return dom.window.document.body?.textContent?.trim() ?? '';
  }
  const md: string[] = [];
  if (article.title) md.push(`# ${article.title}`, '');
  if (article.byline) md.push(`*${article.byline}*`, '');
  md.push(article.textContent.trim());
  return md.join('\n');
}
