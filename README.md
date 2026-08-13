# Wildmarch

A top-down idle action-RPG vertical slice. Canvas-rendered pixel art, a virtual
joystick, auto-battle, wolves and bears in territories that make sense, a quest
chain, loot that drops straight into your bag, and milestone rewards you claim
by hand.

No art files, no game engine, no runtime dependencies — every sprite and tile in
the game is generated in code at boot.

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm run build    # typecheck + production bundle into dist/
npm run preview  # serve the production build
```

## Controls

| Action | Keyboard | Touch / mouse |
| --- | --- | --- |
| Move | `WASD` / arrows | Drag anywhere in the lower-left of the screen |
| Auto-battle | `Space` | **Auto** button, bottom left |
| Whirlwind | `Q` | Ability button |
| Second Wind | `E` | Ability button |
| Inventory | `I` | **Bag** |
| Tasks | `J` | **Tasks** |
| Rewards | `R` | **Rewards** |
| Hunting grounds | `H` | **Hunt** |
| Toggle auto-equip | `F` | Button inside the Inventory panel |
| Close a panel | `Esc` | **Close** |

Attacks fire on their own whenever a beast is inside your swing arc — the
warrior never waits for a button. In the inventory, click an item to equip it
and right-click to sell it.

## What is in the slice

**World.** 148x148 tiles (~4700px square), generated from one seed. Three
regions with distinct terrain and inhabitants — Greenwood Vale (wolves, levels
1–3), Wolfden Thicket (wolves and alphas, 4–8) and Stonewatch Ridge (bears and
elders, 6–11) — joined by roads between three camps.

**Intentional spawns.** Enemies do not sprinkle uniformly. Each region seeds a
set of *spawn nodes* — wolf dens holding packs of 3–5, bear grounds holding one
or two — placed on dry ground, away from the roads and well clear of the camps.
Every beast is anchored to its node, wanders inside its territory, and respawns
there.

**No monster trains.** A chase ends the moment any of these becomes true: the
beast leaves the visible screen, it strays past its leash radius from home, the
player is more than 2.6 aggro-ranges away, or the player steps inside a camp. It
then walks home at speed, healing, ignoring you completely. You can cross the
map without collecting a parade. (Verified in a browser: a pack of 8 fully
disengages within about seven seconds of walking away.)

**Combat.** Arc melee — a cone in your facing direction that cleaves everything
inside it — plus Whirlwind (AoE burst) and Second Wind (heal). Crits, armour
mitigation with diminishing returns, and floating damage numbers.

**Outgrowing a region.** Experience falls to exactly zero eight levels above a
beast, so no region can be ground forever — a level 11 character earns nothing
from Greenwood Vale but is still paid properly in Wolfden Thicket. Gold and
drops keep a separate, gentler curve that floors at 15%: trivial beasts are
still worth looting, they just cannot level you. Kills, quests, counters and
milestones are never affected — only the payout stops. See `xpScale` and
`rewardScale` in `content.ts`.

**Auto-battle.** Seeks the nearest valid target, closes to swing range, holds
position while attacking, fires Whirlwind when two or more beasts are in reach,
drinks Second Wind below 45% health, and walks to the nearest populated den when
the area is clear.

**Loot, inventory, equipment.** Kills roll gold plus a chance at gear. Items have
five rarities, a base stat scaled by item level, and one affix per rarity tier.
Six equipment slots. Everything auto-loots into a 40-slot bag; a full bag
auto-sells the overflow. Auto-equip (on by default) takes anything that scores
higher than what you are wearing.

**Quests.** A seven-step chain, tracked on the HUD, auto-turning-in as you
complete each: cull wolves, find the two undiscovered camps, clear bears off the
ridge, kill elites, then an open-ended hunt.

**Milestone rewards.** Eleven claimable milestones across kills, per-species
kills, elites, gold earned, level and quests completed. They sit in the Rewards
panel with a badge on the button when something is ready, and you press **Claim**
to take the payout.

**Persistence and offline progress.** The character is saved to local storage on
a timer and whenever the page is hidden or closed, and picks up where it left
off. While you are away it keeps hunting a **hunting ground** — pick one in the
Hunt tab, or leave it unpinned and it follows wherever you go. Coming back
settles the absence and opens a log of the hunt: time, ground, kills, levels,
gold and the best drops it brought home. Accrual pays out the first 12 hours.

The ledger is a closed-form rate model rather than a headless simulation — it
has to settle twelve hours in a frame — and it runs in ten-minute buckets so a
character that would have levelled during the night earns at the new rate for
the rest of it. It lives in `game/offline.ts` as a pure function of a save and
an elapsed time, with every constant in `OFFLINE` in `content.ts`.

## How it is put together

```
src/
  main.ts               fixed frame loop: input → camera → simulate → render → HUD
  core/
    math.ts             vectors, seeded RNG, value noise / fbm, geometry helpers
    input.ts            keyboard + virtual joystick (pointer events)
  game/
    types.ts            entity and item shapes
    content.ts          ALL TUNING — statlines, item bases, quests, milestones
    world.ts            terrain sampling, regions, camps, roads, spawn nodes, props
    state.ts            the simulation: AI, leashing, combat, loot, progression
    loot.ts             item generation, scoring, stat rollup
    save.ts             save schema and version — pure data, no storage
    offline.ts          the offline ledger — pure (save, elapsed) → report
  render/
    pixel.ts            pixel-art drawing surface + sheet builder + outliner
    sprites.ts          every sprite in the game, generated parametrically
    terrain.ts          chunked terrain baking
    font.ts             5x7 bitmap font for in-world text
    renderer.ts         camera, layers, y-sorting, effects
  ui/
    ui.ts               HUD overlay: bars, minimap, panels, tooltips
    storage.ts          the only file that knows persistence is a browser feature
