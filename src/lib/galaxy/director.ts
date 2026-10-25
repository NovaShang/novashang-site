// Camera choreography for the galaxy: a few named shots, timed moves between
// them, and the small live offsets from mouse, touch, tilt and scroll on top.
//
//   intro    the render first matches the wallpaper exactly, then swings round
//            and lifts a little before settling back, so you see it's 3D
//   explore  a tap flies in close to the core; drag to look around; tap again
//            (or leave it alone) to fly back
//   tour     after a while with no input, a slow drift: face-on, close in, home
//   scroll   leaving the hero tilts the disk toward face-on and pulls back

export interface Pose {
  /** Orbit around the disk normal, radians. */
  azimuth: number;
  /** Camera height above the disk plane, radians. */
  elevation: number;
  /** Distance from the galaxy centre. */
  distance: number;
  /** Screen roll, radians. */
  roll: number;
}

export type Mode = 'home' | 'explore' | 'tour';

export const SHOTS = {
  /** The Mountain Lion wallpaper. */
  home: { azimuth: 0.35, elevation: 0.115, distance: 3.0, roll: -0.52 },
  reveal: { azimuth: 0.78, elevation: 0.36, distance: 2.6, roll: -0.44 },
  face: { azimuth: 1.15, elevation: 1.2, distance: 3.4, roll: -0.25 },
  core: { azimuth: 0.62, elevation: 0.09, distance: 1.75, roll: -0.46 },
} satisfies Record<string, Pose>;

interface Move { to: Pose; dur: number; hold?: number }

const KEYS = ['azimuth', 'elevation', 'distance', 'roll'] as const;
const mix = (a: Pose, b: Pose, t: number): Pose =>
  Object.fromEntries(KEYS.map((k) => [k, a[k] + (b[k] - a[k]) * t])) as unknown as Pose;
// slow-in, slow-out, a little gentler than cubic at the ends
const ease = (t: number) => t * t * t * (t * (6 * t - 15) + 10);

const IDLE_TOUR_S = 28;
const EXPLORE_TIMEOUT_S = 25;

export class Director {
  mode: Mode = 'home';
  private base: Pose = { ...SHOTS.home };
  private queue: Move[] = [];
  private move: { from: Pose; to: Pose; t: number; dur: number; hold: number } | null = null;
  private idle = 0;

  // live offsets, each smoothed toward its target
  private look = { az: 0, el: 0 };          // mouse / gyro parallax
  private lookTarget = { az: 0, el: 0 };
  private orbit = { az: 0, el: 0 };         // touch or mouse drag
  private orbitTarget = { az: 0, el: 0 };
  private dragging = false;
  private scroll = 0;
  private last: Pose = { ...SHOTS.home };

  constructor(private onMode?: (m: Mode) => void) {}

  private setMode(m: Mode) {
    if (m !== this.mode) { this.mode = m; this.onMode?.(m); }
  }

  private play(moves: Move[]) {
    this.queue = moves;
    this.move = null;
  }

  /** Call once the first frame is on screen. */
  intro() {
    this.play([
      { to: SHOTS.home, dur: 0, hold: 1.4 },
      { to: SHOTS.reveal, dur: 5.5, hold: 0.4 },
      { to: SHOTS.home, dur: 5.0 },
    ]);
  }

  tap() {
    this.touch();
    if (this.mode === 'explore') {
      this.orbitTarget = { az: 0, el: 0 };
      this.play([{ to: SHOTS.home, dur: 2.8 }]);
      this.setMode('home');
    } else {
      this.play([{ to: SHOTS.core, dur: 3.0 }]);
      this.setMode('explore');
    }
  }

  /** Mouse position or phone tilt, as -1..1 on each axis. */
  pointer(nx: number, ny: number) {
    this.lookTarget = { az: nx * 0.28, el: -ny * 0.08 };
    // a mouse that just wanders across the page shouldn't cancel the tour
    if (this.mode !== 'tour') this.idle = 0;
  }

