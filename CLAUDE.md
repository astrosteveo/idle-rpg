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

Two things about probes now that the game persists. **Clear storage first**, or a "fresh"
run silently inherits a levelled character:

```js
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle' })
```

And `pagehide` writes a save on the way out, so a save backdated from inside the page is
clobbered by the very reload meant to read it. Backdate with `page.addInitScript(...)`
instead, which runs before the app boots.

Quiesce before comparing state across a reload: auto-battle is persisted and resumes
instantly, so a naive before/after snapshot diverges. Turn auto off and stand in a camp —
camps make every beast give up the chase.

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

**A kill has two halves, split on purpose.** `Game.killEnemy` is the *world* half — corpse,
effect, and returning the enemy's slot to its `SpawnNode`. Every enemy carries a `nodeId`,
and failing to remove it from `node.alive` and set `node.respawnAt` silently stops that node
repopulating. `Game.creditKill` is the *player* half — counters, quest progress, scaled
xp/gold/drops. They are separate because kill credit is universal: everyone who damages a
beast earns the full amount, never a split, so the world half must run once per death while
the player half runs once per contributor. Merging them back breaks that.

**Per-player state must never live in module scope.** Two bugs of exactly this shape have
already been fixed: camp discovery mutated the exported `CAMPS` array, and `loot.ts` kept
`nextUid` as a module counter that restarted at 1 on load and collided with restored gear.
The project is headed toward a shared world where one player's progress must not be
everyone's — so anything per-character belongs on `Game` and in the save, and `CAMPS` /
`REGIONS` stay immutable placement data.

**Two reward curves, doing different jobs.** `rewardScale` governs gold, drop chance and
drop item level; it floors at 15% below you and 4% above, so a trivial beast is still worth
looting and a tapped high-level beast is not worth farming. `xpScale` governs experience
alone and reaches exactly zero eight levels down, so a region can be *outgrown*. Using
`rewardScale` for xp re-enables infinite grinding in the starter zone; using `xpScale` for
loot kills drops entirely. Neither ever touches kills, quests, counters or milestones —
acknowledgment is unconditional, only the payout scales.

**The save deliberately omits the world.** Terrain, props and spawn placement are pure
functions of the seed, and the `Game` constructor fills every node on boot — so `hydrate`
runs on top of an already-populated world and restores only the character. It also reseeds
`this.rand`: the loot stream is fixed-seed with no recoverable position, so without that
every session rolls the same drops from the top.

**The offline ledger runs in buckets.** Rewards depend on level, so `offline.ts` steps in
ten-minute slices and recomputes stats between them. Collapse it to a single pass and a
character away overnight earns at its starting level all night.

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

**Persistence is layered so the simulation stays portable.** `game/save.ts` is the schema
and version constant, `game/offline.ts` is the ledger — a pure
`(save, elapsed, rng) → OfflineReport` — and `ui/storage.ts` is the only file that knows
localStorage exists. `Game` produces and consumes a plain object and never touches storage,
because the same schema is meant to be what a server persists per account. `killsPerHour`
is exported from `offline.ts` and used by both the ledger and the Hunt tab, so the rate a
player is shown before choosing a ground is the rate the ledger actually pays.

**HUD stacking.** `#stickzone` is a large invisible pointer catcher over the lower-left of
the screen. Any interactive control overlapping it needs an explicit higher `z-index`, or
it silently stops receiving taps. The return report sits at `z-index: 45`, above both the
panel and the death overlay.

**Units.** World pixels and art pixels are the same unit; `TILE` is 32. Sprites anchor at
the feet (`Sheet.anchorY`), and the scene is y-sorted by ground position so props and
entities interleave correctly.

## Tuning

Balance changes almost never need simulation code. `src/game/content.ts` holds enemy
statlines, drop rates, the XP curve, stat derivation, ability numbers, item bases and
affixes, the quest chain, the milestone table, both reward curves (`rewardScale`,
`xpScale` / `XP_FALLOFF`) and the offline model (`OFFLINE`). Region placement, level bands,
pack sizes and node counts are the `REGIONS` array in `src/game/world.ts`.

One known gap, documented at the end of the README: offline accrual at `OFFLINE.efficiency`
0.72 is nearly as fast as playing, so a single night away can carry a character past level
16 — the point where every region is outgrown and no ground grants xp at all. The xp cutoff
is tuned correctly for levels 1–15; it is the accrual rate that overshoots. Which knob to
turn is a design decision, not a bug fix.

## TypeScript config

`strict` plus `noUnusedLocals`/`noUnusedParameters` — an unused import fails the build, so
`npm run typecheck` before considering work done. `verbatimModuleSyntax` is on: type-only
imports must use `import type`.
