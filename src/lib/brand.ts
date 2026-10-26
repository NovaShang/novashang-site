// The magenta tile has one home in the galaxy scene and one in the nav.
//
//   scene:  on the landing page the tile is a 3D object floating in front of
//           the galaxy's core, drawn by the galaxy renderer
//   corner: the tilted tab tucked into the nav's top-left corner
//
// This DOM tile does the travelling between them. On the landing page it sits
// exactly on top of the scene's tile (whose screen position the renderer
// publishes in brandTarget) and takes over once you start scrolling: it
// spins a quarter turn, shrinks and docks while the nav title fades in. The
// dock is a timed animation triggered by scrolling past a small threshold,
// not tied to the scroll distance, so a quick flick still shows all of it. On a page change it is
// persisted by the view-transition router and flies to wherever the new page
// wants it. While it's back on the scene tile it hides and the scene draws it.

import { brandTarget, type ScreenTile } from './brandTarget';

interface Pose {
  x: number;      // tile centre, viewport px
  y: number;
  size: number;   // tile edge, px
  angle: number;  // degrees
  radius: number; // corner radius before scaling, px
  mx: number;     // mark centre, viewport px
  my: number;
  mscale: number;
}

const TILE = 104;          // base size of the tile element
const MARK_W = 30, MARK_H = 32;
const DOCK_AT = 40;        // scrolled px that send the tile to the nav
const UNDOCK_AT = 12;      // and back to the scene (a gap, so it doesn't flicker)
const DOCK_MS = 650;
const FLIGHT_MS = 900;

function cornerPose(): Pose {
  const wide = matchMedia('(min-width: 768px)').matches;
  // Centre and size of the corner tab, and where the upright mark sits in the
  // part of it that's on screen (matches the 2024 site), below any notch.
  const nav = document.querySelector<HTMLElement>('[data-nav]');
  const top = nav ? parseFloat(getComputedStyle(nav).paddingTop) || 0 : 0;
  const p = wide
    ? { x: 10, y: 12, size: 104, angle: -15, radius: 14, mx: 38.6, my: 26.1, mscale: 1 }
    : { x: 6, y: 8, size: 84, angle: -15, radius: 14, mx: 27.5, my: 18.8, mscale: 0.8667 };
  return { ...p, y: p.y + top, my: p.my + top };
}

function scenePose(t: ScreenTile): Pose {
  // a quarter turn more than it looks, so the square spins as it docks
  // but looks the same at both ends; the mark is 46% of the tile, as in the avatar
  return { x: t.x, y: t.y, size: t.size, angle: t.angle - 90, radius: 14, mx: t.x, my: t.y, mscale: (t.size * 0.46) / MARK_H };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const KEYS = ['x', 'y', 'size', 'angle', 'radius', 'mx', 'my', 'mscale'] as const;
const mix = (a: Pose, b: Pose, t: number): Pose =>
  Object.fromEntries(KEYS.map((k) => [k, lerp(a[k], b[k], t)])) as unknown as Pose;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (t: number) => t * t * (3 - 2 * t);

let shown: Pose | null = null;
let flight: { from: Pose; start: number } | null = null;
let raf = 0;
let lastKey = '';
let dockGoal = 0;          // 0 in the scene, 1 in the nav
let dockT = 0;             // where the timed dock animation is, 0..1
let lastFrame = 0;

const onLanding = () => document.body.dataset.shot === 'home';

function targetPose(): { pose: Pose; docked: number } {
  const corner = cornerPose();
  const scene = onLanding() ? brandTarget.scene : null;
  if (!scene) return { pose: corner, docked: 1 };
  const p = easeInOut(dockT);
  return { pose: mix(scenePose(scene), corner, p), docked: p };
}

function apply(pose: Pose, docked: number, inScene: boolean) {
  const brand = document.querySelector<HTMLElement>('[data-brand]');
  const tile = document.querySelector<HTMLElement>('[data-brand-tile]');
  const mark = document.querySelector<HTMLElement>('[data-brand-mark]');
  if (!brand || !tile || !mark) return;
  // only touch the DOM when something visibly changed
  const key = [...KEYS.map((k) => Math.round(pose[k] * 10)), Math.round(docked * 100), inScene ? 1 : 0].join();
  if (key === lastKey) return;
  lastKey = key;
  const scale = pose.size / TILE;
  tile.style.transform =
    `translate(${pose.x - TILE / 2}px, ${pose.y - TILE / 2}px) rotate(${pose.angle}deg) scale(${scale})`;
  tile.style.borderRadius = `${pose.radius}px`;
  mark.style.transform =
    `translate(${pose.mx - MARK_W / 2}px, ${pose.my - MARK_H / 2}px) scale(${pose.mscale})`;
  // resting on the scene's tile: let the scene draw it
  brand.classList.toggle('in-scene', inScene);
  brandTarget.docked = !inScene;
  brand.classList.add('is-placed');
  // the bar and the nav title fill in as the tile docks
  const nav = document.querySelector<HTMLElement>('[data-nav]');
  nav?.style.setProperty('--nav-solid', String(onLanding() ? docked : 1));
  const links = nav?.querySelector<HTMLElement>('nav');
  if (links) links.style.pointerEvents = !onLanding() || docked > 0.5 ? '' : 'none';
  // and the hero's centered links give way as the bar takes over
  const hero = document.querySelector<HTMLElement>('.hero-text');
  if (hero) hero.style.opacity = String(1 - smooth(Math.min(1, docked * 1.6)));
  const cue = document.querySelector<HTMLElement>('.scroll-cue');
  if (cue) cue.style.opacity = String(1 - Math.min(1, docked * 2));
  const title = document.querySelector<HTMLElement>('[data-nav-title]');
  if (title) title.style.opacity = String(smooth(Math.min(1, Math.max(0, (docked - 0.55) / 0.45))));
}

function frame(now: number) {
  raf = 0;
  const dt = lastFrame ? Math.min(100, now - lastFrame) : 16;
  lastFrame = now;
  if (scrollY > DOCK_AT) dockGoal = 1;
  else if (scrollY < UNDOCK_AT) dockGoal = 0;
  const step = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : dt / DOCK_MS;
  dockT = dockGoal > dockT ? Math.min(dockGoal, dockT + step) : Math.max(dockGoal, dockT - step);
  const { pose, docked } = targetPose();
  if (flight) {
    const t = Math.min(1, (now - flight.start) / FLIGHT_MS);
    shown = mix(flight.from, pose, easeInOut(t));
    if (t >= 1) flight = null;
  } else {
    shown = pose;
  }
  // on the landing page before the scene is up, wait for it rather than
  // showing in the corner and jumping
  const waiting = onLanding() && !brandTarget.scene && brandTarget.pending;
  apply(shown, docked, waiting || (!flight && docked === 0 && onLanding() && !!brandTarget.scene));
  // keep following the scene tile while it can move (camera drift, parallax)
  if (flight || onLanding()) kick();
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
    // arriving on the landing page partway down: start docked
    dockGoal = dockT = scrollY > DOCK_AT || !onLanding() ? 1 : 0;
    if (reduced) dockT = dockGoal;
    lastKey = '';   // the nav is new on every page, so restyle it
    kick();
  });
  addEventListener('scroll', kick, { passive: true });
  addEventListener('resize', kick, { passive: true });
}
