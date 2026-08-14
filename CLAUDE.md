# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This file uses ASD-STE100 (Simplified Technical English). Write new text in the same
style: one idea in each sentence, the active voice, short sentences, and simple words.

Wildmarch is a vertical slice of an idle action RPG with a top-down view. The game draws
to a canvas. Four PNG atlases in `public/assets/generated` hold the art, and the code cuts
them into sheets at start-up. The game has one class (Warrior), six regions, and five
species. The game keeps the save data on the local machine only.

## Commands

```bash
npm run dev           # Vite dev server on port 5173, open to the LAN and to mobile
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm test              # vitest, the unit tests
npm run test:browser  # playwright, the smoke tests
npm run build         # typecheck, then a production bundle in dist/
npm run preview       # serve dist/
npm run verify        # all of the above, in order
npm run atlas:measure # measure the atlases again and rewrite src/assets/frames.ts
npm run atlas:characters <spec.json>   # compose a character sheet from 8 strips
```

The TypeScript configuration sets `strict`, `noUnusedLocals`, and `noUnusedParameters`.
Thus an unused import stops the build. Run `npm run typecheck` before you report that the
work is complete.

The configuration also sets `verbatimModuleSyntax`. Thus an import of a type must use
`import type`.

## How to verify a change

Vitest holds the unit tests and Playwright holds the smoke tests. They are not sufficient.
This is a game, and you can see much of its behaviour only in movement. Thus you must also
verify each change in a real browser with the game in operation. The code puts the
simulation, the renderer, and the command boundary on `window.__wildmarch` for this purpose.

Playwright is a dependency of this project. Import it from `node_modules`:

```js
import { chromium } from '<repo>/node_modules/playwright/index.mjs'
```

A good probe simulates the game and then reads the state. Do not make assertions about
pixels.

```js
await page.keyboard.press('Space')          // start auto-battle
await page.waitForTimeout(14000)
await page.evaluate(() => {
  const g = window.__wildmarch.snapshot()
  return { kills: g.counters.kills, chasing: g.enemies.filter(e => e.state === 'chase').length }
})
```

Collect `pageerror` and the console errors. Also make a screenshot of the result. You can
see some defects only in an image: upside-down tents, a gold blob on top of an enemy, and a
checkerboard pattern in the terrain. The state showed none of these three defects. Probe
scripts and their screenshots are temporary. Write them outside the repository.

The game keeps a save. Thus obey these three rules:

- Clear the storage first. Call `localStorage.clear()`, then load the page again. If you do
  not, a new character starts with the level from the last run.
- Set an earlier date with `page.addInitScript(...)`, which runs before the game starts.
  The `pagehide` event writes a save when the page closes. Thus a date that you set from
  inside the page is lost when you load the page again to read it.
- Let the game become quiet before you compare the state from before and after a page load.
  The game keeps the auto-battle setting, and auto-battle starts again immediately. Stop
  auto-battle and stand in a camp, because a camp makes each enemy stop its chase.

## Rules that you must not break

Each rule below has a reason. If you change the code and you do not know the reason, the
game breaks in a way that is difficult to find.

### The sequence of the frame loop

`main.ts` uses this sequence: `input` → `game.update` → `renderer.updateCamera` →
`game.setView` → `render`. You must simulate before you move the camera. If the camera
follows a player position that is one frame old, the offset from the camera to the player
changes with the frame time. The pixel snap then shows that change as jitter.

### The three snaps in the pixel pipeline

The pixel pipeline snaps three times. Each snap has a different function. Keep all three.

1. The code draws the world into a buffer with a low resolution. The origin of the buffer
   is on a whole art pixel. This keeps the art sharp. It also stops the player from sliding
   on the ground.
2. The code blits the buffer with an integer scale from art pixels to device pixels. With a
   fractional scale, adjacent art pixels cover different quantities of device pixels, and
   the detail moves when the world scrolls.
