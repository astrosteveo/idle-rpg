# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Wildmarch — a top-down idle action-RPG vertical slice. Canvas-rendered, zero runtime
dependencies, no asset files: every sprite and tile is generated in code at boot. One
class (Warrior), six regions, five species, local saves only.

## Commands

```bash
npm run dev        # Vite dev server on :5173, host exposed for LAN/mobile
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production bundle to dist/
npm run preview    # serve dist/
```

`strict` plus `noUnusedLocals`/`noUnusedParameters` — an unused import fails the build, so
run `npm run typecheck` before considering work done. `verbatimModuleSyntax` is on: type-only
imports must use `import type`.

## Verifying changes

There is no test framework. This is a game: correctness lives in motion, so changes are
verified by **driving the running game in a real browser**. `window.__game` (the `Game`
instance) and `window.__renderer` are exposed for exactly this.

If a browser-automation MCP server is connected, use it. Otherwise Playwright is installed
globally (not a project dependency), so scripts must import it by absolute path and via the
default export — it is CommonJS:

```js
import pw from '/home/astrosteveo/.nvm/versions/node/v26.7.0/lib/node_modules/playwright/index.js'
const { chromium } = pw
```

(That path is nvm-versioned — re-derive it with `npm root -g` after a Node upgrade.
`NODE_PATH` does not work here, since it is ignored for ES modules.)

A useful probe reads state after simulating, rather than asserting on pixels:

```js
await page.keyboard.press('Space')          // auto-battle on
await page.waitForTimeout(14000)
await page.evaluate(() => ({
  kills: window.__game.counters.kills,
  chasing: window.__game.enemies.filter(e => e.state === 'chase').length,
}))
```

Always collect `pageerror` and console errors, **and screenshot the result** — several bugs
here (upside-down tents, a gold blob over an enemy, terrain checkerboarding) were only
visible in an image, never in state. Put scratch scripts and screenshots in the session
scratchpad, not the repo.

Three things about probes, now that the game persists:

- **Clear storage first** (`localStorage.clear()` then reload), or a "fresh" run silently
  inherits a levelled character.
- `pagehide` writes a save on the way out, so a save backdated from inside the page is
  clobbered by the very reload meant to read it. Backdate with `page.addInitScript(...)`,
  which runs before the app boots.
- **Quiesce before comparing state across a reload**: auto-battle is persisted and resumes
  instantly. Turn auto off and stand in a camp — camps make every beast give up the chase.

## Load-bearing invariants

These break subtly if changed without understanding why they are the way they are.

**Frame order in `main.ts`** is `input → game.update → renderer.updateCamera → game.setView
→ render`. Simulating before moving the camera is required: a camera chasing a frame-stale
player position makes the camera-to-player offset depend on frame timing, which pixel
snapping turns into visible jitter.

**The pixel pipeline has three separate snaps, and each one is load-bearing.** The world is
drawn into a low-resolution buffer at a whole-art-pixel origin (crisp art, no player-vs-ground
slide); the buffer blits at an **integer** art-to-device scale (a fractional scale makes
neighbouring art pixels cover different numbers of device pixels, and detail crawls as the
world scrolls); and the fraction the origin snap discarded is re-applied to the blit
position at device resolution, so slow movement scrolls smoothly instead of stalling and
jumping. `Renderer.resize` therefore uses the *true* `devicePixelRatio`, neither floored nor
capped, sizes the backing store to exactly `cssPx x dpr`, and gives the buffer two art
pixels of bleed so the blit offset never drags an uncovered edge into view. Buffer
dimensions are forced **even** — an odd width puts the view origin on a half pixel and
`Math.round` flips by parity. `main.ts` snaps `dt` to a whole number of display frame
periods for the same reason: a small `dt` error flips the rounding and scrolls a pixel too
far.

