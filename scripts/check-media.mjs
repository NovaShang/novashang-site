// Fail if any /media/... path in the content is missing from a store, so a
// post with broken images never gets published. Fix with: npm run media:push
// Usage: node scripts/check-media.mjs r2|oss
import { MEDIA_PREFIX, R2_ORIGIN, OSS_ORIGIN, mediaRefs } from '../src/lib/media.mjs';

const store = process.argv[2] ?? 'r2';
const origin = { r2: R2_ORIGIN, oss: OSS_ORIGIN }[store];
if (!origin) throw new Error(`unknown store ${store}; use r2 or oss`);

const missing = [];
for (const ref of await mediaRefs()) {
  const res = await fetch(origin + MEDIA_PREFIX + ref.slice('/media/'.length), { method: 'HEAD' });
  if (!res.ok) missing.push(`${ref} (HTTP ${res.status})`);
}
if (missing.length) {
  console.error(`Not in ${store.toUpperCase()} yet, run npm run media:push:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(`all media present in ${store.toUpperCase()}`);