3. The code applies the fraction that snap 1 removed to the position of the blit, at the
   resolution of the device. Thus slow movement scrolls smoothly. Without this snap, the
   movement stops and then jumps.

`Renderer.resize` obeys these conditions:

- It uses the true value of `devicePixelRatio`. Do not round that value down. Do not apply
  a maximum limit to it.
- It makes the backing store exactly `cssPx x dpr`.
- It makes the buffer 2 art pixels larger than the screen needs. Thus the offset of the
  blit cannot pull an empty edge into view.
- It makes the width and the height of the buffer even numbers. With an odd width, the
  origin of the view is on a half pixel, and `Math.round` changes direction with the
  parity.

`main.ts` snaps `dt` to a whole number of display frame periods for the same reason. A
small error in `dt` changes the result of the rounding and scrolls the world one pixel too
far.

### The camera locks on to the player

The camera must stay locked on to the player. Do not add easing. Easing leaves a gap of
less than one pixel between the camera and the player. That gap changes in each frame, and
it rounds first in one direction and then in the other direction. The player then slides
against the ground. A measurement showed a movement of 15 px with changes of direction.

### A camp discovers once and answers a task each time

`Game.enterCamp` runs in each frame that the player stands in a camp. The discovery half
runs one time. The `reach` task check runs each time, because a player can walk into a camp
before anybody asks them to. If the check lived in the discovery half, that task could never
finish, and the whole chain would stop behind it.

### The HUD shows banners one at a time

Walking into a camp can find the place, finish a task, and take a level in the same frame.
`UI.banner` puts each one in a queue and shows it for 2.6 seconds. Without the queue, the
last banner is the only banner, and it is the least important of the three.

### The rule that stops a chase is in three files

`Renderer` calculates the view rectangle. `main.ts` sends that rectangle to `game.setView`.
`Game.shouldGiveUp` then uses it. An enemy stops its chase in these four conditions:

- The enemy goes out of the visible screen.
- The enemy goes further from its spawn anchor than its leash permits.
- The enemy falls more than 2.6 aggro ranges behind the player.
- The player goes into a camp.

This rule lets a player cross the map without a large group of enemies behind them. Verify
the rule again after you change the enemy AI, the camera, or the sequence of the loop.
`isEngaged` in `types.ts` lists the states that the rule controls. If you add a state and
you do not put it in `isEngaged`, that enemy follows the player across the map.

### A kill has two halves

`Game.killEnemy` is the half for the world. It makes the corpse, it makes the effect, and
it gives the slot of the enemy back to its `SpawnNode`. Each enemy has a `nodeId`. If you
do not remove the enemy from `node.alive` and set `node.respawnAt`, that node stops the
supply of new enemies, and it gives no error.

`Game.creditKill` is the half for the player. It moves the counters, it moves the quest
progress, and it gives experience, gold, and drops at the correct scale.

Credit for a kill is universal, because each player who does damage to an enemy gets the
full quantity. Thus the half for the world must run one time for each death. The half for
the player must run one time for each contributor.

### Per-player data must not be in module scope

Two defects of this type are already corrected. The discovery of a camp changed the
exported `CAMPS` array. `loot.ts` kept `nextUid` as a counter in module scope, which
started again at 1 after a load and gave the same number as restored equipment.

This project moves towards a shared world. Thus data for one character belongs on `Game`
and in the save. `CAMPS` and `REGIONS` stay as placement data that does not change.

### Data for each species is a record with an `EnemyKind` key

Do not add one field for each animal. `ENEMY_KINDS` in `types.ts` is the one list.
`Counters.species`, `Mods.vs`, `Mods.from`, `OFFLINE.cleave`, and the milestone `Metric`
(`slain:${EnemyKind}`) all come from that list. Thus a new species is one entry in a table,
and the build shows you each other location that needs a change.

`NO_MODS` freezes its two records, and `baseMods()` copies them. A shallow spread gives
each character the record from module scope.

