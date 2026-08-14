# Server backend design

This page plans a **server-authoritative backend for a mini-MMO**: a shared world where you
see other players, group with them, run dungeons together, and pick a class. The server owns
the simulation. The client sends input, draws what it's told, and decides nothing.

Today the game is a single-player browser client: one Warrior, two hardcoded abilities, one
map, and a save in `localStorage`. Getting from there to here changes the simulation itself,
not just what's in front of it.

Three measurements shape the plan, all reproducible in this repo. See
[What it costs to run](#what-it-costs-to-run),
[The gap between the ledger and the game](#the-gap-between-the-ledger-and-the-game), and the
per-beast wire cost in [R4](#r4-separate-simulation-state-from-wire-state).

## What "mini-MMO" has to mean here

An MMO feels like an MMO because of five things. Only three of them need a shared simulation,
and separating them is what keeps this affordable.

| Feature | Needs shared simulation? | How it's served |
| --- | --- | --- |
| Seeing other players in the world | **No** | A presence layer: broadcast positions, no shared sim |
| Chat, guilds, ladders | **No** | Ordinary services over stored state |
| Grouping and fighting together | **Yes** | One simulation per party |
| Dungeons | **Yes** | One simulation per party, on an instanced map |
| World bosses | **Yes** | The one contested surface — see below |

So the unit of simulation is **a party**, and a solo player is a party of one. That single
decision carries most of this design.

### The contention problem, and why beasts belong to the party

There's a conflict between "idle" and "shared world" that has to be settled before anything
else, because it decides the whole architecture.

**In an idle auto-battler, shared mob spawns are hostile to the core loop.** Your income is
kills per hour. If another player's auto-battle competes for the same wolves, your rate drops
through no decision of yours, while you aren't even watching. Real MMOs resolve that with
tagging rules, competition, and player skill. None of those apply when nobody is at the
keyboard.

So the line is:

- **Beasts are party-scoped.** The wolves you fight are yours. No contention, ever.
- **Players are world-shared.** You see everyone, in the same seeded world, at the same
  landmarks. You can walk up to someone and group with them.
- **Apex beasts are contested.** They already stand on a wall clock every client agrees on,
  and turning up on time is the entire point of them. This is the one place shared combat is
  the feature rather than the bug.
- **Dungeons are private to the party** by definition.

This is phasing, and it's what mobile MMOs do. You get the social world without the resource
war, and it costs nothing extra: a party's simulation is exactly the simulation this game
already runs.

### Idle is solo

The corollary. You cannot idle in a party, because the other members are live. Disconnecting
from a party removes you from its instance and settles you on your own. Disconnecting inside
a dungeon returns you to its entrance in the overworld.

That keeps the offline tiers below simple, and it's also the right game design: grouping is
something you do when you're present.

## The trap this design avoids

"Server-authoritative multiplayer" gets conflated with "deterministic lockstep," and lockstep
is where projects like this die. It requires bit-identical results on both sides, which in
JavaScript means fighting `Math.sin`, `Math.cos`, `Math.atan2`, and `Math.pow` — none
specified to the last bit, all differing between V8, SpiderMonkey, and JavaScriptCore.

**Wildmarch never needs determinism, and grouping doesn't change that.** Three reasons:

- **The client never decides anything.** It doesn't roll damage, pick loot, or run AI. A
  slightly different number would have nowhere to go.
- **Parties share a server simulation, not a computation.** Members receive the same snapshots
  from the same authority. They never need to independently arrive at the same answer.
- **Combat is automatic.** The player controls movement and a few ability buttons. Nobody
  aims, so nobody notices 80 ms of latency on a wolf's approach.

The client predicts **its own movement only** and interpolates everything else — other
players included. That's a small shared module, terrain collision plus position integration,
not a bit-exact copy of the simulation.

## What it costs to run

Measured with `npm run bench`, which runs the game headless with an injected clock, exactly
as the server will.

| Tick rate | Cost per tick | Real-time factor | Party simulations per core |
| --- | --- | --- | --- |
| 10 Hz | 0.046 ms | 2,194× | ~2,190 |
| **20 Hz** | **0.037 ms** | **1,358×** | **~1,360** |
| 30 Hz | 0.036 ms | 923× | ~920 |
| 60 Hz | 0.036 ms | 466× | ~470 |

Each run is ten simulated minutes of auto-battle that actually fights — 150 to 177 kills,
level 9 to 11 by the end. Cost is dominated by iterating roughly 120 beasts across 52 spawn
nodes, and **that population is per party, not per player**. A five-player party costs about
what a solo player costs, plus four more sets of movement and swings.

**Grouping makes players cheaper.** At 20 Hz, one core carries ~1,360 parties: near 1,900
players if most people solo, near 4,000 if parties average three. Treat the figures as an
upper bound — single-threaded, one machine, no network I/O or serialization — and budget a
tenth. One eight-core box still carries a four-figure concurrent player count.

**20 Hz is the pick.** Four times the fastest attack interval in the game, 0.74 ms of CPU per
simulated second, an order of magnitude of headroom.

The presence layer is not a simulation and doesn't come out of this budget. It's a spatial
index over positions with a pub/sub on top: cull to a view radius, cap at the ~40 nearest
players, broadcast at 5–10 Hz. About 4 KB/s per player, and it scales independently of the
simulation fleet.

## The architecture

```
client                                server
------                                ------
input   ─── seq, dt, move, ability ─▶  session ──▶ party instance
                                                     │  simulation (20 Hz, authoritative)
render  ◀── snapshot deltas ──────────────────────── │  beasts, loot, combat, XP
  │                                                  │
  ├─ movement predictor                              └─ hibernate ──▶ Postgres
  │  (shared collision code)
  │
  └─ presence ◀── nearby players ──── presence service (spatial index, not a sim)
```

Four lifecycles, deliberately separate:

- **Session** — one connection, one character. Connecting, live, draining, hibernated.
- **Party instance** — one simulation, one to five characters, one map. Created when the first
  member enters, destroyed when the last leaves.
- **Dungeon instance** — a party instance on an instanced map, ephemeral, with a completion
  state.
- **Presence** — a character's position published to the world, independent of which instance
  is simulating it.

Joining a party means migrating a character from one instance to another. That's the same
machinery as hibernation — drain, snapshot, stop, restore elsewhere — which is why it's worth
building hibernation carefully in Phase 4 rather than expediently.

### Three tiers of authority

Most players are away most of the time, and simulating an empty room is pure cost. Authority
degrades in tiers, and the measurements set the boundaries.

| Tier | When | How | Cost |
| --- | --- | --- | --- |
| **Live** | Connected | Real simulation at 20 Hz | 0.74 ms CPU per second |
| **Catch-up** | Solo, reconnect within 15 minutes | Fast-forward the real simulation | 0.66 s CPU, once |
| **Ledger** | Solo, longer absences, capped at 12 h | `runOfflineLedger()`, the rate model | Microseconds |

Catch-up is what the capacity measurement unlocked: at 1,358× real time, replaying fifteen
minutes costs two thirds of a second, so a dropped connection on a train doesn't pay
differently from staying online. Beyond that the rate model takes over, because twelve hours
would cost 32 seconds of CPU to replay.

Both offline tiers are solo-only, per the rule above.

## The gap between the ledger and the game

`OFFLINE.efficiency` is 0.72 and states the intent plainly: an hour away should be worth about
0.72 of an hour played, the discount covering healing, pathing, and waiting on respawns.

**Measured, it pays about half that, and the shortfall is stable.**

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

This is a live bug in the shipped game. It gets sharper here for three reasons: the ledger
becomes the server's definitive account of an absence rather than a client-side estimate; a
payout cliff appears at the catch-up boundary, and players find cliffs like that in about a
day; and **every new class multiplies the problem**, because the ledger models one build's
kill rate through `killsPerHour()` and each class needs to be right in both models at once.

`tests/unit/ledger-agreement.test.ts` gates it. It's a characterization test — it asserts
where the ratio sits today, not where it should sit, because closing the gap is a balance
decision, not a bug fix. Both sides are deterministic, so any movement there is a real change
in the model.

**Fix this before the ledger becomes authoritative**, and keep the test green per class after
that.

## The rewrite

Eleven items. R1 through R7 are the server-authority work; R9 through R11 are what mini-MMO
adds. Ordered by dependency.

### R1. Fixed timestep

The simulation steps at exactly 20 Hz; the client accumulates real time into fixed steps and
renders with the leftover as an interpolation factor. This **deletes** the `quantise()` median
filter in `src/main.ts`, whose sampling buffer and period estimation exist solely to stabilize
a variable frame delta.

### R2. Split the randomness by consequence

`EcsSimulation.rand` is one stream serving both dice that matter and dice that don't. Damage
variance, crit rolls, loot, rarity, AI transitions, wander points, and respawn jitter share a
sequence with float-text offsets, corpse lean, effect angles, and spark positions.

Split into **`sim`** (outcome-changing, server-only, position saved so an instance resumes
mid-stream) and **`fx`** (only ever seen, client-only). Roughly 25 call sites in `state.ts`,
each a one-line classification. The most invasive item and the most mechanical.

### R3. Take the view out of the simulation

`setView()` feeds the camera rectangle into the simulation and exactly one rule reads it:
`shouldGiveUp()`, which ends a chase when a beast is dragged off the visible screen.

That's a fairness bug independent of any server — an ultrawide monitor currently gets longer
chases than a phone — and it becomes incoherent the moment two players with different screens
share an instance. Replace it with a fixed leash in world units.

### R4. Separate simulation state from wire state

`Enemy` has 35 fields, most of them server-side AI bookkeeping the client never draws.
Serialized naively that's **582 bytes per beast**, and a snapshot of 122 beasts is **71 KB** —
1.4 MB/s per player at 20 Hz.

Define an `EnemyView` of about twelve fields — id, sheet, position, facing, health fraction,
state, animation phase, hit flash — quantized to roughly a dozen bytes, scoped to an interest
radius, sent as deltas at 10 Hz. Thirty visible beasts then costs about 3.6 KB/s.

Mini-MMO makes this **more** important, not less: party members and nearby players need view
types of their own, and a hub full of avatars is exactly where a naive format falls over.
**The wire is the real bottleneck in this design, not the simulation.**

### R5. Make the simulation host-agnostic

Mostly already true — no DOM, injected clock, injected RNG factory, a `Simulation` interface
with commands, snapshots, and drained events. What remains is removing the last assumptions
that a renderer is present, and moving `src/game` and `src/core` into a package both sides
import.

### R6. Transport and session lifecycle

WebSocket. The client sends batched input frames stamped with a sequence number; the server
replies with snapshot deltas and the last sequence it processed. Session and instance
lifecycles as described above, including character migration between instances.

### R7. Client-side prediction, movement only

Extract position integration and terrain collision into a module both sides call. The client
keeps a ring buffer of unacknowledged inputs and replays them when the server acknowledges a
sequence with an authoritative position. Abilities are optimistic: the button lights, the
cooldown starts, the server confirms or rejects. Everything else, including other players,
interpolates between snapshots with about a 100 ms buffer.

### R8. Reconcile the ledger with the simulation

The measured gap above. A shipping requirement, not a nice-to-have.

### R9. Break the save schema while it's free

`SAVE_VERSION` is 1 and `readSave()` hard-rejects anything else. Adding classes, dungeons, and
parties changes the save in ways that can't be avoided:

- **A class** on the character, which nothing currently records.
- **A location** richer than `x, y`: which realm, which map, and whether that map is an
  instance. `readSave()` currently bounds position by `WORLD_SIZE` and demands an exact world
  seed.
- **Per-class talents**, since `TALENT_ROWS` is a single Warrior ladder.
- **A realm seed** rather than a per-character one. The world seed is currently the constant
  `20260812`, which is exactly right for an MMO — everybody already inhabits the same map —
  but it belongs to the realm, not to the save.

**Do all of it before there is a server or a single live player.** A schema break costs
nothing today and costs a migration over live characters forever after. This is the strongest
sequencing argument in the plan.

### R10. Classes, abilities, and rotations as data

Abilities are hardcoded three ways over: `Ability['id']` is a two-member string union that
flows into `GameCommand`, the array is indexed positionally (`abilities[0]` is whirlwind,
`abilities[1]` is second wind) in six places, and `deriveStats()` is a single formula over
str, vit, and agi.

Generalizing means: abilities addressed by id against a table, effects behind a registry
rather than a switch, and per-class stat coefficients.

But the important part is subtler. **In an idle auto-battler the class fantasy lives in the
auto-battle rotation, not in the ability buttons**, because most of the time nobody is
pressing them. Today that rotation is two inline conditions in `stepAuto()`:

```
if (secondwind is ready && hp < 45%)        use it
if (whirlwind is ready && enemies within radius >= 2)  use it
```

That's a priority list, and it should become one — an ordered set of rules per class, each a
condition drawn from a small vocabulary (own health below a fraction, an ally's health below a
fraction, enemies within a radius, target is elite or apex, an ability is ready, a buff is
missing) and an action. A tank's list holds threat; a healer's list watches the lowest ally; a
ranged class's list opens at distance and disengages.

The payoff is [balance by simulation](#balance-by-simulation).

### R11. Give enemies a threat model

`stepEnemies()` computes `dist(e.x, e.y, p.x, p.y)` against **the** player, singular. Every
aggro, chase, attack, and de-aggro rule in the game is written against exactly one character,
and `shouldGiveUp(e, dPlayer)` takes that one distance as an argument.

Parties need beasts to choose among several combatants: a threat table per enemy, damage and
healing contributing to it, and target selection over that table. This is the single largest
simulation change in the plan, and it's what makes roles mean anything — without it, a tank is
a character with more health and no job.

Build the data structure early, in the same phase as R10, exercised by a party of one. Build
the party logic on top of it later.

## Balance by simulation

The headless harness that measured capacity is also a balance tool, and this is the strongest
argument for doing R10 as data rather than as code.

The simulation runs at **1,358× real time**. A class's rotation is data. So every class can be
run through a standard hour — same ground, same level, same gear budget — in under three
seconds, and compared on kills per hour, survivability, and downtime. Add a class, and CI
tells you where it lands against the others before anyone plays it.

The same harness already proves the ledger disagrees with the live game by half. That check
becomes per-class, and it has to stay green for every class you add, because `killsPerHour()`
in the ledger and the real rotation in the simulation are two models of the same character
that must agree.

`tools/bench-sim.test.ts` is where this grows.

## What survives from the earlier designs

- **`readSave()` stays**, extended by R9. Still the decoder for anything from outside, and the
  outside now includes existing `localStorage` saves being imported.
- **`src/game/verify.ts` stays, retargeted.** Under full authority the server generates every
  item, so nothing needs verifying for anti-cheat. Two uses remain: validating imported saves
  at migration, and asserting internal invariants in tests, where it catches server bugs rather
  than cheaters. Its 19 tests keep earning their place.
- **`bossWindow()` stays and gets more valuable.** A global wall clock is exactly what a
  contested world boss needs, and it needs no synchronization at all.
- **The one shared world seed stays.** It was already right for an MMO; it just belongs to the
  realm now.

## The phases

Each ships alone. The ordering rule that matters: **everything that breaks the save schema
happens before there is a server.**

### Phase 0: extract the shared package

Move `src/game` and `src/core` into `packages/sim`; the client imports from it. No server, no
behavior change.

**Done when:** `npm run verify` passes and nothing in `packages/sim` imports from the client.

### Phase 1: make the simulation hostable

R1 through R5. The game still runs in the browser exactly as it does now, on a fixed timestep,
with split randomness, no view dependency, and wire types it doesn't yet use.

**Done when:** the browser game plays identically, `npm run bench` still reports its capacity,
and the simulation compiles with no reference to `window` or a view rectangle.

### Phase 2: classes, abilities, and the schema

R9, R10, and the threat-table half of R11. Still client-only, still single-player, and
therefore still free to break anything. Ship at least two classes so the abstractions are
tested by a second case rather than designed for one.

**Done when:** a second class plays end to end, its rotation is data, and the balance
comparison runs in CI.

### Phase 3: the server runs the simulation

R6 and R7, solo only. Accounts, WebSocket sessions, one instance per session, prediction and
interpolation. Disconnect ends the session and saves the character where it stood.

**Done when:** you can play a full session with the simulation on the server and movement
still feels immediate.

### Phase 4: absence

Hibernation, the catch-up tier, and the ledger tier. R8 ships here or earlier. Build
hibernation properly — instance migration in Phase 6 is the same machinery.

**Done when:** a fifteen-minute disconnect resumes exactly, a twelve-hour one settles through
the ledger, and the payout at the boundary doesn't jump.

### Phase 5: presence

Other players appear in your world. No shared simulation, no combat interaction — a spatial
index, a pub/sub, and view types for avatars.

This is the cheapest phase and the one players will notice most. It's worth doing before
grouping for exactly that reason: the world stops feeling empty long before the hard part
lands.

**Done when:** you can stand in Hearthglen and watch other people walk through it.

### Phase 6: parties

The party half of R11, instance migration, invites, shared experience and loot rules,
party-scoped modifiers.

**Done when:** two players fight the same wolf, and one of them can be a healer.

### Phase 7: dungeons

Instanced maps with their own generator or authored layouts, an entrance and a completion
state, and the disconnect rule from [Idle is solo](#idle-is-solo).

**Done when:** a party clears a dungeon, and a disconnect midway returns that character to the
entrance without losing anything else.

### Phase 8: the shared world

Contested apex beasts with damage aggregated across every party present, ladders, a kill feed,
guilds, and chat. Mostly readouts of state the server already holds.

## Hazards

- **The tier boundary.** Catch-up and ledger must pay comparably or players farm the seam.
- **Hibernation must be atomic.** Serializing a character while a tick is in flight is how
  duplicated loot happens — and once it's also the migration path into a party, it's how loot
  gets duplicated *deliberately*. Drain, then snapshot, then stop.
- **The RNG split is easy to get subtly wrong.** A draw classified as cosmetic that actually
  feeds an AI decision reintroduces the dependency. Review R2 call site by call site.
- **Threat is where multiplayer exploits live.** A threat model that can be zeroed, or that
  ignores healing, turns every group fight into one character kiting for the others. Design it
  with the rotations in R10, not after them.
- **Per-class ledger drift.** Every class needs `killsPerHour()` and its live rotation to
  agree. The agreement test must run per class or the offline rate quietly becomes wrong for
  everyone except the Warrior.
- **Content drift between client and server.** Hash the content tables at build time and refuse
  a session across a mismatch. Under authority this matters more, not less: the client's
  renderer indexes into the same tables.
- **Prediction divergence on terrain.** The predictor and the server must share collision code
  exactly, or players rubber-band at walls — the one place where a small numerical disagreement
  is visible.
- **Presence is a privacy surface.** Broadcasting position and name to strangers is a product
  decision as much as a technical one. Decide what's public before Phase 5, not after.

## Decisions needed from you

| Decision | Assumed | If you disagree |
| --- | --- | --- |
| Beast ownership | Party-scoped; no contention outside apex fights | A true shared spawn pool is far cheaper per player at scale, and it makes idle income depend on who else is standing there. |
| Party size | Up to 5 | Larger parties raise per-instance cost and make the threat model harder to tune. |
| Tick rate | 20 Hz | 10 Hz doubles capacity and coarsens the fastest attack interval; 30 Hz costs a third of capacity for little visible gain. |
| Catch-up window | 15 minutes, solo only | Longer is affordable as a background job but widens the window where a stale client shows an old world. |
| Closing the ledger gap | Raise the ledger's rate to the intended 0.72 | Lowering `OFFLINE.efficiency` to match reality is equally valid and cheaper, but makes idling meaningfully worse. |
| Classes at Phase 2 | Two, so the abstraction has a second case | One class means designing the system around the Warrior again. |
| Realms | One realm, one seed, shards only if population demands | Multiple realms split the player base early and complicate the wall-clock apex schedule. |
| Existing saves | Import once through `verify.ts` | Starting everyone fresh is simpler and throws away real characters. |

## Reproducing the measurements

```bash
npm run bench     # capacity: ms per tick, sims per core, snapshot size
npm test          # includes tests/unit/ledger-agreement.test.ts
```
