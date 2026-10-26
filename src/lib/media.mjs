// Post images and downloads are written as /media/... in Markdown. The files
// themselves live in the R2 bucket nova-public under nova-site-static/.
//
//   global build: /media/x  ->  https://storage.novashang.com/nova-site-static/x
//   cn build:     /media/x  stays as is; CI copies the files into dist-cn/media
//                 (scripts/fetch-media.mjs) so they're served from inside China

export const MEDIA_ORIGIN = 'https://storage.novashang.com/nova-site-static/';

export function mediaUrl(path, cn) {
  if (!path || !path.startsWith('/media/')) return path;
  return cn ? path : MEDIA_ORIGIN + path.slice('/media/'.length);
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