  dragStart() { this.dragging = true; this.touch(); }
  dragBy(dx: number, dy: number) {
    // wider freedom up close
    const free = this.mode === 'explore';
    const k = free ? 1 : 0.6;
    this.orbitTarget.az = clamp(this.orbitTarget.az + dx * 0.006 * k, free ? -1.6 : -0.6, free ? 1.6 : 0.6);
    this.orbitTarget.el = clamp(this.orbitTarget.el - dy * 0.004 * k, free ? -0.15 : -0.08, free ? 1.0 : 0.25);
    this.touch();
  }
  dragEnd() { this.dragging = false; }

  /** 0 at the top of the hero, 1 once it has scrolled away. */
  setScroll(s: number) { this.scroll = clamp(s, 0, 1); }

  /** Any deliberate input: cancels the idle tour and resets the timers. */
  touch() {
    this.idle = 0;
    if (this.mode === 'tour') {
      this.play([{ to: SHOTS.home, dur: 3.0 }]);
      this.setMode('home');
    }
  }

  update(dt: number): { view: Pose; speed: number } {
    this.idle += dt;

    // timed moves
    if (!this.move && this.queue.length) {
      const m = this.queue.shift()!;
      this.move = { from: { ...this.base }, to: m.to, t: 0, dur: m.dur, hold: m.hold ?? 0 };
    }
    if (this.move) {
      const m = this.move;
      m.t += dt;
      this.base = m.dur > 0 ? mix(m.from, m.to, ease(Math.min(1, m.t / m.dur))) : { ...m.to };
      if (m.t >= m.dur + m.hold) {
        this.move = null;
        if (!this.queue.length && this.mode === 'tour') this.setMode('home');
      }
    }

    // idle behaviour
    const busy = this.move || this.queue.length;
    if (!busy && this.mode === 'home' && this.idle > IDLE_TOUR_S) {
      this.idle = 0;
      this.setMode('tour');
      this.play([
        { to: SHOTS.face, dur: 9, hold: 4 },
        { to: SHOTS.core, dur: 8, hold: 4 },
        { to: SHOTS.home, dur: 8 },
      ]);
    }
    if (!busy && this.mode === 'explore' && this.idle > EXPLORE_TIMEOUT_S) this.tap();

    // drag offsets spring back at home, stay put while exploring
    if (!this.dragging && this.mode !== 'explore') {
      this.orbitTarget.az *= Math.exp(-dt * 0.8);
      this.orbitTarget.el *= Math.exp(-dt * 0.8);
    }
    const k = 1 - Math.exp(-dt * 2.5);
    this.look.az += (this.lookTarget.az - this.look.az) * k;
    this.look.el += (this.lookTarget.el - this.look.el) * k;
    this.orbit.az += (this.orbitTarget.az - this.orbit.az) * k;
    this.orbit.el += (this.orbitTarget.el - this.orbit.el) * k;

    // parallax is gentler up close, where small angles move a lot on screen
    const lookScale = this.base.distance / SHOTS.home.distance;
    const s = ease(this.scroll);
    const view: Pose = {
      azimuth: this.base.azimuth + this.look.az * lookScale + this.orbit.az,
      elevation: clamp(this.base.elevation + this.look.el * lookScale + this.orbit.el + s * 0.55, 0.03, 1.45),
      distance: this.base.distance + s * 0.8,
      roll: this.base.roll,
    };
    const speed = Math.abs(view.azimuth - this.last.azimuth) + Math.abs(view.elevation - this.last.elevation)
      + Math.abs(view.distance - this.last.distance) * 0.4 + Math.abs(view.roll - this.last.roll);
    this.last = view;
    return { view, speed };
  }

  /** Jump straight to a shot (for screenshots and tuning). */
  jump(p: Pose) { this.queue = []; this.move = null; this.base = { ...p }; }
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