**The camera is hard-locked to the player and must stay that way.** Any easing leaves a
sub-pixel camera/player gap that changes every frame and rounds one way and then the other,
making the player visibly slide against the ground (measured: a 15px wander with direction
reversals).

**De-aggro spans three files.** `Renderer` computes the view rect, `main.ts` feeds it to
`game.setView`, and `Game.shouldGiveUp` uses it: a beast abandons its chase when it leaves
the visible screen, exceeds its leash from its spawn anchor, falls more than 2.6 aggro-ranges
behind, or the player enters a camp. This is what makes the map traversable without monster
trains — verify it still holds after touching AI, camera, or loop order. `isEngaged` in
`types.ts` lists the states the rule governs; a new state missing from it is a beast that can
follow you across the map.

**A kill has two halves, split on purpose.** `Game.killEnemy` is the *world* half — corpse,
effect, and returning the enemy's slot to its `SpawnNode` (every enemy carries a `nodeId`;
failing to remove it from `node.alive` and set `node.respawnAt` silently stops that node
repopulating). `Game.creditKill` is the *player* half — counters, quest progress, scaled
xp/gold/drops. Kill credit is universal: everyone who damages a beast earns the full amount,
so the world half must run once per death while the player half runs once per contributor.

**Per-player state must never live in module scope.** Two bugs of exactly this shape have
been fixed already: camp discovery mutated the exported `CAMPS` array, and `loot.ts` kept
`nextUid` as a module counter that restarted at 1 on load and collided with restored gear.
The project is headed toward a shared world, so anything per-character belongs on `Game` and
in the save; `CAMPS` / `REGIONS` stay immutable placement data.

**Everything per-species is a record keyed by `EnemyKind`, never a field per animal.**
`ENEMY_KINDS` in `types.ts` is the single list; `Counters.species`, `Mods.vs` / `Mods.from`,
`OFFLINE.cleave` and the milestone `Metric` (`slain:${EnemyKind}`) all derive from it, so
adding a species is a table entry and the build tells you every place that still assumed
otherwise. `NO_MODS` freezes its two records and `baseMods()` copies them — a shallow spread
would hand every character the module-scope one.

**A species is a behaviour, not a statline.** `EnemyType.behaviour` picks `stalk`, `charge`,
`web` or `flock`, implemented in `Game.stepEnemy` with numbers in `BEHAVIOUR`. Each has a
rule that keeps it fair: a charge commits to a heading and stops steering (homing would make
it an attack with extra steps), webbing refreshes rather than accumulates (stacking duration
is a stun), and a flock's scatter has a per-bird cooldown and ignores burn ticks (without
either, a flock can be kited forever or herded by burning ground).

**One `Mods` bag, one fold, one stacking rule per field.** Talents, worn relics and beast
mastery each return a `ModsPatch`, and `buildMods` folds them in a fixed order — used by both
`Game.computeMods` and `offline.ts`, so the live game and the ledger can never disagree about
a character's rules. `COMBINE` in `content.ts` is a `Record<keyof Mods, ...>`: a new modifier
field that forgets to declare whether it multiplies, adds, ORs or folds per-species fails the
build rather than defaulting to something wrong. `mods.leashMult` is clamped to ≤1 in
`shouldGiveUp` — content may end a chase *sooner*, never stretch one.

**A relic is outside auto-equip in both directions.** `itemScore` collapses gear to one
number, and the whole value of a unique is a rule that number cannot see — so `Game.addItem`
routes anything with `Item.unique` to `stowUnique`, never auto-equips it, and never
auto-replaces a worn unique. Uniques are unsellable (`value: 0`, guarded in `sellFromBag`)
because there is one of each and `foundUniques` stops it dropping again — the bag-overflow
auto-sell would otherwise destroy content permanently. A full bag makes room for a relic by
selling its worst *ordinary* item.