### A species is a behaviour, not a set of statistics

`EnemyType.behaviour` selects `stalk`, `charge`, `web`, or `flock`. `Game.stepEnemy`
contains the code, and `BEHAVIOUR` contains the numbers. Each behaviour has a rule that
keeps it fair:

- A charge holds its heading and stops all steering. If it steered, it would be an attack
  with more steps.
- A web refreshes its duration. It does not add to it, because an increase of the duration
  is a stun.
- A flock has a cooldown for each bird before it scatters, and the scatter ignores burn
  ticks. Without the cooldown, the player can kite the flock for an unlimited time. Without
  the second condition, the player can move the flock with burning ground.

### One `Mods` bag, one fold, one stacking rule for each field

Talents, worn relics, and beast mastery each give a `ModsPatch`. `buildMods` folds them in
a fixed sequence. `Game.computeMods` and `offline.ts` both use `buildMods`. Thus the live
game and the ledger always agree about the rules for a character.

`COMBINE` in `content.ts` is a `Record<keyof Mods, ...>`. A new field on `Mods` must
declare its stacking rule: multiply, add, OR, or fold for each species. If it does not, the
build fails. It does not select a default rule that is incorrect.

`shouldGiveUp` limits `mods.leashMult` to 1 or less. Content can make a chase stop earlier.
Content must not make a chase longer.

### Auto-equip ignores a relic in both directions

`itemScore` reduces equipment to one number. The full value of a unique item is a rule that
this number cannot see. Thus `Game.addItem` sends each item with `Item.unique` to
`stowUnique`. The code does not auto-equip a unique item, and it does not replace a unique
item that the player wears.

A unique item has `value: 0` and you cannot sell it. `sellFromBag` guards this. There is one
of each unique item, and `foundUniques` stops a second drop. Thus the auto-sell for a full
bag would destroy this content permanently. A full bag makes space for a relic when it sells
the worst ordinary item.

### A world boss follows a clock, not a respawn timer

`bossWindow(now)` is a pure function of the wall time. Thus each client agrees about the
time when an apex enemy walks. That agreement is the reason for the design.
`Game.bossCleared` records the window that this character took, and the save keeps it. This
stands in for the shared data that a server will hold later.

A boss has `nodeId: -1`. The `skipBosses` parameter of `Game.nearestEnemy` stops
auto-battle from moving to a boss.

### Mastery is a view, not a record

`masteryTier` reads `Counters.species` directly. Thus the bestiary always agrees with the
kill totals in the HUD. The cost of this design is that `recalc` must run when the kills go
across a tier limit. `creditKill` samples the tier before the increment and after the
increment. `applyOfflineReport` runs `recalc` one time at the end.

### A spawn node puts its elites first

Elite enemies need the largest clear area. If the code puts them last, a full region has
space only for ordinary dens. Wolfden Thicket once had zero alpha wolves. Thus it had no
relics, but the offline ledger continued to pay for both.

### Two reward curves with two different functions

`rewardScale` controls gold, the drop chance, and the item level of a drop. For an enemy
below the player, its minimum is 15%. For an enemy above the player, its minimum is 4%.
Thus it never becomes zero. `xpScale` controls experience only, and it becomes exactly zero
at 8 levels below the player. Thus a player can outgrow a region.

If you use `rewardScale` for experience, the player can grind in the first region for an
unlimited time. If you use `xpScale` for loot, all drops stop. Neither curve changes kills,
quests, counters, or milestones. The game always records a kill. Only the payment changes
with the scale.

### Auto-battle works on the task

Two decisions make a hunt serve the task. `Game.huntPlan` reads the task in hand and
answers both.

- `pickTarget` uses `want`, the species the task counts. Auto-battle crosses `AUTO.taskSeek`
  for that species and only `AUTO.straySeek` for anything else. A character that answers
  each beast inside the full range drifts off the den it was sent to, one detour at a time.
