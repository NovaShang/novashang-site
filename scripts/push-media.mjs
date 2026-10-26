// Upload post media to both object stores: R2 (global site) and OSS (cn site).
// Put files under media/ (git-ignored) with the same layout as the /media/...
// paths in Markdown, then: npm run media:push
// Files already present with the same size are skipped.
//
// R2 goes through your local wrangler login. OSS needs, in .env (git-ignored)
// or the environment: OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_BUCKET,
// OSS_REGION (e.g. oss-cn-hangzhou).
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import OSS from 'ali-oss';
import { MEDIA_PREFIX, R2_ORIGIN } from '../src/lib/media.mjs';

const R2_BUCKET = 'nova-public';
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm' };

const ossEnv = ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_REGION'];
const missingEnv = ossEnv.filter((k) => !process.env[k]);
if (missingEnv.length) {
  console.error(`OSS not configured (${missingEnv.join(', ')} missing); add them to .env`);
  process.exit(1);
}
const oss = new OSS({
  accessKeyId: process.env.OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
  bucket: process.env.OSS_BUCKET,
  region: process.env.OSS_REGION,
  secure: true,
  timeout: 600_000,   // uploads to mainland China can be slow from abroad
});

const ossSize = async (key) => {
  try {
    return Number((await oss.head(key)).res.headers['content-length']);
  } catch (e) {
    if (e.status === 404) return -1;
    throw e;
  }
};

async function* files(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (!e.name.startsWith('.')) yield p;
  }
}

const sameSize = async (url, size) => {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok && Number(res.headers.get('content-length')) === size;
  } catch {
    return false;   // not reachable yet (DNS, certificate): upload to be safe
  }
};

for await (const f of files('media')) {
  const key = MEDIA_PREFIX + relative('media', f).split('\\').join('/');
  const size = (await stat(f)).size;
  const type = TYPES[extname(f).toLowerCase()] ?? 'application/octet-stream';

  if (await sameSize(R2_ORIGIN + key, size)) console.log(`R2   skip ${key}`);
  else {
    execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `${R2_BUCKET}/${key}`, '--file', f, '--content-type', type, '--remote'], { stdio: 'inherit' });
  }

  if (await ossSize(key) === size) console.log(`OSS  skip ${key}`);
  else {
    const headers = { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000' };
    if (size > 5 * 1024 * 1024) await oss.multipartUpload(key, f, { headers, partSize: 1024 * 1024, parallel: 4 });
    else await oss.put(key, await readFile(f), { headers });
    console.log(`OSS  put  ${key}`);
  }
}
