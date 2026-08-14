# Server backend design

This page plans a **server-authoritative** backend for Wildmarch. The server owns the
simulation. The client sends input, draws what it's told, and decides nothing.

Today the game is entirely client-side: the simulation runs in the browser, the save lives in
`localStorage`, and nothing leaves the machine. Getting from there to here means changing the
simulation itself, not just adding a service in front of it. This page describes what changes,
what it costs, and the order to do it in.

Two numbers decide the shape of the plan, and both are measured rather than assumed. See
[What it costs to run](#what-it-costs-to-run) and
[The gap between the ledger and the game](#the-gap-between-the-ledger-and-the-game).

## What authority buys, and what it costs

**Buys:** the save stops being a claim. Progress, loot, and elapsed time become facts the
server produced. Nothing needs to be inferred from a save file, because no save file is ever
trusted — there's nothing to verify when the server rolled the dice itself. Ghosts, ladders,
and a shared world stop being reporting features and become readouts of state the server
already holds.

**Costs:** the simulation has to become something a server can host. Four properties it
doesn't have yet — a fixed timestep, randomness split by consequence, no dependency on the
view, and a wire format separate from its internal state. Plus a transport, a session
lifecycle, and client-side prediction so movement still feels immediate.

That's a real project. It is also almost entirely mechanical, and the client's existing
seams — an injected clock, an injected RNG factory, a command/event contract, a pure offline
ledger, a simulation that already never touches the DOM — mean none of it requires
re-architecting the game.

## The trap this design avoids

"Server-authoritative" is often conflated with "deterministic lockstep," and lockstep is where
projects of this kind die. It requires the client and server to compute bit-identical results,
which in JavaScript means fighting `Math.sin`, `Math.cos`, `Math.atan2`, and `Math.pow` —
none of which are specified to the last bit, and all of which differ between V8,
SpiderMonkey, and JavaScriptCore.

**Wildmarch does not need determinism, and the plan is built so it never does.** Three
reasons, all specific to this game:

- **There is no shared space.** Every player has their own world, seeded from one integer. No
  two clients ever need to agree on where a wolf is.
- **The client never decides anything.** It doesn't roll damage, pick loot, or run AI. If it
  computed a slightly different number it would have nowhere to put it.
- **Combat is automatic.** The player controls movement and two ability buttons. Nobody aims,
  so nobody notices 80 ms of latency on a wolf's approach.

So the client predicts **its own movement only**, and interpolates everything else from
snapshots. That's a small, well-defined piece of shared code — terrain collision and position
integration — rather than a bit-exact copy of the whole simulation.

## What it costs to run

The load-bearing question for any authoritative design is whether you can afford to run the
simulation for everyone at once. Measured, not estimated — `npm run bench` runs the game
headless with an injected clock, exactly as the server will.

| Tick rate | Cost per tick | Real-time factor | Simulations per core |
| --- | --- | --- | --- |
| 10 Hz | 0.046 ms | 2,194× | ~2,190 |
| **20 Hz** | **0.037 ms** | **1,358×** | **~1,360** |
| 30 Hz | 0.036 ms | 923× | ~920 |
| 60 Hz | 0.036 ms | 466× | ~470 |

Each run is ten simulated minutes of auto-battle that actually fights: 150–177 kills, level 9
to 11 by the end. Cost per tick is flat across rates, because it's dominated by iterating
roughly 120 beasts across 52 spawn nodes — so the tick rate is a straight trade against
capacity.

**20 Hz is the pick.** It's four times the fastest attack interval in the game, it costs
0.74 ms of CPU per simulated second, and it leaves an order of magnitude of headroom.

Treat these as an upper bound. They're single-threaded, on one machine, with no network I/O,
no serialization, and no GC pressure from either. Budget for a tenth of the theoretical
figure in production and one eight-core box still carries a four-figure concurrent player
count. **Authority is affordable here**, and the reason is that Wildmarch's world is small,
per-player, and resolved by rules rather than physics.

## The architecture

One simulation instance per active session. No shared entity space, no interest management
across players, no cross-session anything.

```
client                          server
------                          ------
input  ──── seq, dt, move ────▶  session
                                   │
render ◀─── snapshot deltas ────  simulation (20 Hz, authoritative)
  │                                │
  └─ movement predictor            └─ save / hibernate ──▶ Postgres
     (shared collision code)
```

### Three tiers of authority

An idle game can't keep a live simulation running for everyone forever — most players are
away most of the time, and simulating an empty room is pure cost. So authority degrades in
tiers, and the measurements above set the boundaries.

| Tier | When | How | Cost |
| --- | --- | --- | --- |
| **Live** | Connected | Real simulation at 20 Hz | 0.74 ms CPU per second |
| **Catch-up** | Reconnect within 15 minutes | Fast-forward the real simulation | 0.66 s CPU, once |
| **Ledger** | Longer absences, capped at 12 h | `runOfflineLedger()`, the rate model | Microseconds |

The catch-up tier is the one the measurements unlocked, and it's worth having. A dropped
connection on a train shouldn't hand you a different outcome than staying online, and at
1,358× real time, replaying fifteen minutes costs two thirds of a second. Beyond that the
rate model takes over, because a twelve-hour absence would cost 32 seconds of CPU to replay
and nobody is watching closely enough to justify it.

`runOfflineLedger()` survives this design unchanged in shape but changes in status. It stops
being a client-side estimate and becomes the definitive account of a long absence. That
promotion is why the next section matters.

## The gap between the ledger and the game

`OFFLINE.efficiency` is 0.72, and states the intent plainly: an hour away should be worth
about 0.72 of an hour played, the discount covering healing, pathing, and waiting on
respawns.

**Measured, it pays about half that, and the shortfall is stable.** Running the live
simulation for one hour and the ledger for the same hour, from the same save:

| Character | Live kills | Ledger kills | Ratio |
| --- | --- | --- | --- |
| Level 4, Greenwood Vale | 1,787 | 884 | 0.49× |
| Level 11, Greenwood Vale | 1,917 | 968 | 0.50× |
| Level 18, Wolfden Thicket | 1,982 | 1,006 | 0.51× |

Gold is worse and noisier — 0.16× to 0.27× — and experience worse still, though both are
confounded: auto-battle roams by quest objective rather than by the assigned ground, so the
live character drifts into richer regions and outlevels the one the ledger holds in place.
The kills column is the trustworthy one, and 0.49 / 0.50 / 0.51 across three levels and two
regions is too consistent to be roaming noise.

This is a live bug in the shipped game, not something the server introduces. But it gets
sharper under this design for two reasons:

- **The ledger becomes definitive.** Today it's an estimate a client applies to itself.
  Afterwards it's the server's account of your night.
- **The tier boundary becomes visible.** If catch-up pays full rate and the ledger pays half,
  then at the fifteen-minute mark the payout halves. Players find cliffs like that in about a
  day, and the optimal play becomes reconnecting every fourteen minutes.

`tests/unit/ledger-agreement.test.ts` gates this. It's a characterization test: it asserts
where the ratio sits today rather than where it should sit, because closing the gap is a
balance decision — raise the ledger's rate, or accept a lower number as the real intent —
and that's your call, not a bug fix. Both sides are fully deterministic, so any movement in
that test is a real change in the model.

**Fix this before Phase 3 ships**, because that's when the ledger stops being advisory.

## The rewrite

Eight items. Ordered by dependency, and each one is independently reviewable.

### R1. Fixed timestep

The simulation steps at exactly 20 Hz. The client accumulates real time into fixed steps and
renders with the leftover as an interpolation factor.

This **deletes** the `quantise()` median-filter in `src/main.ts` — the sampling buffer and
period estimation exist solely to stabilize a variable frame delta, and a fixed step makes
the whole heuristic unnecessary.

### R2. Split the randomness by consequence

`EcsSimulation.rand` is one stream serving both dice that matter and dice that don't. Damage
variance, crit rolls, loot, rarity, AI state transitions, wander points, and respawn jitter
share a sequence with float-text offsets, corpse lean, effect angles, and spark positions.

Split it in two:

- **`sim`** — anything that changes the outcome. Server-only, seeded per character, its
  position saved so a session resumes mid-stream.
- **`fx`** — anything only seen. Client-only, seeded from anything at all.

Roughly 25 call sites in `state.ts`, each needing a one-line classification. It's the most
invasive item and the most mechanical. It also pays off beyond the server: once cosmetic
draws stop perturbing the loot stream, the simulation becomes replayable for debugging.

### R3. Take the view out of the simulation

`setView()` feeds the camera rectangle into the simulation, and exactly one rule reads it:
`shouldGiveUp()`, which ends a chase when a beast is dragged off the visible screen.

That's a fairness bug independent of any server — an ultrawide monitor currently gets longer
chases than a phone. Replace the screen test with a fixed leash in world units. `setView()`
stays on the client as a rendering concern.

### R4. Separate simulation state from wire state

`Enemy` has 35 fields, most of them server-side bookkeeping the client never draws: `ax`,
`ay`, `wx`, `wy`, `aggroRange`, `leash`, `attackRange`, `stateT`, `windup`, `special`,
`deadT`, `nodeId`. Serialized naively it costs **582 bytes per beast**, and a full snapshot
of 122 beasts is **71 KB**. At 20 Hz that's 1.4 MB/s per player, which is absurd.

Define an `EnemyView` of about twelve fields — id, sheet, position, facing, health fraction,
state, animation phase, hit flash — quantized into roughly a dozen bytes. Scope it to an
interest radius rather than the whole world, and send deltas at 10 Hz rather than every tick.
Thirty visible beasts then costs about 3.6 KB/s. **The wire format is the real bottleneck in
this design, not the simulation**, and it's the one place worth spending effort on encoding.

### R5. Make the simulation host-agnostic

Mostly already true: no DOM, an injected clock, an injected RNG factory, and a `Simulation`
interface with commands, snapshots, and drained events. What remains is removing the last
implicit assumptions that a renderer is present, and moving `src/game` and `src/core` into a
package both sides import.

### R6. Transport and session lifecycle

WebSocket. Client sends batched input frames stamped with a sequence number; server replies
with snapshot deltas and the last input sequence it processed. Session states are
**connecting → live → draining → hibernated**, with hibernation serializing the character and
stopping the tick.

### R7. Client-side prediction, movement only

Extract position integration and terrain collision into a module both sides call. The client
keeps a ring buffer of unacknowledged inputs; when the server acknowledges a sequence number
with an authoritative position, the client rewinds and replays the rest.

Abilities are optimistic: the button lights, the cooldown starts, the animation plays, and
the server confirms or rejects. Damage numbers appear only when the server says so — fine,
because you aren't aiming.

Everything else interpolates between snapshots with about a 100 ms buffer.

### R8. Reconcile the ledger with the simulation

Covered above. It's listed here because it's a shipping requirement, not a nice-to-have.

## What survives from the client-authoritative plan

- **`readSave()` stays.** It's still the decoder for anything arriving from outside, and under
  authority the outside includes existing `localStorage` saves being imported.
- **`src/game/verify.ts` stays, retargeted.** Under full authority the server generates every
  item, so nothing needs verifying for anti-cheat. Two uses remain: validating imported saves
  at migration, and asserting internal invariants in tests, where it catches server bugs
  rather than cheaters. Its 19 tests keep earning their place.
- **The wall-clock apex schedule stays.** `bossWindow()` needs no server to agree across
  clients, and now the server can record who turned up.
- **The data model stays**, minus the anomaly table. Authority makes the audit trail for
  cheating unnecessary; keep `ledger_run` for support questions.

## The phases

Each ships alone and is worth having if the next never lands.

### Phase 0: extract the shared package

Move `src/game` and `src/core` into `packages/sim`; the client imports from it. No server, no
behavior change.

**Done when:** `npm run verify` passes and nothing in `packages/sim` imports from the client.

### Phase 1: make the simulation hostable

R1 through R5, in that order. Still no server — the game runs in the browser exactly as it
does now, on a fixed timestep, with split randomness, no view dependency, and a wire type it
doesn't yet use.

This is the rewrite, and it lands with the game playable at every step.

**Done when:** the browser game plays identically, `npm run bench` still reports its capacity,
and the simulation compiles with no reference to `window` or a view rectangle.

### Phase 2: the server runs the simulation

R6 and R7. Accounts, WebSocket sessions, one simulation per connection, prediction and
interpolation on the client. No offline handling yet: disconnect ends the session and the
character is saved where it stood.

**Done when:** you can play a full session with the simulation on the server and movement
still feels immediate.

### Phase 3: absence

Hibernation, the catch-up tier, and the ledger tier. R8 ships here or before.

**Done when:** a fifteen-minute disconnect resumes exactly, a twelve-hour one settles through
the ledger, and the payout at the boundary doesn't jump.

### Phase 4: the shared world

Ladders, an apex kill feed, and ghosts. All readouts of state the server already holds.

## Hazards

- **The tier boundary.** Covered above. Catch-up and ledger must pay comparably or players
  will farm the seam.
- **Hibernation must be atomic.** Serializing a character while a tick is in flight is how
  duplicated loot happens. Drain, then snapshot, then stop.
- **The RNG split is easy to get subtly wrong.** A draw classified as cosmetic that actually
  feeds an AI decision reintroduces a dependency between what's drawn and what happens. Review
  R2 call site by call site, not file by file.
- **Interpolation and the 12-hour cap don't compose.** A player watching an interpolated world
  when the session was settled by a rate model will see beasts pop into place. Settle first,
  then start the tick, then start streaming.
- **Content drift between client and server.** Hash the content tables at build time and refuse
  a session across a mismatch, asking the client to reload. Under authority this matters more,
  not less: the client's renderer indexes into the same tables.
- **The world seed is a constant.** `new World()` defaults to `20260812`. Store it per
  character from day one, even though it's the same for everybody today.
- **Prediction divergence on terrain.** The movement predictor and the server must share
  collision code exactly. If they drift, players rubber-band at walls — the one place in this
  design where a small numerical disagreement is visible.

## Decisions needed from you

| Decision | Assumed | If you disagree |
| --- | --- | --- |
| Tick rate | 20 Hz | 10 Hz doubles capacity and coarsens the fastest attack interval; 30 Hz costs a third of capacity for little visible gain. |
| Catch-up window | 15 minutes | Longer is affordable as a background job but widens the window where a stale client is showing an old world. |
| Closing the ledger gap | Raise the ledger's rate to meet the intended 0.72 | Lowering `OFFLINE.efficiency` to match reality is equally valid and cheaper, but makes idling meaningfully worse. |
| Sign-in | Anonymous device account, optional email link later | Requiring email up front simplifies recovery and costs you players. |
| Existing saves | Import them once, validated by `verify.ts` | Starting everyone fresh is simpler and throws away real characters. |
| Wire encoding | Binary, quantized, interest-scoped | JSON is simpler and costs roughly 40× the bandwidth. |

## Measurements in this repo

Both numbers this plan rests on are reproducible.

```bash
npm run bench     # capacity: ms per tick, simulations per core, snapshot size
npm test          # includes tests/unit/ledger-agreement.test.ts
```
