// Moves the magenta tile between its two homes.
//
//   hero:   a large upright tile in the [data-brand-slot] above the name on the
//           landing page
//   corner: the tilted tab tucked into the nav's top-left corner
//
// On the landing page the scroll position blends between the two (the tile
// spins a quarter turn, shrinks and docks while the nav title fades in). On a
// page change the tile is persisted by the view-transition router and flies
// from wherever it was to wherever the new page wants it.

interface Pose {
  x: number;      // tile centre, viewport px
  y: number;
  size: number;   // tile edge, px
  angle: number;  // degrees
  mx: number;     // mark centre, viewport px
  my: number;
  mscale: number;
}

const TILE = 104;          // base size of the tile element
const MARK_W = 30, MARK_H = 32;
const DOCK_SCROLL = 240;   // px of scrolling that takes the tile from hero to corner
const FLIGHT_MS = 700;

function cornerPose(): Pose {
  const wide = matchMedia('(min-width: 768px)').matches;
  // Centre and size of the corner tab, and where the upright mark sits in the
  // part of it that's on screen (matches the 2024 site).
  return wide
    ? { x: 10, y: 12, size: 104, angle: -15, mx: 38.6, my: 26.1, mscale: 1 }
    : { x: 6, y: 8, size: 84, angle: -15, mx: 27.5, my: 18.8, mscale: 0.8667 };
}

function heroPose(slot: Element): Pose {
  const r = slot.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  // a quarter turn more than the corner, so the square spins as it docks but
  // looks the same at both ends
  return { x, y, size: r.width, angle: -105, mx: x, my: y, mscale: (r.width / TILE) * 1.45 };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (a: Pose, b: Pose, t: number): Pose => ({
  x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), size: lerp(a.size, b.size, t),
  angle: lerp(a.angle, b.angle, t), mx: lerp(a.mx, b.mx, t), my: lerp(a.my, b.my, t),
  mscale: lerp(a.mscale, b.mscale, t),
});
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (t: number) => t * t * (3 - 2 * t);

let shown: Pose | null = null;
let flight: { from: Pose; start: number } | null = null;
let raf = 0;

function targetPose(): { pose: Pose; docked: number } {
  const slot = document.querySelector('[data-brand-slot]');
  const corner = cornerPose();
  if (!slot) return { pose: corner, docked: 1 };
  const p = smooth(Math.min(1, Math.max(0, window.scrollY / DOCK_SCROLL)));
  return { pose: mix(heroPose(slot), corner, p), docked: p };
}

function apply(pose: Pose, docked: number) {
  const tile = document.querySelector<HTMLElement>('[data-brand-tile]');
  const mark = document.querySelector<HTMLElement>('[data-brand-mark]');
  if (!tile || !mark) return;
  tile.parentElement?.classList.add('is-placed');
  tile.style.transform =
    `translate(${pose.x - TILE / 2}px, ${pose.y - TILE / 2}px) rotate(${pose.angle}deg) scale(${pose.size / TILE})`;
  mark.style.transform =
    `translate(${pose.mx - MARK_W / 2}px, ${pose.my - MARK_H / 2}px) scale(${pose.mscale})`;
  // the nav title takes over from the big name as the tile docks
  const title = document.querySelector<HTMLElement>('[data-nav-title]');
  if (title) title.style.opacity = String(smooth(Math.min(1, Math.max(0, (docked - 0.55) / 0.45))));
}

function frame(now: number) {
  raf = 0;
  const { pose, docked } = targetPose();
  if (flight) {
    const t = Math.min(1, (now - flight.start) / FLIGHT_MS);
    shown = mix(flight.from, pose, easeInOut(t));
    if (t >= 1) flight = null;
  } else {
    shown = pose;
  }
  apply(shown, docked);
  if (flight) kick();
}

function kick() {
  if (!raf) raf = requestAnimationFrame(frame);
}

let bound = false;
export function initBrand() {
  if (bound) return;
  bound = true;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  document.addEventListener('astro:page-load', () => {
    // fly from the last pose on the previous page, if there was one
    if (shown && !reduced) flight = { from: shown, start: performance.now() };
    kick();
  });
  addEventListener('scroll', kick, { passive: true });
  addEventListener('resize', kick, { passive: true });
}
