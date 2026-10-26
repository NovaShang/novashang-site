// Upload new post media to R2. Put files under media/ (git-ignored) using the
// same layout as the /media/... paths in Markdown, then: npm run media:push
// Existing objects with the same size are skipped.
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MEDIA_ORIGIN } from '../src/lib/media.mjs';

const BUCKET = 'nova-public', PREFIX = 'nova-site-static/';

async function* files(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (!e.name.startsWith('.')) yield p;
  }
}

for await (const f of files('media')) {
  const key = relative('media', f).split('\\').join('/');
  const head = await fetch(MEDIA_ORIGIN + key, { method: 'HEAD' });
  if (head.ok && Number(head.headers.get('content-length')) === (await stat(f)).size) {
    console.log(`skip ${key}`);
    continue;
  }
  execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${PREFIX}${key}`, '--file', f, '--remote'], { stdio: 'inherit' });
}