- `roam` uses `autoGoal`. With a task in hand it walks to that task's work, not to the
  nearest den. Thus a task to reach a camp finishes with no help, and the task after it
  starts the walk again.

`focused` shortens the leash whenever the task has somewhere to be. A body count (`any`)
takes each beast, thus it narrows nothing. A task that is only on offer counts for neither
decision, because a conversation takes it and standing beside the giver would stop the hunt.
An apex counts for neither either, for the same reason `skipBosses` exists.

The rule is a preference and not a blindfold. Each beast that comes close is still fair
game, and each beast in reach still gets the swing.

### Travel walks a route; it does not chase

`Game.travel` holds one destination, and `Game.travelTo` starts the walk. Auto-battle then
walks the route and chases nothing. `stepSwing` still answers each beast that comes within
reach, thus a walk through a pack costs the pack blood.

`World.findPath` gives the route. It is A* across the 32 px tile grid, because a straight
walk sticks: `moveEntity` slides along the free axis, and a bay in a lake holds the player
against the shore. The first search keeps one tile of clearance from the water, because the
collision box is padded. A search with no route tries again without that clearance.

`Game.stepRoute` walks one step of a `Route`, and travel and roaming both go through it.
Thus a walk the player asked for and a walk auto-battle chose move the same way. It returns
false when the walker has gone nowhere for more than a second, and the caller draws the
route again. Roaming throttles that with `roamRetry`, because a place with no route costs a
search of the whole map to find out.

A journey ends in one of five ways: it arrives, the player takes the stick, the player stops
auto-battle, the player dies, or the task that it serves ends. `Game.endTravel` takes one
flag: whether the journey ended at the place it was going. Only that case obeys
`TravelTarget.stopHere`, which switches auto-battle off. Use `stopHere` for a person and for
a camp, because the player arrives to read something. Do not use it for a den, because the
beasts there are the point.

The end of a task counts as arriving. A camp is discovered at its full radius, which is
outside the radius the journey aims for, thus the task finishes first and ends the journey.
If that counted as a cancellation, auto-battle would march back out of the camp before the
player had read the banner.

`Game.questDestination` turns a task into a destination. The tracker and the Tasks panel
both call it. Do not calculate a destination in the HUD.

### A task that a person gives waits until the player takes it

`QuestDef.from` holds an id in `NPCS`. With one, the task sits unstarted until the player
stands beside that person and takes it. Without one, the task starts by itself when the
task before it ends.

`Game.quest` is the one place that decides this. It returns null while the task is only on
offer, and `Game.offeredQuest` returns the task instead. Thus the three paths that credit
progress (`advanceQuestOnKill`, `discoverCamp`, and `applyOfflineReport`) all stop through
one getter. Do not add a fourth path that reads `QUESTS[this.questIndex]` directly.

`Game.questTaken` is per-player progress, and the save holds it. A save from version 5
migrates to `true`, because no person handed a task out in that world.

An NPC stands still and has one pose. `Renderer.drawNpc` draws it, the name, and the gold
mark that says a task is on offer. The mark bobs, because a still figure among still props
is easy to walk past.

### The save migrates forward

`save.ts` is at version 6. `readSave` does the structural check and each migration in one
pass. The code discards a save from a different seed, because each camp and each den would
be in a different location. The code fills an older schema version with default values.
Keep each addition additive, and each new version stays a change of two lines.

### The save does not contain the world

Terrain, props, and the position of each spawn are pure functions of the seed. The `Game`
constructor fills each node at start-up. Thus `hydrate` runs on a world that is already
complete, and it restores only the character.

`hydrate` also gives a new seed to `this.rand`. The loot stream has a fixed seed and no
position that the code can recover. Without the new seed, each session rolls the same drops
from the start of the stream.

### The offline ledger runs in buckets

Rewards change with the level. Thus `offline.ts` steps in slices of ten minutes and
calculates the statistics again between the slices. If you make it a single pass, a
character that stays away all night earns at its start level all night.

