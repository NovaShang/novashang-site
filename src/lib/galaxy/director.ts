// Camera choreography for the galaxy background. It isn't something you play
// with; the camera simply follows the page:
//
//   home     starts on the Mountain Lion wallpaper's framing (with a one-time
//            reveal), then drifts along a path toward face-on as you scroll
//   pages    each section has its own shot; navigating flies between them
//
// Mouse position and phone tilt add a little parallax on top.

export interface Pose {
  /** Orbit around the disk normal, radians. */
  azimuth: number;
  /** Camera height above the disk plane, radians (kept below π/2). */
  elevation: number;
  /** Distance from the galaxy centre. */
  distance: number;
  /** Screen roll, radians. */
  roll: number;
  /** Where the galaxy centre sits on screen, in NDC. */
  cx: number;
  cy: number;
}

export type Shot = 'home' | 'posts' | 'projects' | 'post';

type Frame = Omit<Pose, 'cx' | 'cy'> & { wide: [number, number]; tall: [number, number] };

const pose = (f: Frame, aspect: number): Pose => {
  const [cx, cy] = aspect > 1.2 ? f.wide : f.tall;
  return { azimuth: f.azimuth, elevation: f.elevation, distance: f.distance, roll: f.roll, cx, cy };
};

/** The Mountain Lion wallpaper. */
const HOME: Frame = { azimuth: 0.35, elevation: 0.115, distance: 3.0, roll: -0.52, wide: [0.32, 0.02], tall: [0.3, -0.42] };
/** Where the one-time reveal swings to before settling back on HOME. */
const REVEAL: Frame = { azimuth: 0.78, elevation: 0.36, distance: 2.6, roll: -0.44, wide: [0.3, 0.02], tall: [0.3, -0.4] };

/** Scrolling the landing page walks the camera along these, top to bottom. */
const HOME_PATH: Frame[] = [
  HOME,
  { azimuth: 0.9, elevation: 0.42, distance: 3.25, roll: -0.42, wide: [0.36, 0.05], tall: [0.3, -0.1] },
  { azimuth: 1.55, elevation: 0.95, distance: 3.7, roll: -0.25, wide: [0.42, 0.05], tall: [0.25, 0.1] },
  { azimuth: 2.15, elevation: 1.42, distance: 4.2, roll: -0.1, wide: [0.45, 0.0], tall: [0.2, 0.15] },
];

const PAGES: Record<Exclude<Shot, 'home'>, Frame> = {
  /** looking straight down on the disk */
  posts: { azimuth: 0.6, elevation: 1.5, distance: 4.3, roll: 0.35, wide: [0.5, 0.05], tall: [0.25, -0.35] },
  /** edge-on from the far side: a thin bright line across the page */
  projects: { azimuth: 2.9, elevation: 0.035, distance: 3.7, roll: -0.14, wide: [0.1, -0.25], tall: [0.0, -0.5] },
  /** far away and small, so long reading stays calm */
  post: { azimuth: 4.0, elevation: 0.62, distance: 6.2, roll: -0.3, wide: [0.62, 0.42], tall: [0.35, 0.6] },
};

const KEYS = ['azimuth', 'elevation', 'distance', 'roll', 'cx', 'cy'] as const;
const mix = (a: Pose, b: Pose, t: number): Pose =>
  Object.fromEntries(KEYS.map((k) => [k, a[k] + (b[k] - a[k]) * t])) as unknown as Pose;
// slow-in, slow-out
const ease = (t: number) => t * t * t * (t * (6 * t - 15) + 10);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Catmull-Rom through the path, so the camera never visibly turns a corner. */
function along(path: Pose[], s: number): Pose {
  const n = path.length - 1;
  const x = clamp(s, 0, 1) * n;
  const i = Math.min(n - 1, Math.floor(x));
  const t = x - i;
  const p0 = path[Math.max(0, i - 1)], p1 = path[i], p2 = path[i + 1], p3 = path[Math.min(n, i + 2)];
  const out = {} as Pose;
  for (const k of KEYS) {
    const a = p0[k], b = p1[k], c = p2[k], d = p3[k];
    out[k] = 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
  }
  return out;
}

