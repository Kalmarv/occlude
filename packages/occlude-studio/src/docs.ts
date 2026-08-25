/**
 * Web docs: the repo's markdown docs rendered in the browser, same deck
 * chrome as the studio. Source of truth stays in docs/*.md.
 */

import './style.css';
import { marked } from 'marked';
import apiMd from '../../../docs/api.md?raw';
import architectureMd from '../../../docs/architecture.md?raw';
import readmeMd from '../../../README.md?raw';

const PAGES: { slug: string; title: string; md: string }[] = [
  { slug: 'api', title: 'API reference', md: apiMd },
  { slug: 'architecture', title: 'Architecture', md: architectureMd },
  { slug: 'readme', title: 'README', md: readmeMd },
];

const nav = document.getElementById('docs-nav')!;
const content = document.getElementById('docs-content')!;

function currentSlug(): string {
  const slug = location.hash.replace(/^#\/?/, '').split('#')[0];
  return PAGES.some((p) => p.slug === slug) ? slug : 'api';
}

async function show(slug: string): Promise<void> {
  const page = PAGES.find((p) => p.slug === slug) ?? PAGES[0];
  content.innerHTML = await marked.parse(page.md);
  document.title = `occlude docs — ${page.title}`;
  for (const a of nav.querySelectorAll('a')) {
    a.classList.toggle('active', a.dataset.slug === page.slug);
  }
  // Cross-doc relative links (e.g. ../plan.md) aren't served — neutralise
  // them; same-page anchors keep working.
  for (const a of content.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (href.endsWith('.md') || href.startsWith('..')) {
      const target = PAGES.find((p) => href.includes(`${p.slug}.md`));
      if (target) {
        a.href = `#/${target.slug}`;
      } else {
        a.replaceWith(...a.childNodes);
      }
    }
  }
  window.scrollTo(0, 0);
}

for (const page of PAGES) {
  const a = document.createElement('a');
  a.textContent = page.title;
  a.href = `#/${page.slug}`;
  a.dataset.slug = page.slug;
  nav.append(a);
}

window.addEventListener('hashchange', () => void show(currentSlug()));
void show(currentSlug());
