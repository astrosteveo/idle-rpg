# CLAUDE.md

This file gives Claude Code (claude.ai/code) guidance for working in this repository.

The docs here follow the [Microsoft Writing Style Guide](https://learn.microsoft.com/style-guide/welcome/).
Write new text the same way: talk to the reader as *you*, use active voice and contractions,
lead with what matters, and keep sentences short enough to scan.

Wildmarch is a vertical slice of a top-down idle action RPG. It draws to a canvas, and its
art comes from generated PNG atlases in `public/assets/generated`. There's one class
(Warrior), six regions, and five species. Saves stay on the player's machine.

## Commands

```bash
npm run dev           # Vite dev server on port 5173, open to the LAN and to mobile
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm test              # vitest unit tests
npm run test:browser  # playwright smoke tests
npm run build         # typecheck, then a production bundle in dist/
npm run preview       # serve dist/
npm run verify        # all of the above, in order
npm run atlas:measure # remeasure the atlases and rewrite src/assets/frames.ts
npm run atlas:characters <spec.json>   # compose a character sheet from 8 strips
```

TypeScript runs with `strict`, `noUnusedLocals`, and `noUnusedParameters`, so an unused
import breaks the build. Run `npm run typecheck` before you report that you're done.

`verbatimModuleSyntax` is on too, so import types with `import type`.

## How to verify a change

Vitest covers the units and Playwright covers the smoke tests, but neither is enough on its
own. This is a game, and you can only see most of its behavior in motion, so check your
change in a real browser with the game running. The simulation, the renderer, and the
command boundary are all on `window.__wildmarch` for exactly this.

Playwright is a dependency of this project. Import it from `node_modules`:

```js
import { chromium } from '<repo>/node_modules/playwright/index.mjs'
```

Write probes that drive the game and then read its state. Don't assert on pixels.

```js
await page.keyboard.press('Space')          // start auto-battle
await page.waitForTimeout(14000)
await page.evaluate(() => {
  const g = window.__wildmarch.snapshot()
  return { kills: g.counters.kills, chasing: g.enemies.filter(e => e.state === 'chase').length }
})
```

Collect `pageerror` and console errors, and take a screenshot. Some defects only show up in
an image — upside-down tents, a gold blob sitting on an enemy, a checkerboard in the
terrain. State readouts missed all three. Probe scripts and their screenshots are throwaway,
so write them outside the repository.

The game saves, so three rules apply:

- **Clear storage first.** Call `localStorage.clear()`, then reload. Otherwise a new
  character starts at the level your last run reached.
- **Set the date with `page.addInitScript(...)`**, which runs before the game starts. The
  `pagehide` event writes a save on close, so a date you set from inside the page is gone
  by the time you reload to read it.
- **Let the game settle before you compare state across a reload.** The auto-battle setting
  persists and restarts immediately. Turn auto-battle off and stand in a camp, because a
  camp makes enemies break off their chase.

## Rules you shouldn't break

Every rule here exists for a reason. Change the code without knowing the reason and the
game breaks in ways that are hard to track down.

### Frame loop order

`main.ts` runs `input` → `game.update` → `renderer.updateCamera` → `game.setView` →
`render`. Simulate before you move the camera. If the camera chases a player position
that's a frame old, the camera-to-player offset shifts with frame time, and the pixel snap
turns that shift into jitter.

### The three snaps in the pixel pipeline

The pipeline snaps three times, and each snap does a different job. Keep all three.

1. The world draws into a low-resolution buffer whose origin sits on a whole art pixel.
   This keeps the art sharp and stops the player sliding along the ground.
2. The buffer blits with an integer scale from art pixels to device pixels. At a fractional
   scale, neighboring art pixels cover different numbers of device pixels, so detail
   crawls as the world scrolls.
3. The fraction that snap 1 removed goes back onto the blit position, at device resolution.
   This is what makes slow movement scroll smoothly instead of stalling and jumping.

`Renderer.resize` has to hold to these:

- Use the true `devicePixelRatio`. Don't floor it and don't cap it.
- Make the backing store exactly `cssPx × dpr`.
- Make the buffer 2 art pixels bigger than the screen needs, so the blit offset can't pull
  an empty edge into view.
- Keep buffer width and height even. An odd width puts the view origin on a half pixel, and
  `Math.round` then flips direction with the parity.

`main.ts` snaps `dt` to a whole number of display frame periods for the same reason. A small
error in `dt` changes how things round and scrolls the world a pixel too far.

### The camera locks to the player

Keep the camera locked. Don't add easing. Easing leaves a sub-pixel gap between camera and
player that changes every frame and rounds first one way, then the other. The player slides
against the ground as a result — a measurement caught 15 px of drift with direction changes.

### A camp discovers once but answers a task every time

`Game.enterCamp` runs on every frame the player stands in a camp. The discovery half runs
once. The `reach` task check runs every time, because a player can wander into a camp before
anyone asks them to. Move that check into the discovery half and the task can never
complete, which stalls the whole chain behind it.

### The HUD shows one banner at a time

Walking into a camp can discover the place, complete a task, and grant a level in the same
frame. `UI.banner` queues each one and shows it for 2.6 seconds. Without the queue you only
see the last banner, which is the least important of the three.

### Three files decide when a chase ends

`Renderer` works out the view rectangle, `main.ts` passes it to `game.setView`, and
`Game.shouldGiveUp` uses it. An enemy gives up when any of these is true:

- It leaves the visible screen.
- It gets further from its spawn anchor than its leash allows.
- It falls more than 2.6 aggro ranges behind the player.
- The player enters a camp.

Together these let a player cross the map without towing a crowd. Recheck the rule whenever
you change enemy AI, the camera, or loop order. `isEngaged` in `types.ts` lists the states
the rule governs — add a state and forget to list it, and that enemy follows the player
across the map.

### A kill has two halves

`Game.killEnemy` is the world half. It spawns the corpse and the effect and returns the
enemy's slot to its `SpawnNode`. Every enemy carries a `nodeId`. Skip removing it from
`node.alive` and setting `node.respawnAt`, and that node quietly stops producing enemies
with no error to tell you.

`Game.creditKill` is the player half. It moves counters and quest progress and pays out
experience, gold, and drops at the right scale.

Kill credit is universal — everyone who damaged an enemy gets full value. So the world half
runs once per death, and the player half runs once per contributor.

### Keep per-player data out of module scope

Two bugs of this kind are already fixed. Camp discovery used to mutate the exported `CAMPS`
array, and `loot.ts` kept `nextUid` as a module-scope counter that restarted at 1 after a
load and handed restored equipment duplicate IDs.

This project is heading toward a shared world, so per-character data belongs on `Game` and
in the save. `CAMPS` and `REGIONS` stay put as placement data that never changes.

### Species data is a record keyed by `EnemyKind`

Don't add a field per animal. `ENEMY_KINDS` in `types.ts` is the single list.
`Counters.species`, `Mods.vs`, `Mods.from`, `OFFLINE.cleave`, and the milestone `Metric`
(`slain:${EnemyKind}`) all derive from it. A new species is one table entry, and the build
points you at every other place that needs updating.

`NO_MODS` freezes its two records and `baseMods()` copies them. A shallow spread hands every
character the module-scope record.

### A species is a behavior, not a stat block

`EnemyType.behaviour` picks `stalk`, `charge`, `web`, or `flock`. `Game.stepEnemy` holds the
code and `BEHAVIOUR` holds the numbers. Each behavior has a rule that keeps it fair:

- A charge holds its heading and stops steering. Let it steer and it's just a
  multi-step attack.
- A web refreshes its duration instead of adding to it, because stacking duration is a stun.
- A flock gives each bird a cooldown before it scatters, and scattering ignores burn ticks.
  Without the cooldown a player can kite the flock forever. Without the second rule they can
  herd it with burning ground.

### One `Mods` bag, one fold, one stacking rule per field

Talents, worn relics, and beast mastery each contribute a `ModsPatch`, and `buildMods` folds
them in a fixed order. `Game.computeMods` and `offline.ts` both call it, so the live game and
the ledger always agree about a character.

`COMBINE` in `content.ts` is a `Record<keyof Mods, ...>`. Every new field on `Mods` has to
declare how it stacks: multiply, add, OR, or fold per species. Miss one and the build fails
rather than picking a wrong default.

`shouldGiveUp` clamps `mods.leashMult` to 1 or less. Content can end a chase sooner. It
can't extend one.

### Auto-equip leaves relics alone, in both directions

`itemScore` reduces gear to a single number, and a unique item's real value is a rule that
number can't see. So `Game.addItem` routes anything with `Item.unique` to `stowUnique`.
Auto-equip never equips a unique and never replaces one the player is wearing.

A unique has `value: 0` and can't be sold, which `sellFromBag` enforces. There's exactly one
of each, and `foundUniques` blocks a second drop — so auto-selling from a full bag would
destroy that content permanently. A full bag makes room for a relic by selling the worst
ordinary item instead.

### World bosses run on a clock, not a respawn timer

`bossWindow(now)` is a pure function of wall time, so every client agrees on when an apex
enemy walks. That agreement is the whole point of the design. `Game.bossCleared` records the
window this character claimed, and the save keeps it — standing in for shared server state
later.

A boss has `nodeId: -1`. The `skipBosses` parameter on `Game.nearestEnemy` keeps auto-battle
from wandering into one.

### Mastery is a view, not a record

`masteryTier` reads `Counters.species` directly, so the bestiary always matches the kill
totals in the HUD. The cost is that `recalc` has to run when kills cross a tier boundary.
`creditKill` samples the tier before and after each increment, and `applyOfflineReport` runs
`recalc` once at the end.

### Spawn nodes place elites first

Elites need the largest clear area. Place them last and a busy region only has room for
ordinary dens. Wolfden Thicket once ended up with zero alpha wolves, so it dropped no
relics — while the offline ledger kept paying for both.

### Two reward curves, two jobs

`rewardScale` drives gold, drop chance, and item level. It bottoms out at 15% for enemies
below the player and 4% for enemies above, so it never reaches zero. `xpScale` drives
experience only, and it hits exactly zero at 8 levels below the player, which is what lets a
player outgrow a region.

Use `rewardScale` for experience and players can farm the first region forever. Use
`xpScale` for loot and drops stop entirely. Neither curve touches kills, quests, counters, or
milestones — a kill always counts, and only the payout scales.

### Auto-battle serves the current task

Two decisions make a hunt follow the task, and `Game.huntPlan` reads the active task and
answers both.

- `pickTarget` uses `want`, the species the task counts. Auto-battle ranges out to
  `AUTO.taskSeek` for that species and only `AUTO.straySeek` for anything else. A character
  that answers every beast at full range drifts off its assigned den one detour at a time.
- `roam` uses `autoGoal`. With a task in hand it walks toward that task's objective rather
  than the nearest den, so a "reach a camp" task completes unaided and the next one starts
  the walk again.

`focused` shortens the leash whenever the task has somewhere to be. A body count (`any`)
takes every beast, so it narrows nothing. A task that's merely on offer counts for neither
decision, because taking it requires a conversation and standing next to the giver would
stall the hunt. An apex counts for neither either — same reason `skipBosses` exists.

The rule is a preference, not a blindfold. Any beast that comes close is still fair game, and
anything in reach still gets the swing.

### Travel walks a route; it doesn't chase

`Game.travel` holds one destination and `Game.travelTo` starts the walk. Auto-battle then
follows the route and chases nothing, though `stepSwing` still answers anything that comes
within reach — so walking through a pack costs the pack blood.

`World.findPath` supplies the route as A* over the 32 px tile grid, because walking straight
gets stuck: `moveEntity` slides along the free axis, and a bay in a lake pins the player
against the shore. The first search keeps a tile of clearance from water, since the collision
box is padded; if that finds nothing, it retries without the clearance.

`Game.stepRoute` advances a `Route` by one step, and both travel and roaming go through it,
so a walk the player asked for and a walk auto-battle chose move identically. It returns
false when the walker hasn't moved for over a second, and the caller replots. Roaming
throttles that with `roamRetry`, because a place with no route costs a whole-map search to
discover.

A journey ends in one of five ways: it arrives, the player grabs the stick, the player stops
auto-battle, the player dies, or the task it serves ends. `Game.endTravel` takes one flag —
whether the journey ended where it was headed. Only that case honors
`TravelTarget.stopHere`, which switches auto-battle off. Use `stopHere` for people and camps,
where the player arrives to read something. Don't use it for a den, where the beasts are the
point.

Finishing a task counts as arriving. A camp is discovered at its full radius, which sits
outside the radius the journey aims for, so the task completes first and ends the journey.
Treat that as a cancellation and auto-battle marches back out of the camp before the player
has read the banner.

`Game.questDestination` turns a task into a destination, and both the tracker and the Tasks
panel call it. Don't work out a destination in the HUD.

### A task from a person waits until the player takes it

`QuestDef.from` holds an ID in `NPCS`. With one, the task sits unstarted until the player
stands next to that person and accepts it. Without one, it starts on its own when the
previous task ends.

`Game.quest` is the only place that decides this. It returns null while a task is merely on
offer, and `Game.offeredQuest` returns the task instead. All three paths that credit progress
— `advanceQuestOnKill`, `discoverCamp`, and `applyOfflineReport` — funnel through that one
getter. Don't add a fourth path that reads `QUESTS[this.questIndex]` directly.

`Game.questTaken` is per-player progress and lives in the save. A version 5 save migrates to
`true`, because nobody handed out tasks in that world.

An NPC stands still in a single pose. `Renderer.drawNpc` draws the figure, the name, and the
gold mark that signals an offer. The mark bobs, because a motionless figure among motionless
props is easy to walk past.

### The save migrates forward

`save.ts` is at version 6. `readSave` does the structural check and every migration in one
pass. A save from a different seed is discarded, because every camp and den would be
somewhere else. An older schema version gets filled in with defaults. Keep additions
additive, and each new version stays a two-line change.

### The save doesn't contain the world

Terrain, props, and spawn positions are pure functions of the seed, and the `Game`
constructor fills every node at startup. So `hydrate` runs against a world that's already
complete and restores only the character.

`hydrate` also reseeds `this.rand`. The loot stream has a fixed seed and no recoverable
position, so without reseeding every session rolls the same drops from the start.

### The offline ledger runs in buckets

Rewards scale with level, so `offline.ts` steps in ten-minute slices and recomputes stats
between them. Make it a single pass and a character who's away all night earns at their
starting level all night.

### One function samples terrain at two resolutions

`World.sampleTile(wx, wy)` is the source of truth. Game logic and collision go through
`tileAt(tx, ty)` on the 32 px grid — that path is cached, and `isSolidTile` blocks water
only. The renderer calls `sampleTile` directly every 8 px, so biome edges follow the noise
rather than the tile grid. Change the terrain rules and both paths change. `sampleTile` runs
thousands of times per chunk bake, so keep it fast.

### Rasterize one slanted edge at a time

Every shape in `render/pixel.ts` with a diagonal side (`px`, `span`, `wedge`, `spike`,
`cone`, `line`, `sweep`) rounds each edge as its own linear ramp and divides last. Three
things go wrong otherwise:

- Round a position and a size separately, and the far edge inherits the near edge's error.
- Center a rounded width, and the two sides couple so the slant stutters with the parity of
  the width.
- Write `d * (i / n)`, and a half step lands on the wrong side of a tie, throwing one stair
  out of an otherwise even run.

### Don't scale a sprite with `ctx.scale`

`fillRect` on a fractional edge antialiases, and the result looks soft. Use whole pixels for
anything that becomes a rectangle's edge or offset. A radius can stay fractional.

`drawFrame` in `render/assets.ts` follows this when it cuts atlases. It rounds each frame's
size and offset to whole pixels, and it only mirrors whole cells with `ctx.scale(-1, 1)`,
which is exact.

## Architecture

```
src/
  main.ts        frame loop; puts __wildmarch on window
  core/          math.ts (vectors, seeded RNG, value noise, fbm), input.ts (keys, virtual stick)
  game/          types.ts, content.ts (ALL TUNING), world.ts, state.ts (the simulation),
                 loot.ts, save.ts (the schema only), offline.ts (a pure ledger)
  render/        pixel.ts, assets.ts, terrain.ts, minimap.ts, font.ts, renderer.ts
  ui/            ui.ts (the HUD overlay), storage.ts (the only file that knows about localStorage)
  assets/        types.ts (IDs, geometry, manifests), frames.ts (GENERATED)
tools/
  measure-atlas.mjs         measures model-authored atlases into src/assets/frames.ts
  build-character-atlas.mjs composes an 8-facing character sheet from 8 strips
  art/                      the generation pipeline; see tools/art/README.md
  lib/                      png.mjs (RGBA read/write), segment.mjs (sprite finding)
art/
  characters/<name>/        turnaround, 8 strips, desc.txt, sheet.json
```

### Where the art comes from

`public/assets/generated` holds the PNGs, and `ASSET_MANIFEST` in `src/assets/types.ts`
lists each one with the exact size it must have. Startup rejects a missing or wrong-sized
asset before it builds the simulation.

There are two kinds:

- **Composed character sheets** — `warrior-atlas-8dir.png` and `wolf-atlas-8dir.png`, plus
  `warrior-portrait.png`. This project builds these, so their grids are exact.
- **Model-authored atlases** — `enemy-atlas.png`, `support-atlas.png`, and
  `terrain-atlas.png`. A model laid these out, so their contents have to be measured.

`render/assets.ts` turns them into sheets, props, and icons at startup. `PixelCanvas` in
`render/pixel.ts` still draws effects and the shapes the HUD needs.

`PixelCanvas.spike` narrows downward, so it's wide at the top. `PixelCanvas.cone` narrows
upward. Pick the wrong one and you get upside-down trees, ears, flames, and tents — with no
error to warn you.

### Never divide an atlas. Measure it.

A model drew the enemy, support, and terrain atlases, and their sprites don't sit on a grid
that divides evenly. No prompt fixes that: a strip generated with explicit instructions for
even spacing came back at 483, 486, and 486 px where even division would use 494.

So `tools/measure-atlas.mjs` finds each sprite by its own pixels and writes
`src/assets/frames.ts`. Run `npm run atlas:measure` after any atlas changes and commit the
result. Nothing at runtime may divide an atlas by a row or column count. That mistake is
silent: it sheared the feet off every warrior frame, left one facing blank, and let the two
ability icons bleed into each other.

The tool asserts row and column counts, so an atlas that comes back a different shape stops
the tool instead of rendering wrong.

`radius` joins the parts of one sprite — a sword tip, a lifted paw — without bridging to its
neighbor. `clips` groups the columns of a single animation. The layout pitch is fitted
within a clip and nowhere else, because a sheet spaces its clips differently, and one fit
across the whole row splits the difference into a steady drift that slides the body along
the ground.

### Every frame stands on its own feet

`AtlasFrame.oy` is the distance from a frame's top to its own sole, where the sole is the
lowest scanline wide enough to be a foot. That way a sword hanging below a boot doesn't
become the thing the figure stands on.

`drawFrame` puts that sole on `anchorY` in every pose and every facing, so a character at
rest always has its feet on the ground.

An earlier rule took one line per row, from the lowest point anything in it reached. The
warrior's three attack frames are drawn 3 px higher than his walk frames, so the attack
decided where the standing figure's feet went. The figure hovered — by a different amount in
each facing — and bobbed as the player turned.

`drawFrame` rounds the top and bottom edges separately and takes the height from the
difference. Round the height instead and its parity decides whether the sole lands on the
line or a pixel above it, so the figure flutters as the player turns. This is the same rule
`render/pixel.ts` follows for its own shapes.

`AtlasFrame.ox` is whatever is left of a frame's position once the layout pitch comes out, so
it's movement inside the clip and nothing else. Mirroring a cell reflects `ox` along with the
art, so a mirrored walk sways the right way.

### Sheets have 8 rows, one per facing octant

`facingToDir` in `core/math.ts` returns the row index: `0 S, 1 W, 2 E, 3 N, 4 SE, 5 SW,
6 NE, 7 NW`. Composed character sheets are built in that order, so their rows map straight
to it with no lookup table.

### Never mirror a figure that carries something

The warrior holds his sword in his right hand and his shield on his left arm. Mirroring puts
them in the wrong hands — walking east and then west visibly swapped them in front of the
player.

So a character sheet holds a row that was drawn for each of the eight facings.
`CHARACTER_SHEETS` in `src/assets/types.ts` lists the sheets that have one. A beast carries
nothing, so mirroring costs it nothing.

### A composed sheet is the sheet

`tools/build-character-atlas.mjs` takes one strip of frames per facing and composes an
atlas: 8 rows in `facingToDir` order, at the size the game draws. `preloadArt` then wraps the
image and blits a cell straight to the screen — no measuring, no scaling, no redrawing. Don't
run a composed sheet through `measure-atlas.mjs`.

`CHARACTER_SHEETS` records the grid the tool chose, and `preloadArt` checks the image against
it, so a rebuild that changes the grid fails at startup.

The tool gives each facing its own scale. A model draws each strip separately and picks its
own size — a wolf seen head-on came out three times the size of the same wolf from the side —
so every facing normalizes to the same standing height.

### A non-directional sheet takes its row from the heading

`Sheet.directional` is false when the eight rows are one side view repeated. There's no row
for up or down, so `Renderer.drawEnemy` picks row W or row E from the sign of
`Math.cos(e.facing)` and ignores `Enemy.dir`.

An octant spans 45°. Both vertical octants used to hold the eastward art, so a wolf running
down and to the left ran facing right. The sign of the heading has no such gap. A directional
sheet has a row per octant and uses `Enemy.dir`.

The corpse bake pulls the side view from row 2 by index, so row 2 has to stay E.

An enemy's sheet lives on the enemy in `Enemy.sheet`. Don't look it up from the species,
because an apex enemy uses neither the ordinary body nor the elite one. Collision radius and
reach both come from `BEAST_GEOMETRY[sheet].renderScale`, which is also the only control over
how large a beast draws — that's what keeps art and hitbox together.

### The enemy atlas has no walk cycle

It holds two poses per beast, an idle and an attack. `beastSheet` puts the idle in columns 0
through 3 with a one-pixel bob, because the renderer asks for four walk frames. A beast on
that atlas can't animate its walk, and no code change fixes it — it needs a composed sheet of
its own, like the wolf has.

`COMPOSED_BEASTS` in `render/assets.ts` lists the species that have one. The rest still come
from the enemy atlas.

### World text uses the bitmap font

`render/font.ts` has a 5 × 7 bitmap font. Use it, not `fillText`. Canvas text is
antialiased, the buffer is low-resolution, and magnifying the result makes it unreadable.

### The boundary between game and UI

The simulation never touches the DOM, and the renderer only draws to the canvas.
`Game.hooks` (`log`, `banner`, `dirty`) is the single channel out, and `UI` wires it up. A
panel rebuilds only on `dirty()` or when it opens, while cheap widgets — bars, cooldowns, the
minimap — update every frame. Any change to inventory, quests, or counters has to call
`hooks.dirty()`, or an open panel keeps showing stale data.

### The persistence layers

`game/save.ts` holds the schema and the version constant. `game/offline.ts` is a pure
function: `(save, elapsed, rng) → OfflineReport`. `ui/storage.ts` is the only file that knows
about localStorage. `Game` builds and reads a plain object and never touches storage, because
a server has to be able to hold the same schema per account. `offline.ts` exports
`killsPerHour`, used by both the ledger and the Hunt tab, so the rate a player sees before
choosing a hunting ground is the rate the ledger pays.

### HUD stacking order

`#stickzone` is a large invisible pointer catcher in the lower left. Any interactive control
that overlaps it needs a higher `z-index`, or it silently stops receiving taps. The return
report sits at `z-index: 45`.

### Units

World pixels and art pixels are the same unit, and `TILE` is 32. Sprites anchor at the feet
through `Sheet.anchorY`, and the scene sorts by ground position on the y axis, so props and
entities overlap correctly.

## Tuning

Balance changes almost never need simulation changes. `src/game/content.ts` holds enemy
stats, drop rates, the XP curve, stat derivation, ability numbers, item bases and affixes,
the quest chain, the milestone table, both reward curves, the offline model (`OFFLINE`),
auto-battle seek ranges (`AUTO`), `TALENT_ROWS`, `RESPEC_COST_PER_LEVEL`, `UNIQUES`, `EMBER`,
`MASTERY_TIERS`, `BEHAVIOUR`, `BOSSES`, `BOSS`, and the `Mods` and `COMBINE` tables they all
use.

`REGIONS` in `src/game/world.ts` holds region positions, level bands, pack sizes, and node
counts. `CAMPS`, `ROAD_LINKS`, `LANDMARKS`, and `NPCS` live in the same file. An `Npc` entry
holds a position, a name, and every line that person says.

A new talent or relic is usually one table entry. It might also need a field on `Mods` and a
`COMBINE` rule. The simulation reads `this.mods`; it never reads the tables.

A new species needs an entry in `ENEMY_KINDS`, stats in `ENEMIES`, an ID in
`BEAST_SHEET_IDS` with its scale in `BEAST_GEOMETRY`, a row in `BEAST_ROW`, and a region to
live in. It also needs a row of its own in the enemy atlas. The build lists everywhere else
that needs updating.

### A known balance gap

`OFFLINE.efficiency` is 0.72, so being away accrues almost as fast as playing. A night away
can carry a character to the top of the level range in one session. There are two one-line
fixes: make `xpForLevel` steeper, or lower `OFFLINE.efficiency`. Choosing between them is a
design decision, not a bug fix.