### One function samples the terrain at two resolutions

`World.sampleTile(wx, wy)` is the source of truth. The game logic and the collision use
`tileAt(tx, ty)` on the grid of 32 px. That path has a cache, and `isSolidTile` blocks water
only. The renderer calls `sampleTile` directly at each 8 px, thus the edges of a biome
follow the noise and not the tile grid. A change to the terrain rules changes both paths.
`sampleTile` runs thousands of times for each chunk bake, thus keep it fast.

### The code rasterises one slanted edge at a time

Each shape in `render/pixel.ts` with a diagonal side (`px`, `span`, `wedge`, `spike`,
`cone`, `line`, `sweep`) rounds each edge as its own linear ramp, and it divides last.
Three errors are possible:

- If you round a position and a size separately, the far edge gets the error from the near
  edge.
- If you centre a rounded width, the two sides connect, and the slant stutters with the
  parity of the width.
- If you write `d * (i / n)`, a half step goes to the incorrect side of a tie, and one
  stair goes out of an otherwise regular run.

### Do not scale a sprite with `ctx.scale`

`fillRect` on a fractional edge makes an anti-aliased edge, and the result is soft. Use
whole pixels for each value that becomes the edge or the offset of a rectangle. A radius can
stay fractional.

`drawFrame` in `render/assets.ts` obeys this when it cuts the atlases. It rounds the size and
the offset of each frame to whole pixels, and it mirrors with `ctx.scale(-1, 1)` on the whole
cell only, which is exact.

## Architecture

```
src/
  main.ts        frame loop; puts __wildmarch on window
  core/          math.ts (vectors, seeded RNG, value noise, fbm), input.ts (keys, virtual stick)
  game/          types.ts, content.ts (ALL TUNING), world.ts, state.ts (the simulation),
                 loot.ts, save.ts (the schema only), offline.ts (a pure ledger)
  render/        pixel.ts, assets.ts, terrain.ts, minimap.ts, font.ts, renderer.ts
  ui/            ui.ts (the HUD overlay), storage.ts (the only file that knows about localStorage)
  assets/        types.ts (ids and geometry), frames.ts (GENERATED, see below)
tools/
  measure-atlas.mjs   finds the frames in each atlas and writes src/assets/frames.ts
```

### The art comes from four atlases

`public/assets/generated` holds four PNG atlases: the warrior, the enemies, the support art
(people, props, effects, icons), and the terrain. `ASSET_MANIFEST` in `src/assets/types.ts`
lists them with the size each one must have. Start-up rejects an atlas that is absent or
that has a different size, before it builds the simulation.

`render/assets.ts` cuts the atlases into sheets, props, and icons at start-up.
`PixelCanvas` in `render/pixel.ts` still draws effects and the shapes the HUD needs.

`PixelCanvas.spike` becomes narrow in the downward direction, thus it is wide at the top.
`PixelCanvas.cone` becomes narrow in the upward direction. If you select the incorrect one,
you get upside-down trees, ears, flames, and tents, and you get no error.

### Never divide an atlas. Measure it.

An image model drew these atlases. Their sprites are not on a grid that divides evenly, and
no prompt makes them. A measured strip of four frames, asked for with even spacing, came
back at 483, 486, and 486 pixels where an even division would use 494.

Thus `tools/measure-atlas.mjs` finds each sprite by its own pixels and writes
`src/assets/frames.ts`. Run `npm run atlas:measure` after any atlas changes, and commit the
result. No code at run time may divide an atlas by a row or a column count. That mistake
gives no error: it cut the feet off every warrior frame, it left one facing empty, and it
let the two ability icons bleed into each other.

The tool asserts the row and column counts. Thus an atlas that comes back a different shape
stops the tool instead of rendering incorrectly.