**World bosses are on a clock, not a respawn timer.** `bossWindow(now)` is a pure function of
wall time, so every client agrees about when an apex walks — that is the entire reason they
exist in a shared world. `Game.bossCleared` records which window *this* character has taken
and is saved, standing in for shared state a server will own. Bosses carry `nodeId: -1`, and
`Game.nearestEnemy`'s `skipBosses` keeps auto-battle from seeking one.

**Mastery is a view, not a record.** `masteryTier` reads `Counters.species` directly, so the
bestiary can never disagree with the kill totals the HUD shows. The price is that `recalc`
must run when a tier threshold is crossed — `creditKill` samples the tier before and after
incrementing, and `applyOfflineReport` recalcs once at the end.

**Spawn nodes place their elites first.** They demand the most clearance, and placing them
last meant a crowded region filled up on ordinary dens and fit no elite at all — Wolfden
Thicket once shipped with zero alpha wolves and therefore no relics, while the offline ledger
went on paying for both.

**Two reward curves, doing different jobs.** `rewardScale` governs gold, drop chance and drop
item level, flooring at 15% below you and 4% above. `xpScale` governs experience alone and
reaches exactly zero eight levels down, so a region can be *outgrown*. Using `rewardScale`
for xp re-enables infinite grinding in the starter zone; using `xpScale` for loot kills drops
entirely. Neither touches kills, quests, counters or milestones — acknowledgment is
unconditional, only the payout scales.

**The save migrates forward, it does not get discarded.** `save.ts` is at v5 and `readSave`
does the structural check and every migration in one pass. A save from a *different seed* is
still thrown away (every camp and den would be elsewhere), but an older schema version is
filled in with defaults. Keep additions additive and this stays a two-line change per version.

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
(cached, `isSolidTile` — only water blocks); the renderer calls `sampleTile` directly every
8px so biome edges follow the noise instead of the tile grid. Changing terrain rules affects
both paths, and `sampleTile` runs thousands of times per chunk bake, so keep it cheap.

**Slanted edges are rasterised one edge at a time.** Every shape in `render/pixel.ts` with a
diagonal side (`px`, `span`, `wedge`, `spike`, `cone`, `line`, `sweep`) rounds each edge as
its own linear ramp and divides last. Rounding a position and a size separately makes the far
edge inherit the near edge's error; centring a rounded width couples the two sides so the
slant stutters with the width's parity; `d * (i / n)` puts a half-step on the wrong side of a
tie and drops one stair out of an otherwise even run.

**Never scale a sprite with `ctx.scale`.** `fillRect` on a fractional edge anti-aliases, the
`outline` pass then traces the blur, and the result is soft. Elites scale their `BeastSpec`
numbers (`scaleSpec`) and redraw at the larger size instead. Whole pixels for anything that
becomes a rect edge or offset; radii may stay fractional.

## Architecture notes

```
src/
  main.ts        frame loop; exposes __game / __renderer
  core/          math.ts (vectors, seeded RNG, value noise/fbm), input.ts (keys + virtual stick)
  game/          types.ts, content.ts (ALL TUNING), world.ts, state.ts (the simulation),
                 loot.ts, save.ts (schema only), offline.ts (pure ledger)
  render/        pixel.ts, sprites.ts, terrain.ts, font.ts, renderer.ts
  ui/            ui.ts (HUD overlay), storage.ts (the only file that knows localStorage exists)
```

**All art is generated at boot**, in `render/sprites.ts` on top of `render/pixel.ts`. Bodies
are parametric — a wolf, a bear and a boar come out of the same `drawBeastSide` /
`drawBeastFacing` / `drawBeastDiag` routines with different `BeastSpec` numbers; elites and
bosses are the same body at a larger scale with a swapped palette, listed in `BEAST_SHEETS`.
`BeastSpec.body` picks which trio a sheet uses: a spider and a rook are *not* quadrupeds.
Each finished frame gets a silhouette-outline pass, which is what makes procedural shapes
read as deliberate sprites. Note `PixelCanvas.spike` tapers **downward** (wide at top) and
`cone` tapers **upward** — picking the wrong one silently produces upside-down trees, ears,
flames and tents.

