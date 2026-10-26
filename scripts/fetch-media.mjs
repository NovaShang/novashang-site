// cn build only: copy every /media/... file the content refers to from R2's
// public origin into dist-cn/media, so ESA serves them from inside China.
// Usage: node scripts/fetch-media.mjs [outDir=dist-cn]
import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { MEDIA_ORIGIN } from '../src/lib/media.mjs';

const outDir = process.argv[2] ?? 'dist-cn';

async function* files(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.(md|mdx)$/.test(e.name)) yield p;
  }
}

const refs = new Set();
for await (const f of files('src/content')) {
  for (const m of (await readFile(f, 'utf8')).matchAll(/\/media\/[^\s)"'<>]+/g)) refs.add(m[0]);
}

let fetched = 0;
for (const ref of [...refs].sort()) {
  const rel = ref.slice('/media/'.length);
  const res = await fetch(MEDIA_ORIGIN + rel);
  if (!res.ok) throw new Error(`${ref}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 25 * 1024 * 1024) throw new Error(`${ref}: ${buf.length} bytes, over ESA's 25 MB per-file limit`);
  const dest = join(outDir, 'media', rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  fetched++;
}
console.log(`fetched ${fetched} media files into ${outDir}/media`);