const FLIGHT_S = 2.8;

export class Director {
  private shot: Shot = 'home';
  private aspect = 16 / 9;
  private scrollTarget = 0;
  private scroll = 0;
  private flight: { from: Pose; t: number } | null = null;
  private introT = -1;
  private look = { az: 0, el: 0 };
  private lookTarget = { az: 0, el: 0 };
  private last: Pose | null = null;

  setAspect(a: number) { this.aspect = a; }

  /** Switch to a page's shot; flies there from wherever the camera is now. */
  setShot(shot: Shot, fly = true) {
    if (shot === this.shot) return;
    this.shot = shot;
    this.scroll = this.scrollTarget;
    this.flight = fly && this.last ? { from: this.last, t: 0 } : null;
    if (shot !== 'home') this.introT = -1;
  }

  /** The reveal: the render matches the wallpaper, then shows it's 3D. */
  intro() { if (this.shot === 'home') this.introT = 0; }

  /** Page scroll progress, 0 at the top and 1 at the bottom. */
  setScroll(s: number) { this.scrollTarget = clamp(s, 0, 1); }

  /** Mouse position or phone tilt, -1..1 on each axis. */
  pointer(nx: number, ny: number) { this.lookTarget = { az: nx * 0.22, el: -ny * 0.06 }; }

  private target(): Pose {
    const a = this.aspect;
    if (this.shot === 'home') return along(HOME_PATH.map((f) => pose(f, a)), this.scroll);
    const base = pose(PAGES[this.shot], a);
    // other pages turn just a little as you read down them
    return { ...base, azimuth: base.azimuth + this.scroll * 0.35 };
  }

  update(dt: number): { view: Pose; speed: number } {
    // follow the scroll with a little lag so wheel steps don't show
    this.scroll += (this.scrollTarget - this.scroll) * (1 - Math.exp(-dt * 3));

    let p = this.target();

    if (this.introT >= 0) {
      this.introT += dt;
      const t = this.introT;
      const w = t < 1.4 ? 0 : t < 6.9 ? ease((t - 1.4) / 5.5) : t < 7.3 ? 1 : t < 12.3 ? 1 - ease((t - 7.3) / 5) : 0;
      p = mix(p, pose(REVEAL, this.aspect), w * (1 - this.scroll));
      if (t >= 12.3) this.introT = -1;
    }

    if (this.flight) {
      this.flight.t += dt;
      const k = Math.min(1, this.flight.t / FLIGHT_S);
      p = mix(this.flight.from, p, ease(k));
      if (k >= 1) this.flight = null;
    }

    const k = 1 - Math.exp(-dt * 2.5);
    this.look.az += (this.lookTarget.az - this.look.az) * k;
    this.look.el += (this.lookTarget.el - this.look.el) * k;
    // parallax is gentler up close, where small angles move a lot on screen
    const s = p.distance / HOME.distance;
    const view: Pose = {
      ...p,
      azimuth: p.azimuth + this.look.az / s,
      elevation: clamp(p.elevation + this.look.el / s, 0.02, 1.5),
    };

    const l = this.last ?? view;
    const speed = Math.abs(view.azimuth - l.azimuth) + Math.abs(view.elevation - l.elevation)
      + Math.abs(view.distance - l.distance) * 0.3 + Math.abs(view.roll - l.roll)
      + Math.abs(view.cx - l.cx) + Math.abs(view.cy - l.cy);
    this.last = view;
    return { view, speed };
  }

  isHome() { return this.shot === 'home'; }

  /** Jump straight to a page's shot without flying (for screenshots). */
  jump(shot: Shot) { this.shot = shot; this.flight = null; this.introT = -1; this.last = null; }
}
