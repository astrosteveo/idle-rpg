# How the Wildmarch art was generated

Every sprite in the game comes from an image model. Nothing is hand-drawn and nothing is
drawn in code at runtime. This page records what each asset is and how it was made.

The assets fall into two groups, and the difference matters: one group this project composed
itself, so its grids are exact, and one group a model laid out, so its contents have to be
measured.

## Composed character sheets

These are built by `tools/art/`, which generates eight facings and composes them onto a grid
at the size the game draws. See [tools/art/README.md](../../tools/art/README.md) for the
steps.

| Asset | What it holds |
| --- | --- |
| `warrior-atlas-8dir.png` | The Warrior: 8 facings × 7 frames (4 walk, 3 sword swing). |
| `wolf-atlas-8dir.png` | The grey wolf: 8 facings × 6 frames (4 walk, wind-up, attack). |
| `warrior-portrait.png` | The Warrior's face, for the HUD. |

Each facing was drawn at its own angle, so nothing is mirrored. Mirroring would put the
Warrior's sword in his left hand and his shield on his right arm.

The source art for these — the turnaround and all eight strips — is committed under
`art/characters/`, so the atlases rebuild from it exactly. Generation isn't reproducible, but
composition is.

## Model-authored atlases

These were generated in single passes with the built-in ImageGen tool, using the approved
desktop and mobile concepts as visual references. Flat chroma backgrounds were removed
locally with the ImageGen skill's alpha-cleanup helper.

| Asset | What it holds |
| --- | --- |
| `enemy-atlas.png` | Wolf, bear, boar, spider, and raven families, each with ordinary, elite, and boss poses plus an attack. |
| `support-atlas.png` | NPCs, campsite and wilderness props, corpses, combat effects, ability icons, and equipment icons. |
| `terrain-atlas.png` | Seamless tiles for water, shallow water, sand, grass, lush grass, meadow, forest, dirt, road, gravel, rock, and snow. |

A model doesn't lay sprites out on a grid that divides evenly, so `tools/measure-atlas.mjs`
finds each one by its own pixels and records the rectangles in `src/assets/frames.ts`. Run
`npm run atlas:measure` after changing any of these and commit the result.

The enemy atlas holds only two poses per beast, an idle and an attack. It has no walk cycle,
which is why beasts other than the wolf can't animate their walk yet.

## Rendering

Runtime rendering uses nearest-neighbor sampling at integer scale. Composed sheets are
already at render resolution, so the runtime blits them 1:1 without resampling.

`ASSET_MANIFEST` in `src/assets/types.ts` lists every asset with the exact size it must have,
and `CHARACTER_SHEETS` records the grid of each composed sheet. Startup rejects a missing or
wrong-sized asset before it builds the simulation.
