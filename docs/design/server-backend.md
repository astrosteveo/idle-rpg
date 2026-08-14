# Server backend design

This page plans the server for Wildmarch. Today the game is entirely client-side: the
simulation runs in the browser, the save lives in `localStorage`, and nothing leaves the
machine. This page describes what a server should own, what it can't own without a rewrite,
and the order to build it in.

Read [What the client already gives you](#what-the-client-already-gives-you) before the
phases. Most of the hard work is already done, and the plan depends on which parts.

## What the backend is for

Three goals, in the order they pay off:

1. **Your character follows you.** Play on a phone at lunch and a desktop at night, same
   character. This is the reason most players will notice a server exists.
2. **Time accrues honestly.** An idle game's core promise is that the world moves while
   you're away. Right now that promise is kept by your own clock, which you can set to
   whatever you like.
3. **The world is shared.** Apex beasts already walk on a schedule every client agrees on.
   Once there's a server, that schedule can carry a kill feed, ladders, and the ghosts of
   other players hunting the same ground.

Explicit non-goals for the first release:

- **No real-time multiplayer.** No shared combat, no player collision, no synchronized
  positions. See [Why the live simulation can't move to the server](#why-the-live-simulation-cant-move-to-the-server).
- **No trading or player-to-player item transfer.** Every anti-cheat property below assumes
  items are generated for one character and never move. Trading turns a tolerable cheat into
  an economy-wide one.
- **No password forms on first launch.** An idle game that asks you to sign up before you
  swing a sword loses most of its players at the sign-up.

## What the client already gives you

The client was built with this move in mind, and it shows. These are the seams you get for
free.

| Seam | Where | Why it matters |
| --- | --- | --- |
| One file knows about storage | `src/ui/storage.ts` | Swapping `localStorage` for HTTP touches nothing in the simulation. |
| The save is a plain object | `EcsSimulation.serialize()` in `src/game/state.ts` | The wire format already exists. You don't have to invent one. |
| The save decoder rejects everything it doesn't recognize | `readSave()` in `src/game/save.ts` | This is already a server-grade input validator, field by field, with bounds. Lift it verbatim. |
| The clock is injected | `SimulationDependencies.clock` | The server can hand the simulation its own time instead of the device's. |
| Randomness is injected | `SimulationDependencies.rngFactory` | Any server-side roll is reproducible from a seed you store. |
| The offline ledger is pure | `runOfflineLedger()` in `src/game/offline.ts` | No DOM, no clock of its own, no `Game`. It runs on a server today, unmodified. |
| The world is a seed | `World` in `src/game/world.ts` | The server stores one integer, not a map. Terrain, camps, dens, and landmarks all derive. |
| Apex schedules are wall-clock | `bossWindow()` in `src/game/content.ts` | Every client already agrees on when an apex walks. The server doesn't have to broadcast a schedule, only record who turned up. |

The comment at the top of `offline.ts` says the ledger is "the piece a server runs to settle
a character's absence." That's exactly the plan below.

## Why the live simulation can't move to the server

The moment-to-moment combat simulation is **not** replayable, and it can't be made
authoritative without a rewrite. Three reasons, all load-bearing:

- **One RNG stream serves everything.** `EcsSimulation.rand` is consumed by combat damage
  variance, by loot rolls, and also by float-text offsets, corpse lean, and beast wander
  points (`src/game/state.ts`). Cosmetic draws and consequential draws advance the same
  sequence, so any difference in what got drawn changes what drops.
- **Frame timing feeds the simulation.** `beginFrameLoop` in `src/main.ts` quantizes the real
  frame delta and passes it to `update()`. A 60 Hz client and a 144 Hz client take different
  numbers of steps, so they make different numbers of `rand()` calls.
- **The view rectangle reaches the simulation.** `setView()` passes the camera to the
  simulation. Anything that varies with window size can't be reproduced from inputs alone.

Making the live loop authoritative means separating cosmetic randomness from consequential
randomness, moving to a fixed timestep, and removing the view from the simulation's inputs.
That's a real project, and it buys you a property this game doesn't need yet.

**Design the server so it never needs that property.**

## The trust model: verify, don't simulate

The server doesn't re-run combat. It checks that the save a client hands back could have come
from an honest game. Three tiers, from strongest to weakest.

### Tier 1: exact invariants

These are closed-form facts about a legal save. Any violation is proof of tampering, not a
signal, so the server can reject outright.

- **Items match their generator.** `makeItem()` in `src/game/loot.ts` is nearly deterministic
  given `(base, ilvl, rarity)`. The `value` field is exactly
  `round(base.value + ilvl * 3.4 + rarity * 22)`. A weapon's `dmg` is exactly
  `round(base.dmg * ilvl + 3 + rarity * 2.2)`. The affix count equals the rarity, drawn
  without replacement from a four-key pool, and each magnitude falls in a ±25% band around
  `1.1 + ilvl * 0.38 + rarity * 0.5`. Relics from `makeUnique()` are fully closed-form and
  always have `value === 0` and `rarity === 4`. **This is the strongest check available**, and
  it kills the dominant attack on a game like this — editing your gear in devtools.

  Measured against the implementation in `src/game/verify.ts`: damage, armour, and value lines
  are exact, so any edit to them is caught. Affix magnitudes are the only soft spot, and an
  inflated affix is caught at 1.3× on average, at 1.6× across most of the level range, and
  always by 2.3×. A cheater's entire remaining budget is a fraction of one affix line on one
  item — which is not worth their trouble or yours.
- **Experience matches level.** `xpNext` must equal `xpForLevel(level)` and `xp` must be less
  than it. Both from `src/game/content.ts`.
- **Talents match level.** You get one pick per unlocked row, so `talents.length` can't exceed
  the number of rows in `TALENT_ROWS` whose `level` you've reached, and no two picks can come
  from the same row.
- **Milestones match counters.** Every id in `claimed` has a `metric` and a `threshold` in
  `MILESTONES`. The character's counters must actually meet it.
- **Apex kills match the clock.** `bossCleared[id]` stores a boss window. No stored window may
  exceed `bossWindow(serverNow)`, and it may advance by at most one window per elapsed period.
  This is an exact bound on the largest single lump of experience in the game.
- **Monotonic fields only grow.** Kills, gold earned, quest index, discovered camps, seen
  landmarks, and found relics never decrease. A save that moves one backwards is either a
  rollback attack or a bug worth knowing about.

### Tier 2: rate ceilings

`killsPerHour()` in `src/game/offline.ts` already computes how fast a given build kills a
given species. The server reuses it as a cheat oracle: derive stats from the **previously
stored** save, compute the best rate that build could achieve on the best ground it can
reach, multiply by elapsed wall-clock seconds, and add a generous headroom factor. Claimed
kills, experience, and gold above that ceiling get flagged.

The ledger's own rate already discounts by `OFFLINE.efficiency` (0.72) for healing, pathing,
and respawn waits. Live play beats that, so the ceiling needs headroom — start around 3× and
tune it against real data.

This tier is a signal, not proof. Run it in shadow mode first: record, don't reject.

### Tier 3: the clock

The server stamps `savedAt` itself and ignores the client's. That single change makes the
offline ledger honest, because the ledger is a pure function of elapsed time and the client no
longer gets a vote on elapsed time.

## Stack and layout

**Use TypeScript on both sides and share the simulation as a package.** This isn't a
preference, it's a constraint: `src/game/content.ts` is 1,551 lines of tuning tables, and the
server's ledger has to produce the same numbers as the client's estimate, forever. Any second
implementation drifts, and every drift is a payout bug. The game code is already pure
TypeScript with no runtime dependencies, so lifting it costs almost nothing.

```
packages/
  sim/          the current src/game and src/core, unchanged
                content, world, save, offline, loot, types, math
  client/       the current src/render, src/ui, src/main, src/assets
  server/       new
apps/           (nothing yet)
```

Everything else follows from that:

- **Runtime:** Node with Fastify. Small, fast, and it doesn't argue about TypeScript.
- **Database:** Postgres. The save is a JSON document, but the surrounding records
  (accounts, audit trail, ladders) are relational and you'll want real queries over them.
  A document store buys nothing here.
- **Sessions:** an opaque refresh token in `localStorage`, short-lived access tokens on
  requests. No cookies, so the client stays a static bundle you can host anywhere.

## Data model

```sql
account(
  id            uuid primary key,
  created_at    timestamptz,
  email         text unique null,      -- null until the player links one
  email_verified boolean
)

credential(
  account_id    uuid references account,
  kind          text,                  -- 'device' | 'email' | 'oauth'
  secret_hash   text,
  created_at    timestamptz,
  last_used_at  timestamptz
)

character(
  id              uuid primary key,
  account_id      uuid references account,
  world_seed      bigint,              -- currently the constant 20260812
  save            jsonb,               -- exactly what serialize() produces
  save_version    int,                 -- SAVE_VERSION
  content_hash    text,                -- see the hazard below
  server_saved_at timestamptz,         -- the server's clock, the only one that counts
  settled_at      timestamptz,         -- last time the ledger ran
  revision        bigint,              -- increments on every accepted write
  updated_at      timestamptz
)

ledger_run(
  id               bigserial,
  character_id     uuid references character,
  credited_seconds int,
  kills            int,
  xp               bigint,
  gold             bigint,
  capped           boolean,
  created_at       timestamptz
)

anomaly(
  id           bigserial,
  character_id uuid references character,
  tier         int,                    -- 1 = proof, 2 = signal
  kind         text,                   -- 'item-stats' | 'rate-xp' | 'boss-window' | ...
  observed     jsonb,
  allowed      jsonb,
  created_at   timestamptz
)
```

`ledger_run` and `anomaly` are the audit trail. You'll want both the first time someone
reports lost progress, and the second one is how you tune Tier 2 before it rejects anything.

## API surface

Small on purpose. The client stays a simulation that occasionally syncs.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/session` | Create an anonymous account and character, or refresh a token. Returns the character and the offline report. |
| `POST` | `/v1/session/link` | Attach an email or OAuth identity to an existing anonymous account. |
| `GET` | `/v1/character` | Fetch the current save, with the ledger already settled against the server clock. |
| `PUT` | `/v1/character` | Upload a save. Requires the `revision` you last read. Returns the new revision. |
| `GET` | `/v1/ladder/:metric` | Ranked characters by level, kills, or apex clears. Phase 4. |
| `GET` | `/v1/world/bosses` | The current window, and who has cleared each apex in it. Phase 4. |

Two rules that keep this honest:

- **`PUT` carries the revision you read.** A stale revision means another device wrote first.
  Return 409 with the winning save and let the client re-hydrate. Never merge two saves —
  merging item bags silently duplicates gear.
- **The body cap is 64 KB.** A legal save is a bounded structure: 40 bag slots, 6 equipment
  slots, and a fixed set of id arrays. It can't legitimately grow past a few kilobytes.

## The phases

### Phase 0: extract the shared package

Move `src/game` and `src/core` into `packages/sim` and have the client import from it. No
server, no behavior change. The existing suites — `tests/unit/*` and the Playwright smoke
test — are the acceptance criteria: they all pass, unchanged.

Do this first and alone. It's the only step that touches the whole tree, and doing it while
also writing a server means every failure has two possible causes.

**Done when:** `npm run verify` passes and no file under `packages/sim` imports from
`packages/client`.

### Phase 1: accounts and cloud saves

Anonymous account on first launch. `storage.ts` gains a remote implementation behind the same
three functions it already exports. Keep the local save as a write-through cache so the game
still runs with the network down — an idle game that white-screens on a dropped connection is
worse than one with no server at all.

The server validates every upload with `readSave()` and stores it. No ledger yet, no rate
checks yet.

**Done when:** you can level a character on one browser, open another, and continue it.

### Phase 2: the ledger moves to the server

`GET /v1/character` runs `runOfflineLedger()` using `server_saved_at` and the server's clock,
applies the report, stores the result, and returns both the save and the report for the client
to display.

**Remove the client-side call in `src/main.ts` in the same change.** Two appliers means double
credit, and double credit that only reproduces after a real absence is a miserable bug to
find.

**Done when:** setting your device clock forward a day earns you nothing.

### Phase 3: verification

Implement Tier 1 and Tier 2 as a validation pass over every accepted upload. Ship Tier 1 as a
rejection and Tier 2 as a shadow-mode record. Watch `anomaly` for a few weeks, tune the
headroom, then decide whether Tier 2 rejects, clamps, or just flags an account.

**Done when:** a save with hand-edited gear is rejected, and the false-positive rate on Tier 2
is low enough to act on.

### Phase 4: the shared world

Ladders, an apex kill feed, and — the one the ledger was written for — ghosts. The comment in
`offline.ts` notes that a ghost's visible behavior is "a dramatisation" of the ledger. That's
the cheapest multiplayer this design can offer: you already know what another character killed
last night and where, so you can show them doing it without simulating anything.

## Hazards

Each of these is cheap to handle now and expensive to discover later.

- **Double-credited offline time.** Covered in Phase 2. Exactly one applier, always.
- **Item uid collisions.** `nextUid` is a per-save counter (`UidSequence` in `loot.ts`). Two
  devices that diverge and later reconcile can hold two different items with the same uid.
  Revision-checked writes prevent divergence in the first place, which is why Phase 1 needs
  them even before there's anything to cheat.
- **Content drift.** `readSave()` validates item bases, talents, milestones, and relics
  against the tables in `content.ts`. If the server runs a different build from the client,
  a legal save can be rejected — or worse, a payout can differ. Hash the content tables at
  build time, store the hash with the save, and refuse to settle a ledger across a mismatch.
  Ask the client to reload instead.
- **The world seed is a constant.** `new World()` defaults to `20260812`, and `readSave()`
  rejects any save whose seed doesn't match. Store the seed per character from day one, even
  though it's the same value for everybody today. Retrofitting it once players exist means a
  migration over live saves.
- **The 12-hour cap and lazy settling.** `OFFLINE.capHours` is 12. If the server settles only
  when you log in, a three-day absence still credits 12 hours, which is intended. But a ladder
  that reads stored values will show absent players frozen. Project their pending accrual at
  read time rather than ticking every character on a cron.
- **Quota and offline failures must never interrupt play.** `storage.ts` already swallows
  storage errors for this reason. The remote implementation needs the same discipline: a
  failed sync retries, it doesn't surface a modal.

## Decisions needed from you

These change the plan materially, and I've assumed an answer for each so the work can start.

| Decision | Assumed | If you disagree |
| --- | --- | --- |
| How far does this go? | Through Phase 4, built in order, each phase shippable alone. | Stopping at Phase 2 removes the need for Tier 1 and Tier 2 entirely. |
| Sign-in | Anonymous device account first, optional email link later. | Requiring email up front simplifies account recovery and costs you players. |
| Hosting | A single region, one Node process, managed Postgres. | Multi-region means the wall-clock apex schedule needs a defined authority for kill credit. |
| One character per account | Yes, matching the current game. | Multiple characters is a schema-only change now and a migration later. |
| Cheating consequences | Flag and record. No bans, no rollbacks, at first. | Rejecting Tier 2 immediately will cost honest players progress while the headroom is untuned. |

## What's already proven

`src/game/verify.ts` implements the Tier 1 item check described above, and
`tests/unit/verify.test.ts` runs it against thousands of generated items and a set of
tampered ones. It's a spike, not the server: it exists so the load-bearing claim of this
design — that hand-edited gear is detectable without simulating anything — is a measured
result rather than an assertion.
