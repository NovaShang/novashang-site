// Fail if any /media/... path in the content isn't in R2 yet, so a post with
// broken images never gets published. Fix with: npm run media:push
import { MEDIA_PREFIX, R2_ORIGIN, mediaRefs } from '../src/lib/media.mjs';

const missing = [];
for (const ref of await mediaRefs()) {
  const res = await fetch(R2_ORIGIN + MEDIA_PREFIX + ref.slice('/media/'.length), { method: 'HEAD' });
  if (!res.ok) missing.push(`${ref} (HTTP ${res.status})`);
}
if (missing.length) {
  console.error(`Not in R2 yet, run npm run media:push:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log('all media present in R2');
