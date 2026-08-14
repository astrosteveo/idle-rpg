# The character art pipeline

Use this pipeline to build an eight-facing sprite sheet for anything that moves and turns. It
drives the `$imagegen` skill through `codex exec`, so you'll need Codex installed and signed
in.

These docs follow the [Microsoft Writing Style Guide](https://learn.microsoft.com/style-guide/welcome/),
like the rest of the guides in this repository.

## Why the steps look like this

An image model keeps a character consistent within one picture and drifts between separate
ones. So the pipeline draws all eight facings together first, and every later step points
back at that one image.

A model also won't lay its work out on an even grid. Two runs that both asked for evenly
spaced frames came back at 483, 486, and 486 px, and at 151 px versus 209 px within the same
sheet. That's why no step here divides an image by a frame count. Each one finds the art by
its own pixels.

## The steps

```bash
# 1. All eight facings in one image. Pass a reference image as the fourth argument
#    to match a character that already exists.
tools/art/generate-turnaround.sh art/characters/wolf art/characters/wolf/desc.txt quadruped [ref.png]

# 2. Cut that image into one reference per facing.
node tools/art/cut-turnaround.mjs art/characters/wolf/turnaround.png /tmp/wolfwork

# 3. Generate the frames for each facing. Each one references its own cutout from
#    step 2, so the model only has to animate — it doesn't have to invent the
#    character. Run one process per facing to do them all at once.
tools/art/generate-strips.sh /tmp/wolfwork art/characters/wolf/desc.txt quadruped S W E N SE SW NE NW

# 4. Compose the sheet. Keep the strips: this step is repeatable and step 3 isn't.
cp /tmp/wolfwork/strip-*.png art/characters/wolf/
npm run atlas:characters art/characters/wolf/sheet.json
```

Then copy the grid the tool prints into `CHARACTER_SHEETS` in `src/assets/types.ts`, and add
the atlas to `ASSET_MANIFEST`. Startup compares the image against those numbers and fails if
they disagree.

Each character folder holds a `desc.txt` with one sentence describing the character, and a
`sheet.json` naming the output, the standing height in art pixels, the frame count, and the
strips.

## What the compose step does, and why

`tools/build-character-atlas.mjs`:

- **Finds seams at the emptiest column near each expected one.** Connected components is
  wrong here, because a raised sword is its own island of pixels and turns into an extra
  frame. Requiring fully empty columns is wrong too, because figures often touch.
- **Gives each facing its own scale.** A model draws each strip separately and picks its own
  size — a wolf seen head-on came out three times the size of the same wolf from the side. So
  every facing normalizes to the same standing height.
- **Stands each frame on its own sole**, meaning the lowest scanline wide enough to be a
  foot. That keeps a sword hanging below a boot from becoming the thing the figure stands on,
  and it stops a resting figure from hovering.
- **Averages by area when it shrinks.** The strips come out about seven times larger than the
  game draws them, and nearest sampling would throw away 50 of every 51 pixels. Color is
  averaged with alpha as the weight, or the transparent black outside the silhouette bleeds a
  dark fringe into every edge.
- **Writes rows in `facingToDir` order** and mirrors nothing, because mirroring puts a sword
  in the wrong hand.
- **Composes at the size the game draws**, so the runtime blits a cell 1:1 and resamples
  nothing.

If a strip comes back with fewer frames than you asked for, the tool says so and holds the
last pose for the remainder. A short strip that stayed quiet would look like a complete
animation that stutters.

## Troubleshooting

| What you see | Why | What to do |
| --- | --- | --- |
| `only N of M frames were drawn` | The model miscounted. | Rerun that facing. It usually gets it right the second time. |
| A floating shield or sword in a cell | A seam landed inside a figure. | Check the strip. The pitch estimate needs roughly even spacing. |
| One facing much larger than the others | Expected. Each strip is drawn at its own size. | Nothing — the tool corrects it. |
| A figure looks stretched at one angle | The model changed the posture. | Regenerate that facing and describe the body length in `desc.txt`. |
| Four walk frames that look identical | The prompt was too vague. | Already handled: `generate-strips.sh` spells out the mechanics of every frame. |

## Building other pipelines

The reusable pieces live in `tools/lib`. `png.mjs` reads and writes 8-bit RGBA with no
dependencies, and `segment.mjs` finds sprites, rows, and soles. A prop that has to sway or a
tree that has to move in wind needs the same two things this pipeline needed: one image for
consistency, and measurement instead of division.

`tools/measure-atlas.mjs` is the other half of the system. It measures the atlases a model
laid out that this project didn't compose — the enemies, the props, and the icons. Don't run
a composed sheet through it.
