// Copy any /media/... file the content uses from R2 to OSS if OSS is missing
// it or has a different size. Run by CI before the cn deploy.
// Env: OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_BUCKET, OSS_REGION (e.g. oss-cn-hangzhou)
import OSS from 'ali-oss';
import { MEDIA_PREFIX, R2_ORIGIN, mediaRefs } from '../src/lib/media.mjs';

const client = new OSS({
  accessKeyId: process.env.OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
  bucket: process.env.OSS_BUCKET,
  region: process.env.OSS_REGION,
  secure: true,
});

let copied = 0, kept = 0;
for (const ref of await mediaRefs()) {
  const key = MEDIA_PREFIX + ref.slice('/media/'.length);
  const src = await fetch(R2_ORIGIN + key, { method: 'HEAD' });
  if (!src.ok) throw new Error(`${ref}: not in R2 (HTTP ${src.status}); run npm run media:push first`);
  const size = Number(src.headers.get('content-length'));
  try {
    const head = await client.head(key);
    if (Number(head.res.headers['content-length']) === size) { kept++; continue; }
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const body = Buffer.from(await (await fetch(R2_ORIGIN + key)).arrayBuffer());
  await client.put(key, body, { headers: { 'Content-Type': src.headers.get('content-type') ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000' } });
  console.log(`copied ${key}`);
  copied++;
}
console.log(`OSS: ${copied} copied, ${kept} already there`);
