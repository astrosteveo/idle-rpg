# Wildmarch production art generation

The four production atlases were generated with the built-in ImageGen tool in normal generation mode, using the approved desktop and mobile concepts as visual references. Flat green chroma backgrounds were removed locally with the ImageGen skill's alpha-cleanup helper; runtime rendering uses nearest-neighbor sampling and integer scale.

- `warrior-atlas.png`: rugged dark-fantasy pixel warrior, eight facing rows, four walk frames, three attack frames, plus portrait.
- `enemy-atlas.png`: wolf, bear, boar, spider, and raven families, each with ordinary, elite, boss, and attack poses.
- `support-atlas.png`: NPCs, campsite and wilderness props, corpses, combat effects, abilities, equipment icons, and portrait support art.
- `terrain-atlas.png`: seamless tiles for water, shallow water, sand, grass, lush grass, meadow, forest, dirt, road, gravel, rock, and snow.

Exact frame rectangles, anchors, animation rates, scales, and source dimensions are recorded in `src/assets/types.ts`. Startup rejects any missing or dimensionally invalid required atlas before constructing the simulation.
