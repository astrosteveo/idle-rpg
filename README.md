# Wildmarch

A vertical slice of a top-down idle action RPG. It runs in a browser, draws to a canvas, and
keeps your character on your own machine.

![The camp at Hearthglen](docs/screenshots/camp.png)

## What you get

You play a single Warrior in a seeded world of six regions. Auto-battle hunts for you, so
the game keeps going whether you're driving it or watching it. When you come back, a ledger
steps through the time you were away in slices and works out what you would have killed.

- **Six regions**, from Greenwood Vale out to the apex grounds, each with its own level band
  and its own dens.
- **Five species with four behaviors** — wolves stalk, boars charge, spiders web, and rooks
  flock and scatter.
- **A chain of tasks** handed out by people who wait in the camps for you to talk to them.
- **Relics, talents, and beast mastery**, all folded into one bag of modifiers, so the live
  game and the offline ledger always agree.
- **World bosses on a wall clock** instead of a respawn timer, so every client agrees on when
  an apex beast walks.

![Auto-battle in Greenwood Vale](docs/screenshots/combat.png)

## Run it

```bash
npm install
npm run dev        # http://localhost:5173, open to the LAN and to mobile
```

You'll also want:

```bash
npm run verify     # typecheck, lint, unit tests, build, browser tests
npm test           # vitest
npm run build      # a production bundle in dist/
```

Move with WASD or by dragging the left half of the screen. Space toggles auto-battle, Q and
E fire your abilities, and G talks to whoever you're standing next to.

## It works on a phone

The HUD collapses, the ability buttons grow, and the lower left of the screen becomes a
thumbstick.

<img src="docs/screenshots/mobile.png" alt="Wildmarch running on a phone" width="320">

## How it's built

TypeScript, Vite, and a canvas. No runtime dependencies apart from two fonts.

```
src/
  main.ts        the frame loop
  core/          math, seeded noise, input
  game/          the simulation, all tuning, the save schema, the offline ledger
  render/        the pixel pipeline, terrain, sprites, the bitmap font
  ui/            the HUD overlay and the only file that knows about localStorage
tools/           the art pipelines
art/             the source art those pipelines compose from
```

The simulation never touches the DOM, and the renderer only draws to the canvas. A single
channel connects them, and exactly one file knows about storage — because the save schema
has to survive a move to a server.

![The talent tree](docs/screenshots/talents.png)

### The art pipeline

Every sprite is composed from generated art by the tools in `tools/`. The rule that matters:
**never divide an atlas, measure it.** Art from an image model doesn't land on a grid that
divides evenly, and no prompt makes it — one run asked for evenly spaced frames and came back
at 483, 486, and 486 px.

`tools/art/` builds character sheets with eight facings, one row each, so nothing ever gets
mirrored. Mirroring puts a sword in the wrong hand. For the full walkthrough and the traps
worth knowing about, see [tools/art/README.md](tools/art/README.md).

`CLAUDE.md` documents the rules the code depends on and the reason behind each one. Read it
before you touch the frame loop, the pixel pipeline, or anything that decides when a beast
breaks off a chase.

## Where the project stands

This is a prototype. The world, the loop, the loot, the tasks, and the ledger all work end to
end. The art is at prototype fidelity: the warrior and the wolf have full eight-facing
sheets, and the other four species still use a single side view until their sheets get built.
