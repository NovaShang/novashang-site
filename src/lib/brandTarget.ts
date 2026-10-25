// Hand-off point between the 3D tile in the galaxy scene and the DOM tile
// that docks into the nav. The galaxy publishes where the tile is on screen
// each frame; brand.ts reads it, and tells the galaxy when the DOM tile has
// taken over so the scene stops drawing its own copy.

export interface ScreenTile {
  x: number;       // centre, viewport px
  y: number;
  size: number;    // edge length, px
  angle: number;   // degrees, CSS rotate() convention
}

export const brandTarget = {
  /** Where the scene's tile is on screen right now, or null if it isn't. */
  scene: null as ScreenTile | null,
  /** True while the DOM tile is showing instead of the scene's. */
  docked: false,
  /** The galaxy is still starting up; the scene will have a tile shortly. */
  pending: false,
};
