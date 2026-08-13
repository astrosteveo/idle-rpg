# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Wildmarch — a top-down idle action-RPG vertical slice. Canvas-rendered, zero runtime
dependencies, no asset files. See `README.md` for gameplay, controls and the file tree.

## Commands

```bash
npm run dev        # Vite dev server (port 5173, or the next free port; host exposed for LAN/mobile)
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production bundle to dist/
npm run preview    # serve dist/
```

## Verifying changes

There is no test framework. This is a game: correctness lives in motion, so changes are
verified by **driving the running game in a real browser**. Playwright is installed
globally (not a project dependency), so scripts must import it by absolute path and via
the default export — it is CommonJS:

```js
import pw from '/home/astrosteveo/.nvm/versions/node/v26.7.0/lib/node_modules/playwright/index.js'
const { chromium } = pw
```

(That path is nvm-versioned — re-derive it with `npm root -g` after a Node upgrade.
`NODE_PATH` does not work here, since it is ignored for ES modules.)

`window.__game` (the `Game` instance) and `window.__renderer` are exposed for exactly this
purpose. A useful probe reads state after simulating, rather than asserting on pixels:

```js
await page.keyboard.press('Space')          // auto-battle on
await page.waitForTimeout(14000)
await page.evaluate(() => ({
  kills: window.__game.counters.kills,
  chasing: window.__game.enemies.filter(e => e.state === 'chase').length,
}))
```

Always collect `pageerror` and `console` errors, and screenshot the result — several bugs
found in this codebase (upside-down tents, a gold blob over an enemy, terrain
checkerboarding) were only visible in an image, not in state. Put scratch scripts and
screenshots in the session scratchpad, not the repo.

## Load-bearing invariants

These are the things that break subtly if changed without understanding why they are the
way they are.

**Frame order in `main.ts`** is `input → game.update → renderer.updateCamera →
game.setView → render`. Simulating before moving the camera is required: a camera chasing
a frame-stale player position makes the camera-to-player offset depend on frame timing,
which pixel snapping turns into visible jitter.

**The camera is hard-locked to the player and must stay that way.** The world renders into
a low-resolution buffer that is snapped to the pixel grid. Any easing leaves a sub-pixel
camera/player gap that changes every frame, rounds one way and then the other, and makes
the player visibly slide against the ground (measured: a 15px wander with direction
reversals). For the same reason, `Renderer.resize` forces the buffer to **even**
dimensions — an odd width puts the view origin on a half pixel and `Math.round` flips by
parity.

**De-aggro spans three files.** `Renderer` computes the view rect, `main.ts` feeds it to
`game.setView`, and `Game.shouldGiveUp` uses it: a beast abandons its chase when it leaves
the visible screen, exceeds its leash from its spawn anchor, falls more than 2.6
aggro-ranges behind, or the player enters a camp. This is the rule that makes the map
traversable without monster trains — verify it still holds after touching AI, camera, or
the loop order.

**Spawn nodes own enemy lifecycle.** Every enemy belongs to a `SpawnNode` and carries its
`nodeId`. `Game.killEnemy` must remove the id from `node.alive` and set `node.respawnAt`,
or that node silently stops repopulating.

**Terrain is sampled at two resolutions from one function.** `World.sampleTile(wx, wy)` is
the source of truth. Gameplay and collision go through `tileAt(tx, ty)` on the 32px grid
(cached, `isSolidTile` — only water blocks). The renderer calls `sampleTile` directly every
8px so biome edges follow the noise instead of the tile grid. Changing terrain rules
affects both paths, and `sampleTile` runs thousands of times per chunk bake, so keep it
cheap.

**Slanted edges are rasterised one edge at a time.** Every shape in `render/pixel.ts`
that has a diagonal side (`px`, `span`, `wedge`, `spike`, `cone`, `line`, `sweep`) rounds
each edge as its own linear ramp and divides last. Both rules are load-bearing: rounding a
position and a size separately makes the far edge inherit the near edge's error, centring
a rounded width couples the two sides so the slant stutters with the width's parity, and
`d * (i / n)` puts a half-step on the wrong side of a tie and drops one stair out of an
otherwise even run. A taper's tip clamps to one pixel, so a shape narrower than about a
pixel per row grows a stem rather than a point.

**Never scale a sprite with `ctx.scale`.** `fillRect` on a fractional edge anti-aliases,
the `outline` pass then traces the blur, and the result is soft — the elites were built
this way and lost every hard edge. Elite beasts scale their `BeastSpec` numbers
(`scaleSpec`) and redraw at the larger size instead. Whole pixels for anything that
becomes a rect edge or offset; radii may stay fractional.

## Architecture notes

**All art is generated at boot**, in `render/sprites.ts` on top of `render/pixel.ts`.
Bodies are parametric — a wolf and a bear come out of the same `drawBeastSide` /
`drawBeastFacing` / `drawBeastDiag` routines with different `BeastSpec` numbers; elites are
the same body at a larger scale with a swapped palette. Each finished frame gets a
silhouette-outline pass, which is what makes procedural shapes read as deliberate sprites.
Note `PixelCanvas.spike` tapers **downward** (wide at top) and `cone` tapers **upward**
(point at top) — picking the wrong one silently produces upside-down trees, ears, flames
and tents.

**Sheets are 8 rows, one per facing octant**, indexed by `facingToDir` in `core/math.ts`:
`0 S, 1 W, 2 E, 3 N, 4 SE, 5 SW, 6 NE, 7 NW`. Only the five right-facing poses are
authored; `MIRRORED_ROWS` flips them for W/SW/NW. Cardinals keep rows 0..3 because the
corpse bake pulls the side view from row 2 by index. The three-quarter poses exaggerate
their tilt on purpose — the head-on views squash the whole body into about two pixels of
depth, so an honest projection of a diagonal is indistinguishable from a short side view.

**In-world text uses the 5x7 bitmap font in `render/font.ts`, never `fillText`.** Canvas
text would be antialiased into the low-res buffer and then magnified into mush.

**Game/UI boundary.** The simulation never touches the DOM; the renderer only draws canvas.
`Game.hooks` (`log`, `banner`, `dirty`) is the one channel out, wired up by `UI`. Panels
rebuild only when `dirty()` fires or a panel opens — cheap widgets (bars, cooldowns,
minimap) update every frame. Anything that changes inventory, quests or counters must call
`hooks.dirty()` or the open panel goes stale.

**HUD stacking.** `#stickzone` is a large invisible pointer catcher over the lower-left of
the screen. Any interactive control overlapping it needs an explicit higher `z-index`, or
it silently stops receiving taps.

**Units.** World pixels and art pixels are the same unit; `TILE` is 32. Sprites anchor at
the feet (`Sheet.anchorY`), and the scene is y-sorted by ground position so props and
entities interleave correctly.

## Tuning

Balance changes almost never need simulation code. `src/game/content.ts` holds enemy
statlines, drop rates, the XP curve, stat derivation, ability numbers, item bases and
affixes, the quest chain and the milestone table. Region placement, level bands, pack sizes
and node counts are the `REGIONS` array in `src/game/world.ts`.

## TypeScript config

`strict` plus `noUnusedLocals`/`noUnusedParameters` — an unused import fails the build, so
`npm run typecheck` before considering work done. `verbatimModuleSyntax` is on: type-only
imports must use `import type`.