`radius` in the tool joins the parts of one sprite, such as a sword tip, without bridging to
its neighbour. `clips` groups the columns of one animation. The layout pitch is fitted
inside a clip and nowhere else, because the warrior's walk frames sit about 151 px apart and
its attack frames about 209 px apart. One fit across the row splits that difference and
reads as a drift of about 25 px in each column, which slides the body across the ground.

### Every frame stands on its own feet

`AtlasFrame.oy` is the distance from the top of a frame to its own sole. The sole is the
lowest scanline that is wide enough to be a foot, thus a sword that hangs below a boot does
not become the thing the figure stands on.

`drawFrame` puts that sole on `anchorY` in each pose and in each facing. Thus a character at
rest always has its feet on the ground.

An earlier rule took one line for a whole row, from the lowest point anything in it reached.
The warrior's three attack frames are drawn 3 px higher than his walk frames, so the attack
decided where the standing figure's feet went. The figure then hovered, by a different
amount in each facing, and it bobbed as the player turned.

`drawFrame` rounds the top edge and the bottom edge on their own and takes the height from
the difference. If it rounded the height instead, the parity of that height would decide
whether the sole landed on the line or one pixel above it, and the figure would flutter by a
pixel as the player turned. This is the rule `render/pixel.ts` follows for its own shapes.

`AtlasFrame.ox` is what is left of the frame's position after the layout pitch comes out.
Thus it is movement inside the clip, and nothing else. A mirrored cell reflects `ox` with
it, thus a mirrored walk sways in the correct direction.

### A sheet has 8 rows, one row for each facing octant

`facingToDir` in `core/math.ts` gives the index: `0 S, 1 W, 2 E, 3 N, 4 SE, 5 SW, 6 NE,
7 NW`. The atlases do not hold eight octants. `WARRIOR_FACINGS` in `render/assets.ts` says
which authored row each octant takes.

### Never mirror a figure that carries something

The warrior holds his sword in his right hand and his shield on his left arm. A mirror puts
them in the wrong hands. Walking east and then west swapped them in front of the player.

Thus a character sheet holds a row that an artist drew for each of the eight facings.
`CHARACTER_SHEETS` in `src/assets/types.ts` lists the sheets that have one.

### A composed character sheet is the sheet

`tools/build-character-atlas.mjs` takes one strip of frames for each facing and composes an
atlas: 8 rows in the order `facingToDir` numbers them, at the size the game draws at. Thus
`preloadArt` wraps the image and blits a cell straight to the screen. It does not measure,
scale, or redraw the art. Do not put a composed sheet through `measure-atlas.mjs`.

`CHARACTER_SHEETS` records the grid the tool chose. `preloadArt` checks the image against
those numbers, thus a rebuild that changes the grid stops at start-up.

The tool gives each facing its own scale. An image model draws each strip on its own and
picks its own size: a wolf seen head-on came out three times the size of the same wolf seen
from the side. Each facing therefore normalises to the same standing height.

### A sheet that is not directional takes its row from its heading

`Sheet.directional` is false when the eight rows hold one side view repeated. There is no
row for up or for down, thus `Renderer.drawEnemy` selects row W or row E from the sign of
`Math.cos(e.facing)` and ignores `Enemy.dir`.

An octant covers 45 degrees. The two vertical octants both held the eastward art, thus a
wolf that ran down and to the left ran facing right. The sign of the heading has no such
gap. A directional sheet has a row for each octant and uses `Enemy.dir`.

The corpse bake takes the side view from row 2 by its index. Thus row 2 must stay E.

The sheet that an enemy uses is on the enemy in `Enemy.sheet`. Do not look it up from the
species, because an apex enemy uses neither the ordinary body nor the elite body. The
collision radius and the reach come from `BEAST_GEOMETRY[sheet].renderScale`, which is also
the only control on how large the beast draws. Thus the art and the hitbox stay together.

### The enemy atlas holds no walk cycle

