# The character art pipeline

This makes an 8-facing sprite sheet for anything that moves and turns. It uses
the `$imagegen` skill through `codex exec`, so Codex must be installed and
logged in.

This file uses ASD-STE100, like the rest of the guides in this repository.

## Why it has these steps

An image model holds a character together inside one picture. It drifts between
separate pictures. Thus the pipeline draws all 8 facings together first, and
every later step points back at that one image.

An image model also does not lay its work out on an even grid. Two runs that
both asked for evenly spaced frames came back at 483, 486, 486 px and at 151 px
against 209 px in the same sheet. Thus no step divides an image by a frame
count. Each step finds the art by its own pixels.

## The steps

```bash
# 1. All 8 facings in one image. Give a reference image as the 4th argument to
#    match a character that already exists.
tools/art/generate-turnaround.sh art/characters/wolf art/characters/wolf/desc.txt quadruped [ref.png]

# 2. Cut that image into one reference for each facing.
node tools/art/cut-turnaround.mjs art/characters/wolf/turnaround.png /tmp/wolfwork

# 3. The frames for each facing. Each one refers to its own reference from
#    step 2, thus the model only animates; it does not invent the character.
#    Start one process for each facing to run them at the same time.
tools/art/generate-strips.sh /tmp/wolfwork art/characters/wolf/desc.txt quadruped S W E N SE SW NE NW

# 4. Compose the sheet. Keep the strips, because this step is repeatable and
#    step 3 is not.
cp /tmp/wolfwork/strip-*.png art/characters/wolf/
npm run atlas:characters art/characters/wolf/sheet.json
```

Then put the grid the tool prints into `CHARACTER_SHEETS` in
`src/assets/types.ts`, and add the atlas to `ASSET_MANIFEST`. Start-up compares
the image against those numbers and stops if they disagree.

A `desc.txt` holds one sentence that names the character. `sheet.json` names the
output, the standing height in art pixels, the frame count, and the strips.

## What the compose step does, and why

`tools/build-character-atlas.mjs`:

- **Finds the seams at the emptiest column near each expected one.** Connected
  components is wrong here, because a raised sword is its own island of pixels
  and becomes an extra frame. Whole empty columns are wrong too, because
  figures often touch.
- **Gives each facing its own scale.** A model draws each strip on its own and
  picks its own size. A wolf seen head-on came out three times the size of the
  same wolf from the side. Each facing normalises to the same standing height.
- **Stands each frame on its own sole**, which is the lowest scanline wide
  enough to be a foot. Thus a sword that hangs below a boot does not become the
  thing the figure stands on, and a figure at rest never hovers.
- **Averages the area when it reduces.** The strips come out about seven times
  larger than the game draws them. Nearest sampling would throw away fifty of
  every fifty-one pixels. Colour is averaged with alpha as the weight, or the
  transparent black outside the silhouette bleeds a dark fringe into each edge.
- **Writes rows in `facingToDir` order** and mirrors nothing. A mirror puts a
  sword in the wrong hand.
- **Composes at the size the game draws at.** Thus the runtime blits a cell one
  to one and resamples nothing.

It says so when a strip came back with fewer frames than asked. It holds the
last pose for the rest, because a short strip that said nothing would look like
a complete animation that stutters.

## What goes wrong, and what to do

| What you see | Why | What to do |
| --- | --- | --- |
| "only N of M frames were drawn" | The model miscounted. | Run that facing again. It usually obeys the second time. |
| A floating shield or sword in a cell | A seam fell inside a figure. | Check the strip. The pitch guess needs even spacing. |
| One facing is much larger than the others | Normal. Each strip is drawn at its own size. | Nothing. The tool corrects it. |
| A figure looks stretched at one angle | The model changed the posture. | Regenerate that facing. Name the body length in `desc.txt`. |
| Four walk frames look the same | The prompt was too loose. | Already handled: `generate-strips.sh` names the mechanics of every frame. |

## Other pipelines

The parts worth reusing are in `tools/lib`: `png.mjs` reads and writes 8-bit
RGBA with no dependency, and `segment.mjs` finds sprites, rows and soles. A prop
that must sway or a tree that must move in wind needs the same two things this
one needed: one image for consistency, and measurement instead of division.

`tools/measure-atlas.mjs` is the other half. It measures the atlases that a
model laid out, which this project did not compose: the enemies, the props and
the icons. Do not put a composed sheet through it.