```

Two decisions shape most of the rest:

**The world renders into a low-resolution buffer.** Roughly 900x500 "art pixels"
are drawn and then blitted to the full canvas with nearest-neighbour scaling at
an integer zoom. Every pixel stays square at any window size, and fill cost is
independent of display resolution. The HUD is ordinary DOM stacked on top, which
is how a real game does it — the game itself never touches the DOM.

**Sprites are parametric, not drawn.** `sprites.ts` builds bodies out of ovals
and rects — haunch, barrel, chest, snout, four legs — so a wolf and a bear come
out of the same routine with different numbers, and the elite variants are the
same body at a larger scale with a different palette. A silhouette-outlining
pass over each finished frame is what makes the results read as deliberate
sprites rather than blobs.

Terrain fights the tile grid on two fronts: type is sampled every 8px rather
than once per 32px tile, so shorelines and snow lines follow the noise; shading
comes from world-space noise evaluated every 4px, so it flows across tile
borders instead of restarting at each one. Chunks of 8x8 tiles are baked once
and cached.

## Tuning

Nearly everything you would want to change lives in `src/game/content.ts` —
enemy statlines and drop rates, the XP curve, stat derivation, ability numbers,
item bases and affixes, the quest chain, the milestone table. Region placement,
level bands, pack sizes and node counts are the `REGIONS` array in
`src/game/world.ts`.

`window.__game` is exposed in the browser console for poking at the simulation.

## Deliberately not in this slice

One class (Warrior), two enemy species plus their elite variants, no vendors, no
crafting, no sound. Saves are local only — there is no server, and no multiplayer.

**Known balance gap.** The offline ledger is faithful to live play (about two
thirds of the measured hands-on kill rate), but the XP curve was tuned for short
sessions: four hours in the *starter* region takes a level 2 character to level
18. With `xpScale` in place the world runs out of levelling ground at about 16 —
every region is outgrown by then — so a single night away can strand a character
above all of its content. The XP cutoff is correctly tuned for levels 1–15; it
is the accrual rate that overshoots. Extending the level range, steepening
`xpForLevel`, or lowering `OFFLINE.efficiency` so offline deliberately trails
live play are all one-line changes in `content.ts` — but which one is a design
decision, not a bug fix.
