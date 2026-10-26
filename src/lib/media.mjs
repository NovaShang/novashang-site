// Post images and downloads are written as /media/... in Markdown. Each site
// serves them from object storage close to its readers:
//
//   global build: /media/x  ->  R2   https://storage.novashang.com/nova-site-static/x
//   cn build:     /media/x  ->  OSS  https://static.gaoshang.me/nova-site-static/x
//
// npm run media:push uploads to both; CI checks each store has every file
// before deploying the matching site (scripts/check-media.mjs).

export const MEDIA_PREFIX = 'nova-site-static/';
export const R2_ORIGIN = 'https://storage.novashang.com/';
export const OSS_ORIGIN = process.env.PUBLIC_MEDIA_CN_ORIGIN ?? 'https://static.gaoshang.me/';

/** Every /media/... path the published content refers to (drafts are skipped). */
export async function mediaRefs(dir = 'src/content') {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const refs = new Set();
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(md|mdx)$/.test(e.name)) {
        const text = await readFile(p, 'utf8');
        if (/^draft:\s*true\s*$/m.test(text.split(/^---\s*$/m)[1] ?? '')) continue;   // unpublished
        for (const m of text.matchAll(/\/media\/[^\s)"'<>]+/g)) refs.add(m[0]);
      }
    }
  };
  await walk(dir);
  return [...refs].sort();
}

export function mediaUrl(path, cn) {
  if (!path || !path.startsWith('/media/')) return path;
  return (cn ? OSS_ORIGIN : R2_ORIGIN) + MEDIA_PREFIX + path.slice('/media/'.length);
}

/** Rehype plugin: rewrites img src and link href that point at /media/. */
export function rehypeMedia({ cn }) {
  return (tree) => {
    const walk = (node) => {
      if (node.type === 'element') {
        const p = node.properties ?? {};
        if (typeof p.src === 'string') p.src = mediaUrl(p.src, cn);
        if (typeof p.href === 'string') p.href = mediaUrl(p.href, cn);
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

/** Rehype plugin: wraps each table so a wide one scrolls on its own instead of the page. */
export function rehypeTableScroll() {
  return (tree) => {
    const walk = (node) => {
      node.children?.forEach((child, i) => {
        if (child.type === 'element' && child.tagName === 'table') {
          node.children[i] = { type: 'element', tagName: 'div', properties: { className: ['table-scroll'] }, children: [child] };
        } else walk(child);
      });
    };
    walk(tree);
  };
}
