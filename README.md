# Wildmarch

A top-down idle action-RPG vertical slice. Canvas-rendered pixel art, a virtual
joystick, auto-battle, five species in territories that make sense, world bosses
on a clock everybody shares, a quest chain, loot that drops straight into your
bag, and milestone rewards you claim by hand.

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
| Talents | `T` | **Talents** |
| Bestiary | `B` | **Beasts** |
| Hunting grounds | `H` | **Hunt** |
| Toggle auto-equip | `F` | Button inside the Inventory panel |
| Close a panel | `Esc` | **Close** |

Attacks fire on their own whenever a beast is inside your swing arc — the
warrior never waits for a button. In the inventory, click an item to equip it
and right-click to sell it.

## What is in the slice

**World.** 148x148 tiles (~4700px square), generated from one seed. Six regions
with distinct terrain and inhabitants — Greenwood Vale (wolves, levels 1–3),
Wolfden Thicket (wolves and alphas, 4–8), Thornfell Downs (boars, 5–9),
Stonewatch Ridge (bears and elders, 6–11), Mirefen Hollow (spiders, 10–14) and
Ravencrag (rooks, 14–18) — joined by roads between six camps, with seven named
landmarks scattered through them.

**Species are behaviours, not statlines.** A wolf and a bear close the distance
and bite. A **boar** squares up at range, paws the ground once and then commits
to a straight run that cannot steer — step out of the line and it has to turn
around and start again. A **spider**'s every bite leaves webbing that halves
your stride for a couple of seconds, so what it takes from you is the ability to
disengage. A **rook**'s entire flock breaks off the moment one of them is hit
and re-forms a second later from another side, which is what Whirlwind is for.
Each is deliberately answerable, and each is a rule a bigger health bar could
never have been.

**World bosses.** Five apex beasts, one to a species, each holding the landmark
its kind is named for — the Greytooth at the Hollow Oak, the Thornfell Sow on
the Bonefield, Stonebrow at the Wind Altar, the Widow at the Drowned Chapel, the
Gallows King on the Rookstone. A new window opens every 30 minutes on a schedule
derived from wall-clock time, so it is the same schedule for every player: "it
holds the Hollow Oak on the half hour" is knowledge worth passing on. Auto-battle
will not pick a fight with one — walking up to an apex is your decision — and
they carry relics at 45% against an ordinary elite's 8%.

**Named places.** Regions have names; now so do places inside them. Each landmark
is actually built on the ground — a cairn piled, a hall left in three walls, a
clearing ringed in oaks — puts its name in the HUD with its region underneath,
and marks itself on the minimap once you have stood in it. It grants nothing.
The value of a named place is that you can tell someone else about it.

**Intentional spawns.** Enemies do not sprinkle uniformly. Each region seeds a
set of *spawn nodes* — wolf dens holding packs of 3–5, bear grounds holding one
or two, roosts holding four to six rooks — placed on dry ground, away from the
roads and well clear of the camps. Elite nodes are placed first, because they
demand the most clearance and a crowded region will otherwise fill up on
ordinary dens and fit none of them. Every beast is anchored to its node, wanders
inside its territory, and respawns there.

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
higher than what you are wearing — except relics, which it will neither equip
nor replace.

**Talents.** Five rows unlocking at levels 2, 5, 8, 11 and 14, three choices each, one pick
per row. They specialise something you already do — how you swing, how Whirlwind behaves,
how you recover, how you finish — rather than trickling more stats. A pick is final until
you retrain, which costs 120 gold per level and is the only real drain on the purse in the
game.

**Relics.** Nine unique items, each changing a rule instead of a number: Whirlwind leaving
burning ground, every kill restoring health or returning Second Wind, a guaranteed crit on
anything unwounded, double damage to one species and less to everything else, a faster
stride that shakes pursuit sooner, a cap on the largest single blow anything may land,
immunity to webbing, and a Whirlwind that pays for itself off a big enough flock. Three
slots now hold two relics each, so wearing one is a choice inside the choice. Their base
stats are roughly
half an ordinary item's *on purpose* — `itemScore` cannot rank a rule, so a relic that also
won on stats would be equipped automatically and decide nothing. They sit outside auto-equip
in both directions, cannot be sold, and never drop twice. Elites carry them, awake or
offline.

**Bestiary and mastery.** Every kill is already counted, so mastery is free content on data
the game was keeping anyway: four tiers per species at 25, 100, 300 and 750 kills, each
sharpening what you do to that species and blunting what it does back. The panel doubles as
the relic index — undiscovered ones show only their slot.

**Quests.** A fourteen-step chain, tracked on the HUD, auto-turning-in as you
complete each: cull wolves, find the camps, clear bears off the ridge, kill
elites, then south to Thornfell, east into Mirefen, north to the crag, and
finally an apex.

**Milestone rewards.** Eighteen claimable milestones across kills, per-species
kills, elites, world bosses, gold earned, level and quests completed. They sit in
the Rewards panel with a badge on the button when something is ready, and you
press **Claim** to take the payout.

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
and rects — haunch, barrel, chest, snout, four legs — so a wolf, a bear and a
boar all come out of the same routine with different numbers, and the elite and
world-boss variants are the same body at a larger scale with a different
palette. A spider and a rook get their own trio of routines, because eight legs
and a wingbeat are not parameters a quadruped has any use for. A
silhouette-outlining pass over each finished frame is what makes the results
read as deliberate sprites rather than blobs.

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

One class (Warrior), no vendors, no crafting, no sound. World bosses cannot be
fought while you are away — the ledger is a rate model and does not know about
them, which is deliberate: an apex is a reason to actually be present. Saves are
local only — there is no server, and no multiplayer.

**Known balance gap.** The offline ledger is faithful to live play (about two
thirds of the measured hands-on kill rate), but the XP curve was tuned for short
sessions. Tier III moved the ceiling a long way — the three new regions carry
levelling ground from 11 up to 18, and with `xpScale`'s eight-level cutoff a
character can be paid all the way to about 24 — so a night away no longer
*strands* anyone above all of their content. It still overshoots: six measured
hours in Ravencrag takes a level 12 character to 24 in one sitting. Steepening
`xpForLevel` or lowering `OFFLINE.efficiency` so offline deliberately trails live
play are both one-line changes in `content.ts` — but which one is a design
decision, not a bug fix.