**Which sheet a beast wears lives on the beast** (`Enemy.sheet`), not on a lookup from its
species — an apex is neither the ordinary body nor the elite one. Collision radius and reach
derive from that sheet's scale via `beastSheetScale`, so art and hitbox cannot drift apart.

**Sheets are 8 rows, one per facing octant**, indexed by `facingToDir` in `core/math.ts`:
`0 S, 1 W, 2 E, 3 N, 4 SE, 5 SW, 6 NE, 7 NW`. Only the five right-facing poses are authored;
`MIRRORED_ROWS` flips them for W/SW/NW. Cardinals keep rows 0..3 because the corpse bake
pulls the side view from row 2 by index. Three-quarter poses exaggerate their tilt on
purpose — head-on views squash the body into about two pixels of depth.

**In-world text uses the 5x7 bitmap font in `render/font.ts`, never `fillText`.** Canvas text
would be antialiased into the low-res buffer and then magnified into mush.

**Game/UI boundary.** The simulation never touches the DOM; the renderer only draws canvas.
`Game.hooks` (`log`, `banner`, `dirty`) is the one channel out, wired up by `UI`. Panels
rebuild only when `dirty()` fires or a panel opens — cheap widgets (bars, cooldowns, minimap)
update every frame. Anything that changes inventory, quests or counters must call
`hooks.dirty()` or the open panel goes stale.

**Persistence is layered so the simulation stays portable.** `game/save.ts` is the schema and
version constant, `game/offline.ts` is a pure `(save, elapsed, rng) → OfflineReport`, and
`ui/storage.ts` is the only file that knows localStorage exists. `Game` produces and consumes
a plain object and never touches storage, because the same schema is meant to be what a
server persists per account. `killsPerHour` is exported from `offline.ts` and used by both the
ledger and the Hunt tab, so the rate a player is shown before choosing a ground is the rate
the ledger actually pays.

**HUD stacking.** `#stickzone` is a large invisible pointer catcher over the lower-left of the
screen. Any interactive control overlapping it needs an explicit higher `z-index` or it
silently stops receiving taps. The return report sits at `z-index: 45`.

**Units.** World pixels and art pixels are the same unit; `TILE` is 32. Sprites anchor at the
feet (`Sheet.anchorY`), and the scene is y-sorted by ground position so props and entities
interleave correctly.

## Tuning

Balance changes almost never need simulation code. `src/game/content.ts` holds enemy
statlines, drop rates, the XP curve, stat derivation, ability numbers, item bases and affixes,
the quest chain, the milestone table, both reward curves, the offline model (`OFFLINE`),
`TALENT_ROWS`, `RESPEC_COST_PER_LEVEL`, `UNIQUES`, `EMBER`, `MASTERY_TIERS`, `BEHAVIOUR`,
`BOSSES` / `BOSS`, and the `Mods` / `COMBINE` tables everything above feeds. Region placement,
level bands, pack sizes and node counts are the `REGIONS` array in `src/game/world.ts`,
alongside `CAMPS`, `ROAD_LINKS` and `LANDMARKS`.

A new talent or relic is normally a table entry plus at most one field on `Mods` and its
`COMBINE` rule — the simulation reads `this.mods`, never the tables. A new species is an entry
in `ENEMY_KINDS`, a statline in `ENEMIES`, a sheet in `BEAST_SHEETS` and a region to live in;
the build lists everything else that needs it.

**Known balance gap.** Offline accrual at `OFFLINE.efficiency` 0.72 is nearly as fast as
playing, so a night away can carry a character to the top of the level range in one sitting.
Steepening `xpForLevel` or lowering `OFFLINE.efficiency` are both one-line changes — but which
one is a design decision, not a bug fix.