It holds two poses for each beast: an idle and an attack. `beastSheet` puts the idle in
columns 0 to 3 with a bob of one pixel, because the renderer asks for four walk frames. Thus
a beast on that atlas cannot animate its walk. Do not try to correct this in code. It needs
a composed sheet of its own, as the wolf has.

`COMPOSED_BEASTS` in `render/assets.ts` says which species have one. The others still come
from the enemy atlas.

### Text in the world uses the bitmap font

`render/font.ts` has a bitmap font of 5 x 7 pixels. Use it. Do not use `fillText`. The
canvas makes anti-aliased text, the buffer has a low resolution, and the magnification then
makes the text unreadable.

### The boundary between the game and the UI

The simulation does not touch the DOM. The renderer draws to the canvas only. `Game.hooks`
(`log`, `banner`, `dirty`) is the one channel out of the simulation, and `UI` connects it. A
panel builds itself again only when `dirty()` occurs or when the panel opens. Cheap widgets
(bars, cooldowns, the minimap) update in each frame. Each change to the inventory, the
quests, or the counters must call `hooks.dirty()`. If it does not, the open panel shows old
data.

### The layers of the persistence

`game/save.ts` holds the schema and the version constant. `game/offline.ts` is a pure
function: `(save, elapsed, rng) → OfflineReport`. `ui/storage.ts` is the only file that
knows about localStorage. `Game` makes and reads a plain object, and it does not touch the
storage, because a server must be able to keep the same schema for each account.
`offline.ts` exports `killsPerHour`. The ledger and the Hunt tab both use it. Thus the rate
that the game shows to a player before they select a ground is the rate that the ledger
pays.

### The stack order of the HUD

`#stickzone` is a large invisible catcher for pointer events in the lower left of the
screen. Each interactive control that overlaps it needs a higher `z-index`. If it does not
have one, it stops receiving taps, and it gives no error. The return report is at
`z-index: 45`.

### Units

World pixels and art pixels are the same unit. `TILE` is 32. A sprite has its anchor at the
feet through `Sheet.anchorY`. The scene sorts by the ground position on the y axis. Thus
props and entities go in front of and behind each other correctly.

## Tuning

A change to the balance almost never needs a change to the simulation code.
`src/game/content.ts` holds the statistics of each enemy, the drop rates, the XP curve, the
derivation of the statistics, the numbers for each ability, the item bases and affixes, the
quest chain, the milestone table, both reward curves, the offline model (`OFFLINE`), the
seek ranges of auto-battle (`AUTO`),
`TALENT_ROWS`, `RESPEC_COST_PER_LEVEL`, `UNIQUES`, `EMBER`, `MASTERY_TIERS`, `BEHAVIOUR`,
`BOSSES`, `BOSS`, and the `Mods` and `COMBINE` tables that all of these use.

The `REGIONS` array in `src/game/world.ts` holds the position of each region, the level
bands, the pack sizes, and the quantity of nodes. `CAMPS`, `ROAD_LINKS`, `LANDMARKS`, and
`NPCS` are in the same file. An `Npc` entry holds the position, the name, and each line
that the person says.

A new talent or a new relic is usually one entry in a table. It can also need one field on
`Mods` and its `COMBINE` rule. The simulation reads `this.mods`. It does not read the
tables.

A new species is one entry in `ENEMY_KINDS`, one set of statistics in `ENEMIES`, one id in
`BEAST_SHEET_IDS` with its scale in `BEAST_GEOMETRY`, one row in `BEAST_ROW`, and one region
to live in. It also needs a row of its own in the enemy atlas. The build lists each other
location that needs a change.

### A known gap in the balance

`OFFLINE.efficiency` is 0.72. Thus accrual when the player is away is almost as fast as
play. A night away can move a character to the top of the level range in one session. Two
corrections are possible, and each one is a change of one line: make `xpForLevel` steeper,
or make `OFFLINE.efficiency` lower. The selection between them is a design decision. It is
not a correction of a defect.
