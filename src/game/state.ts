/**
 * The simulation. Owns the player, the live enemy population, loot, quests and
 * milestones, and steps them all forward once per frame.
 *
 * The rule that makes the world traversable: an enemy abandons its chase the
 * moment it leaves the visible screen or strays too far from the spawn node it
 * belongs to. It then walks home, healing, and ignores the player on the way.
 * Trains of monsters therefore cannot follow you from camp to camp.
 */
import { clamp, dist, facingToDir, rng, type Rng } from '../core/math'
import { BEAST_GEOMETRY } from '../assets/types'
import {
  AUTO,
  BEHAVIOUR,
  BOSS,
  BOSSES,
  CRIT_MULT,
  DESPERATE_BELOW,
  ELITE,
  EMBER,
  ENEMIES,
  EXECUTE_BELOW,
  MASTERY_TIERS,
  MILESTONES,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  QUESTS,
  RARITY_COLORS,
  RESPEC_COST_PER_LEVEL,
  SECOND_WIND,
  SWING_DURATION,
  SWING_HALF_ANGLE,
  SWING_RANGE,
  TALENT_ROWS,
  UNIQUES,
  UNIQUE_DROP_CHANCE,
  WHIRLWIND,
  baseMods,
  bossById,
  bossWindow,
  buildMods,
  damageVs,
  deriveStats,
  masteryTier,
  mitigate,
  resistFrom,
  rewardScale,
  rowOfTalent,
  talentById,
  uniqueById,
  xpForLevel,
  xpScale,
  type DerivedStats,
  type Metric,
  type Mods,
  type QuestDef,
  type QuestReward,
  type TalentRow,
} from './content'
import {
  itemScore,
  makeItem,
  makeUnique,
  sumStats,
  UidSequence,
  uniqueDefOf,
} from './loot'
import type { BeastSheetId } from '../assets/types'
import { componentStores, type ComponentStores } from './components'
import type {
  CommandResult,
  DomainEvent,
  GameCommand,
  GameSnapshot,
  InputFrame,
  Revisions,
  Simulation,
  SimulationDependencies,
  ViewRect,
} from './contracts'
import { SpatialHash } from './spatial'
import type { OfflineReport } from './offline'
import { SAVE_VERSION, type Save } from './save'
import {
  CAMPS,
  LANDMARKS,
  REGIONS,
  TILE,
  World,
  WORLD_SIZE,
  groundLevelOf,
  npcById,
  type BiomeId,
  type Camp,
  type Landmark,
  type Npc,
  type Region,
  type SpawnNode,
} from './world'
import {
  SLOTS,
  isEngaged,
  perSpecies,
  type Ability,
  type BySpecies,
  type Corpse,
  type Effect,
  type Enemy,
  type EnemyKind,
  type FloatText,
  type Ground,
  type Item,
  type Player,
  type Slot,
} from './types'

export const BAG_SIZE = 40

export interface GameHooks {
  log(text: string, color?: string): void
  banner(title: string, sub: string): void
  dirty(): void
}

/** A walk in progress: where to, the way there, and how far along it is. */
interface Route {
  x: number
  y: number
  path: { x: number; y: number }[]
  at: number
  /** Seconds spent going nowhere. Past a second or so, the way needs redrawing. */
  stuck: number
}

/**
 * Somewhere auto-battle is walking to, on purpose. Transient: it is a decision
 * the player just made, not progress, so the save does not carry it.
 */
export interface TravelTarget {
  x: number
  y: number
  /** What the HUD calls this journey. */
  label: string
  /** How close counts as arrived. */
  arrive: number
  /** The task this journey serves, so finishing the task ends the journey. */
  questId?: string
  /**
   * What the journey is hunting. Meeting one on the way counts as arriving —
   * the point was the beasts, not the ground they stand on.
   */
  hunt?: EnemyKind | 'elite' | 'any'
  /**
   * Switch auto-battle off on arrival. A journey to a person or a camp ends
   * with the player reading something; without this, auto-battle walks off to
   * the nearest den before they can.
   */
  stopHere?: boolean
}

export interface Counters {
  kills: number
  elite: number
  /** World bosses felled. Every apex kill is also an elite kill. */
  bosses: number
  gold: number
  quests: number
  /**
   * Kills by species. Mastery and the bestiary are views of this record, so it
   * is the one place a species' tally is written — a flat field per animal was
   * what made a third species expensive.
   */
  species: BySpecies
}

export class EcsSimulation implements Simulation {
  static readonly PLAYER_ENTITY = 0
  readonly world: World
  readonly player: Player
  readonly enemies: Enemy[] = []
  readonly corpses: Corpse[] = []
  readonly floats: FloatText[] = []
  readonly effects: Effect[] = []
  /** Burning ground. Simulation, not decoration — see `stepGrounds`. */
  readonly grounds: Ground[] = []
  readonly bag: (Item | null)[] = new Array(BAG_SIZE).fill(null)
  readonly equipped: Record<Slot, Item | null> = {
    weapon: null,
    head: null,
    chest: null,
    hands: null,
    feet: null,
    ring: null,
  }
  readonly abilities: Ability[] = [
    {
      id: 'whirlwind',
      name: 'Whirlwind',
      key: 'Q',
      desc: `Spin through every beast within reach for ${Math.round(WHIRLWIND.damageMult * 100)}% weapon damage.`,
      cooldown: WHIRLWIND.cooldown,
      cd: 0,
    },
    {
      id: 'secondwind',
      name: 'Second Wind',
      key: 'E',
      desc: `Recover ${Math.round(SECOND_WIND.healFraction * 100)}% of maximum health.`,
      cooldown: SECOND_WIND.cooldown,
      cd: 0,
    },
  ]

  stats: DerivedStats
  /**
   * Everything talents, worn relics and beast mastery have to say about the
   * rules, folded into one object by `recalc`. Read it; never write to it.
   */
  mods: Mods = baseMods()
  /** One talent id per unlocked row. Changing a pick costs a respec. */
  talents: string[] = []
  /** Relics this character has ever found, so no elite drops one twice. */
  foundUniques = new Set<string>()
  counters: Counters = {
    kills: 0,
    elite: 0,
    bosses: 0,
    gold: 0,
    quests: 0,
    species: perSpecies(0),
  }
  /**
   * Which scheduling window this character has already taken, per boss. World
   * state in principle — a server would own it — but private until there is
   * one, so it lives in the save alongside everything else per-character.
   */
  bossCleared: Record<string, number> = {}
  questIndex = 0
  questProgress = 0
  /**
   * Whether the task at `questIndex` has been taken from the person who gives
   * it. A task with no `from` needs no acceptance, so this only decides
   * anything for the ones an NPC holds.
   */
  questTaken = false
  claimed = new Set<string>()
  /** Camps this character has found. Per-player progress, never world state. */
  discovered = new Set<string>(CAMPS.filter((c) => c.startDiscovered).map((c) => c.id))
  /** Named places this character has stood in. Also per-player, also never world. */
  seenLandmarks = new Set<string>()
  autoEquip = true
  /** Where this character hunts while its player is away. */
  huntingGround: BiomeId | null = null
  /**
   * True once the player has chosen a ground deliberately. Until then it simply
   * follows wherever they are, so someone who never opens the Hunt tab still
   * earns from somewhere sensible.
   */
  groundPinned = false
  time = 0
  currentCamp: Camp | null = null
  /** The named place the player is standing in, if any. Drives the HUD label. */
  currentLandmark: Landmark | null = null
  /** The person within speaking distance, if any. The HUD prompt reads it. */
  nearbyNpc: Npc | null = null
  /** Where auto-battle is walking, if the player pointed it somewhere. */
  travel: TravelTarget | null = null
  readonly components: ComponentStores = componentStores()
  readonly spatial = new SpatialHash<Enemy>(256)
  readonly revisions: Revisions = { inventory: 0, progression: 0, quests: 0, world: 0, combat: 0 }

  private hookTarget: GameHooks = { log: () => {}, banner: () => {}, dirty: () => {} }
  private eventQueue: DomainEvent[] = []

  get hooks(): GameHooks {
    return this.hookTarget
  }

  set hooks(target: GameHooks) {
    this.hookTarget = {
      log: (text, color) => {
        this.eventQueue.push({ type: 'log', text, ...(color ? { color } : {}) })
        target.log(text, color)
      },
      banner: (title, sub) => {
        this.eventQueue.push({ type: 'banner', title, subtitle: sub })
        target.banner(title, sub)
      },
      dirty: () => {
        for (const key of Object.keys(this.revisions) as (keyof Revisions)[]) this.revisions[key]++
        target.dirty()
      },
    }
  }

  private rand: Rng
  private readonly uids = new UidSequence()
  private nextId = 1
  private view: ViewRect = { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }
  private swingApplied = false
  private outOfCombat = 0
  /** Seconds until the next boss-window check; per frame would be waste. */
  private bossCheck = 0
  /** The route the player asked for, and the one auto-battle chose itself. */
  private travelRoute: Route | null = null
  private roamRoute: Route | null = null
  private travelRetries = 0
  /** Seconds before roaming tries to draw a route again. */
  private roamRetry = 0

  constructor(
    world = new World(),
    private readonly dependencies: SimulationDependencies = {
      clock: { now: () => Date.now() },
      rngFactory: { create: (seed) => rng(seed) },
    },
  ) {
    this.world = world
    this.rand = dependencies.rngFactory.create(0xc0ffee)
    const start = CAMPS[0]!
    this.player = {
      x: start.x,
      y: start.y + 90,
      vx: 0,
      vy: 0,
      radius: PLAYER_RADIUS,
      facing: Math.PI / 2,
      dir: 0,
      hp: 1,
      maxHp: 1,
      level: 1,
      xp: 0,
      xpNext: xpForLevel(1),
      str: 7,
      vit: 7,
      agi: 5,
      anim: 0,
      moving: false,
      attackCd: 0,
      swingT: 0,
      swingDir: 0,
      hitFlash: 0,
      alive: true,
      deadT: 0,
      gold: 0,
      auto: false,
      targetId: -1,
      invuln: 0,
      webbed: 0,
    }
    this.stats = this.recalc()
    this.player.hp = this.stats.maxHp
    this.syncPlayerComponents()
    // Seed the world so the first screen isn't empty while nodes warm up.
    for (const node of this.world.nodes) this.fillNode(node, true)
    this.rebuildSpatial()
  }

  /* ================= persistence ================= */

  serialize(): Save {
    const p = this.player
    return {
      v: SAVE_VERSION,
      seed: this.world.seed,
      savedAt: this.dependencies.clock.now(),
      player: {
        x: p.x,
        y: p.y,
        level: p.level,
        xp: p.xp,
        xpNext: p.xpNext,
        str: p.str,
        vit: p.vit,
        agi: p.agi,
        hp: p.hp,
        gold: p.gold,
        auto: p.auto,
      },
      bag: this.bag.slice(),
      equipped: { ...this.equipped },
      nextUid: this.uids.mark(),
      counters: { ...this.counters, species: { ...this.counters.species } },
      questIndex: this.questIndex,
      questProgress: this.questProgress,
      questTaken: this.questTaken,
      claimed: [...this.claimed],
      discovered: [...this.discovered],
      seenLandmarks: [...this.seenLandmarks],
      bossCleared: { ...this.bossCleared },
      huntingGround: this.huntingGround,
      groundPinned: this.groundPinned,
      autoEquip: this.autoEquip,
      talents: [...this.talents],
      foundUniques: [...this.foundUniques],
    }
  }

  /**
   * Applied on top of a freshly constructed game, so the world is already
   * generated and every spawn node already full. Only the character is restored.
   */
  hydrate(s: Save) {
    const p = this.player
    p.x = s.player.x
    p.y = s.player.y
    p.level = s.player.level
    p.xp = s.player.xp
    p.xpNext = s.player.xpNext
    p.str = s.player.str
    p.vit = s.player.vit
    p.agi = s.player.agi
    p.gold = s.player.gold
    p.auto = s.player.auto

    for (let i = 0; i < BAG_SIZE; i++) this.bag[i] = s.bag[i] ?? null
    for (const slot of SLOTS) this.equipped[slot] = s.equipped[slot] ?? null
    // Before any fresh drop is rolled, or new uids collide with restored gear.
    this.uids.restore(s.nextUid)

    // Copied rather than adopted: the save object outlives this call — the
    // offline ledger is still reading it — and counting a kill must not reach
    // back into it.
    this.counters = { ...s.counters, species: { ...s.counters.species } }
    this.questIndex = s.questIndex
    this.questProgress = s.questProgress
    this.questTaken = s.questTaken
    this.claimed = new Set(s.claimed)
    this.discovered = new Set(s.discovered)
    this.seenLandmarks = new Set(s.seenLandmarks)
    this.bossCleared = { ...s.bossCleared }
    this.huntingGround = s.huntingGround
    this.groundPinned = s.groundPinned ?? false
    this.autoEquip = s.autoEquip
    // Ids no longer in the tables are dropped rather than carried as dead
    // entries: a renamed talent should refund its pick, not haunt the build.
    this.talents = s.talents.filter((id) => talentById(id) !== null)
    this.foundUniques = new Set(s.foundUniques.filter((id) => uniqueById(id) !== null))

    // The loot stream is fixed-seed and its position is not recoverable from the
    // closure, so reseed it. Without this every session rolls the same sequence
    // of drops from the top.
    this.rand = this.dependencies.rngFactory.create((s.savedAt ^ 0x9e3779b1) >>> 0)

    this.recalc()
    // Transient combat state is never saved; a character mid-death returns whole.
    p.hp = s.player.hp > 0 ? Math.min(s.player.hp, this.stats.maxHp) : this.stats.maxHp
    p.alive = true
    p.deadT = 0
    p.targetId = -1
    p.invuln = 0
    p.vx = 0
    p.vy = 0
    p.swingT = 0
    p.hitFlash = 0
  }

  /* ================= hunting grounds ================= */

  /**
   * A ground is assignable when it is within the same +2 band `rewardScale` pays
   * full value for. One rule governs both, so a ground you are allowed to pick is
   * exactly a ground worth hunting.
   */
  isGroundEligible(r: Region): boolean {
    return r.kind !== null && r.levelMin - 2 <= this.player.level
  }

  eligibleGrounds(): Region[] {
    return REGIONS.filter((r) => this.isGroundEligible(r))
  }

  /**
   * True once a ground pays no experience at all. It stays huntable — the gold
   * and the gear are still real — but it can no longer level anyone.
   */
  isGroundOutgrown(r: Region): boolean {
    return r.kind !== null && xpScale(this.player.level, groundLevelOf(r)) <= 0
  }

  setHuntingGround(id: BiomeId | null) {
    this.huntingGround = id
    this.groundPinned = id !== null
    this.hooks.dirty()
  }

  /**
   * Follow the player while unpinned. Outgrown ground is skipped: walking home
   * through the vale at level 11 should not silently reassign a character to a
   * region that can no longer level it.
   */
  private trackGround() {
    if (this.groundPinned) return
    const r = this.world.regionAt(this.player.x, this.player.y)
    if (this.isGroundEligible(r) && !this.isGroundOutgrown(r)) this.huntingGround = r.id
  }

  /**
   * Settle an offline run. Kills earned while away are real kills: they feed
   * counters, milestones and any kill-objective quest, exactly as they would
   * have at the keyboard.
   */
  applyOfflineReport(r: OfflineReport) {
    this.counters.kills += r.kills
    this.counters.species[r.kind] += r.kills
    this.counters.elite += r.eliteKills

    const q = this.quest
    if (q && q.objective.type === 'kill') {
      const want = q.objective.kind
      const credited =
        want === 'any' ? r.kills : want === 'elite' ? r.eliteKills : want === r.kind ? r.kills : 0
      if (credited > 0) {
        this.questProgress += credited
        if (this.questProgress >= q.objective.count) this.completeQuest()
      }
    }

    this.gainXp(r.xp, true)
    this.gainGold(r.gold)
    for (const id of r.uniques) this.foundUniques.add(id)
    for (const item of r.items) this.addItem(item)
    // Kills earned overnight move mastery tiers exactly as waking ones do.
    this.recalc()
    this.hooks.dirty()
  }

  /* ================= derived stats ================= */

  recalc(): DerivedStats {
    const gear = sumStats(SLOTS.map((s) => this.equipped[s]))
    this.mods = this.computeMods()
    this.stats = deriveStats(this.player.level, this.player, gear, this.mods)
    this.describeAbilities()
    const p = this.player
    const prevMax = p.maxHp
    p.maxHp = this.stats.maxHp
    if (prevMax <= 1) p.hp = p.maxHp
    else if (p.maxHp > prevMax) p.hp += p.maxHp - prevMax
    p.hp = clamp(p.hp, 0, p.maxHp)
    return this.stats
  }

  /**
   * Three sources, folded in a fixed order so the result never depends on when
   * a relic was equipped or a talent taken.
   */
  private computeMods(): Mods {
    return buildMods(
      SLOTS.map((s) => this.equipped[s]?.unique),
      this.talents,
      this.counters.species,
    )
  }

  /**
   * Ability cooldowns and their descriptions are derived, not authored — a
   * talent that changes one has to change what the button says, or the HUD is
   * quietly lying about the build.
   */
  private describeAbilities() {
    const ww = this.abilities[0]!
    const sw = this.abilities[1]!
    ww.cooldown = WHIRLWIND.cooldown * this.mods.wwCooldownMult
    ww.desc = `Spin through every beast within reach for ${Math.round(
      WHIRLWIND.damageMult * this.mods.wwDamageMult * 100,
    )}% weapon damage.`
    sw.cooldown = SECOND_WIND.cooldown * this.mods.swCooldownMult
    sw.desc = `Recover ${Math.round(
      SECOND_WIND.healFraction * this.mods.swHealMult * 100,
    )}% of maximum health.`
    // Shortening a cooldown must not leave the current timer above its own
    // maximum — the HUD draws cd/cooldown and would overflow the fill.
    ww.cd = Math.min(ww.cd, ww.cooldown)
    sw.cd = Math.min(sw.cd, sw.cooldown)
  }

  /* ================= build-derived reach ================= */

  get moveSpeed(): number {
    const webbed = this.player.webbed > 0 ? BEHAVIOUR.web.slowMult : 1
    return PLAYER_SPEED * this.mods.moveSpeedMult * webbed
  }

  get swingRange(): number {
    return SWING_RANGE + this.mods.swingRangeAdd
  }

  get swingArc(): number {
    return Math.min(Math.PI, SWING_HALF_ANGLE * this.mods.swingArcMult)
  }

  get whirlwindRadius(): number {
    return WHIRLWIND.radius * this.mods.wwRadiusMult
  }

  /* ================= talents ================= */

  /** Rows this character has reached the level for. */
  unlockedRows(): TalentRow[] {
    return TALENT_ROWS.filter((r) => this.player.level >= r.level)
  }

  talentIn(row: TalentRow): string | null {
    return this.talents.find((id) => row.choices.some((c) => c.id === id)) ?? null
  }

  get talentPoints(): number {
    let n = 0
    for (const row of this.unlockedRows()) if (!this.talentIn(row)) n++
    return n
  }

  chooseTalent(id: string): boolean {
    const def = talentById(id)
    const row = rowOfTalent(id)
    if (!def || !row) return false
    if (this.player.level < row.level) return false
    // One per row, and taken picks are final until a respec. A free swap would
    // make the choice a menu rather than a decision.
    if (this.talentIn(row)) return false
    this.talents.push(id)
    this.recalc()
    this.hooks.log(`${def.name} — ${def.desc}`, '#9ad0ff')
    this.hooks.dirty()
    return true
  }

  get respecCost(): number {
    return this.talents.length ? RESPEC_COST_PER_LEVEL * this.player.level : 0
  }

  respec(): boolean {
    const cost = this.respecCost
    if (!cost || this.player.gold < cost) return false
    // Spends the purse without touching lifetime gold earned — this is a drain
    // on the economy, not a retraction of what the character has made.
    this.player.gold -= cost
    this.talents.length = 0
    this.recalc()
    this.hooks.log(`Retrained for ${cost}g`, '#d8c07a')
    this.hooks.dirty()
    return true
  }

  setView(view: ViewRect) {
    this.view = { ...view }
  }

  /* ================= spawning ================= */

  private fillNode(node: SpawnNode, instant = false) {
    while (node.alive.length < node.cap) {
      const pos = this.world.nodeWanderPoint(node, this.rand)
      if (!instant && dist(pos.x, pos.y, this.player.x, this.player.y) < 300) return
      this.spawnEnemy(node, pos.x, pos.y)
    }
  }

  /**
   * The one place an `Enemy` is built. A boss is an ordinary beast with much
   * larger numbers and no den, so it goes through here too rather than being a
   * second copy of thirty fields that would drift out of step.
   */
  private makeEnemy(spec: {
    kind: EnemyKind
    level: number
    elite: boolean
    x: number
    y: number
    nodeId: number
    name: string
    sheet: BeastSheetId
    hpMult: number
    dmgMult: number
    xpMult: number
    goldMult: number
    aggroMult: number
    bossId?: string
  }): Enemy {
    const type = ENEMIES[spec.kind]
    const maxHp = Math.round(type.hp(spec.level) * spec.hpMult)
    // Body size follows the art it is wearing, so an apex that draws at 1.7x
    // also collides and reaches at 1.7x rather than fighting from inside a
    // sprite three times its hitbox.
    const sizeMult = BEAST_GEOMETRY[spec.sheet].renderScale
    const e: Enemy = {
      id: this.nextId++,
      kind: spec.kind,
      elite: spec.elite,
      level: spec.level,
      name: spec.name,
      sheet: spec.sheet,
      x: spec.x,
      y: spec.y,
      vx: 0,
      vy: 0,
      radius: type.radius * sizeMult,
      scale: 1,
      facing: this.rand() * Math.PI * 2,
      dir: 0,
      hp: maxHp,
      maxHp,
      dmg: type.dmg(spec.level) * spec.dmgMult,
      speed: type.speed * (spec.elite ? ELITE.speedMult : 1),
      xpValue: Math.round(type.xp(spec.level) * spec.xpMult),
      goldValue: Math.round(type.gold(spec.level) * spec.goldMult),
      alive: true,
      state: 'idle',
      stateT: this.rand.range(0, 2),
      anim: this.rand() * 4,
      moving: false,
      attackCd: 0,
      windup: 0,
      special: 0,
      hitFlash: 0,
      nodeId: spec.nodeId,
      ax: spec.x,
      ay: spec.y,
      wx: spec.x,
      wy: spec.y,
      aggroRange: type.aggroRange * spec.aggroMult,
      leash: type.leash,
      attackRange: type.attackRange * sizeMult,
      deadT: 0,
      bossId: spec.bossId,
    }
    this.enemies.push(e)
    this.syncEnemyComponents(e)
    this.spatial.insert(e)
    return e
  }

  private spawnEnemy(node: SpawnNode, x: number, y: number) {
    const type = ENEMIES[node.kind]
    const elite = node.elite
    const e = this.makeEnemy({
      kind: node.kind,
      level: node.level,
      elite,
      x,
      y,
      nodeId: node.id,
      name: elite ? type.eliteName : type.name,
      sheet: elite ? type.eliteSheet : type.sheet,
      hpMult: elite ? ELITE.hpMult : 1,
      dmgMult: elite ? ELITE.dmgMult : 1,
      xpMult: elite ? ELITE.xpMult : 1,
      goldMult: elite ? ELITE.goldMult : 1,
      aggroMult: elite ? 1.15 : 1,
    })
    node.alive.push(e.id)
  }

  /* ================= world bosses ================= */

  /**
   * Apex beasts stand at fixed places on a clock derived from wall time, so
   * every player's schedule is the same schedule. Whether *this* character has
   * already taken the current window is private, and lives in the save —
   * standing in for the shared state a server will own once there is one.
   */
  private stepBosses(dt: number) {
    this.bossCheck -= dt
    if (this.bossCheck > 0) return
    this.bossCheck = 1
    const window = bossWindow(this.dependencies.clock.now())
    for (const def of BOSSES) {
      if (this.bossCleared[def.id] === window) continue
      if (this.enemies.some((e) => e.alive && e.bossId === def.id)) continue
      const site = LANDMARKS.find((l) => l.id === def.site)
      if (!site) continue
      this.makeEnemy({
        kind: def.kind,
        level: def.level,
        elite: true,
        x: site.x,
        y: site.y,
        nodeId: -1,
        name: def.name,
        sheet: def.sheet,
        hpMult: def.hpMult,
        dmgMult: def.dmgMult,
        xpMult: def.xpMult,
        goldMult: def.goldMult,
        aggroMult: BOSS.aggroMult,
        bossId: def.id,
      })
      // Silent on the first pass: a character logging in should not be handed
      // five lines about beasts that have been standing there all along.
      if (this.time > 3) this.hooks.log(`${def.name} walks at ${site.name}.`, '#f0913a')
    }
  }

  /** Whether an apex is standing at its place right now. */
  bossIsUp(id: string): boolean {
    return this.enemies.some((e) => e.alive && e.bossId === id)
  }

  /* ================= main step ================= */

  update(dt: number, input: InputFrame) {
    this.time += dt
    const p = this.player
    const { moveX, moveY } = input

    for (const a of this.abilities) a.cd = Math.max(0, a.cd - dt)

    if (!p.alive) {
      p.deadT += dt
      if (p.deadT > 2.6) this.respawn()
      // Fire you already lit keeps burning while you are down.
      this.stepGrounds(dt)
      this.stepTransient(dt)
      this.syncComponentState()
      return
    }

    this.currentCamp = this.world.campAt(p.x, p.y)
    if (this.currentCamp) this.enterCamp(this.currentCamp)
    this.currentLandmark = this.world.landmarkAt(p.x, p.y)
    if (this.currentLandmark && !this.seenLandmarks.has(this.currentLandmark.id)) {
      this.findLandmark(this.currentLandmark)
    }
    this.nearbyNpc = this.world.npcAt(p.x, p.y)
    this.trackGround()

    // Taking the stick, or switching auto-battle off, takes the wheel back.
    if (this.travel) {
      if (!p.auto) this.cancelTravel('Travel stopped.')
      else if (Math.hypot(moveX, moveY) > 0.05) {
        p.auto = false
        this.cancelTravel('Travel stopped.')
      }
    }

    if (p.auto) this.stepAuto(dt)
    else this.stepManual(dt, moveX, moveY)

    this.stepSwing(dt)
    this.stepGrounds(dt)
    this.stepEnemies(dt)
    this.stepRegen(dt)
    this.stepSpawns()
    this.stepBosses(dt)
    this.stepTransient(dt)
    this.syncComponentState()
  }

  private stepManual(dt: number, mx: number, my: number) {
    const p = this.player
    const mag = Math.hypot(mx, my)
    if (mag > 0.05) {
      p.facing = Math.atan2(my, mx)
      this.moveEntity(p, mx * this.moveSpeed * dt, my * this.moveSpeed * dt)
      p.moving = true
      p.anim += dt * 8 * Math.min(1, mag * 1.4)
    } else {
      p.moving = false
      p.anim += dt * 3
    }
    p.dir = facingToDir(p.facing)
    // Standing still with a beast in reach still swings — the warrior never
    // waits for a button.
    const t = this.nearestEnemy({ x: p.x, y: p.y, maxDistance: this.swingRange + 26, huntable: true })
    if (t && !p.moving) p.facing = Math.atan2(t.y - p.y, t.x - p.x)
    if (t) p.dir = facingToDir(p.facing)
  }

  private stepAuto(dt: number) {
    const p = this.player
    // Emergency heal first.
    const sw = this.abilities[1]!
    if (sw.cd <= 0 && p.hp < p.maxHp * 0.45) this.useAbility('secondwind')

    // A journey outranks the hunt. `stepSwing` still answers anything that
    // closes to arm's length, so walking through a pack costs it blood.
    if (this.travel) {
      const ww = this.abilities[0]!
      if (ww.cd <= 0 && this.countEnemiesWithin(p.x, p.y, this.whirlwindRadius) >= 3) {
        this.useAbility('whirlwind')
      }
      this.stepTravel(dt)
      p.dir = facingToDir(p.facing)
      return
    }

    let target = this.enemyById(p.targetId)
    const stale =
      !target ||
      !target.alive ||
      target.state === 'return' ||
      dist(p.x, p.y, target.x, target.y) > AUTO.drop
    if (stale) {
      target = this.pickTarget()
      p.targetId = target ? target.id : -1
    }

    if (target) {
      this.roamRoute = null
      const d = dist(p.x, p.y, target.x, target.y)
      const reach = this.swingRange * 0.62 + target.radius
      p.facing = Math.atan2(target.y - p.y, target.x - p.x)
      if (d > reach) {
        this.moveEntity(
          p,
          Math.cos(p.facing) * this.moveSpeed * dt,
          Math.sin(p.facing) * this.moveSpeed * dt,
        )
        p.moving = true
        p.anim += dt * 8
      } else {
        p.moving = false
        p.anim += dt * 3
      }
      // Whirlwind pays for itself once a pack closes in.
      const ww = this.abilities[0]!
      if (ww.cd <= 0 && this.countEnemiesWithin(p.x, p.y, this.whirlwindRadius) >= 2) {
        this.useAbility('whirlwind')
      }
    } else {
      this.roam(dt)
    }
    p.dir = facingToDir(p.facing)
  }

  /**
   * What auto-battle fights next.
   *
   * With a task asking for a species, that species is worth crossing ground
   * for and nothing else is. Anything close enough to be in the way is still
   * fair game — the rule is a preference, not a blindfold.
   */
  private pickTarget(): Enemy | null {
    const p = this.player
    const plan = this.huntPlan()
    if (plan.want) {
      const wanted = this.nearestEnemy({
        x: p.x,
        y: p.y,
        maxDistance: AUTO.taskSeek,
        huntable: true,
        skipBosses: true,
        only: plan.want,
      })
      if (wanted) return wanted
    }
    return this.nearestEnemy({
      x: p.x,
      y: p.y,
      maxDistance: plan.focused ? AUTO.straySeek : AUTO.seek,
      huntable: true,
      skipBosses: true,
    })
  }

  /**
   * What the task in hand makes of the hunt.
   *
   * `want` is the species worth crossing ground for. `focused` says the task
   * has somewhere to be, which shortens the leash on everything else — a task
   * to reach a camp names no species, and the walk there is the progress.
   *
   * A body count takes anything, so it narrows nothing. An apex is not
   * auto-battle's business at all: `skipBosses` keeps it away from one, and its
   * task must not drag it there by the collar either.
   */
  private huntPlan(): { want: EnemyKind | 'elite' | null; focused: boolean } {
    const q = this.quest
    if (!q) return { want: null, focused: false }
    if (q.objective.type === 'reach') return { want: null, focused: true }
    const kind = q.objective.kind
    if (kind === 'any' || kind === 'boss') return { want: null, focused: false }
    return { want: kind, focused: true }
  }

  /* ================= travel ================= */

  /**
   * Point auto-battle at somewhere. It walks the route and swings at whatever
   * comes into reach, but it chases nothing on the way — a journey that stops
   * for every wolf is not a journey.
   */
  travelTo(t: TravelTarget): boolean {
    const p = this.player
    // Starting a journey that is already over would switch auto-battle on and
    // straight back off, and log both halves of a walk nobody took.
    if (dist(p.x, p.y, t.x, t.y) <= t.arrive) {
      this.hooks.log(`You are already at ${t.label}.`, '#9ad0ff')
      return false
    }
    const route = this.routeTo(t.x, t.y)
    if (!route) {
      this.hooks.log(`There is no way through to ${t.label}.`, '#d8746c')
      return false
    }
    this.travel = t
    this.travelRoute = route
    this.travelRetries = 0
    this.roamRoute = null
    p.auto = true
    p.targetId = -1
    this.hooks.log(`Travelling to ${t.label}.`, '#9ad0ff')
    this.hooks.dirty()
    return true
  }

  /** Give up on the journey without reaching it. */
  cancelTravel(reason?: string) {
    this.endTravel(false, reason)
  }

  /**
   * End the journey. `arrived` means it ended at the place it was going, which
   * is the only case that obeys `stopHere`.
   *
   * A task that finishes on arrival counts as arriving. Otherwise walking into
   * a camp completes the task, the task cancels the journey, and auto-battle
   * marches back out again before the player has read the banner.
   */
  private endTravel(arrived: boolean, reason?: string) {
    const t = this.travel
    if (!t) return
    this.travel = null
    this.travelRoute = null
    if (arrived && t.stopHere) {
      this.player.auto = false
      this.player.targetId = -1
      this.roamRoute = null
    }
    if (reason) this.hooks.log(reason, '#9ad0ff')
    this.hooks.dirty()
  }

  private arriveTravel() {
    const t = this.travel
    if (!t) return
    this.endTravel(true, `Arrived at ${t.label}.`)
  }

  private stepTravel(dt: number) {
    const p = this.player
    const t = this.travel!
    if (dist(p.x, p.y, t.x, t.y) <= t.arrive) {
      this.arriveTravel()
      return
    }
    // The quarry found on the road is the quarry. Stop here and fight it.
    if (t.hunt && this.huntNear(t.hunt, AUTO.straySeek)) {
      this.arriveTravel()
      return
    }
    if (!this.travelRoute) {
      this.arriveTravel()
      return
    }
    if (!this.stepRoute(dt, this.travelRoute)) this.repath()
  }

  private repath() {
    const t = this.travel
    if (!t) return
    this.travelRetries++
    const route = this.travelRetries <= 2 ? this.routeTo(t.x, t.y) : null
    if (!route) {
      this.cancelTravel(`Lost the way to ${t.label}.`)
      return
    }
    this.travelRoute = route
  }

  /** A route to a world point, ready to be walked. Null if there is no way. */
  private routeTo(x: number, y: number): Route | null {
    const path = this.world.findPath(this.player.x, this.player.y, x, y)
    return path ? { x, y, path, at: 0, stuck: 0 } : null
  }

  /**
   * One step along a route. Returns false when the walker has been held against
   * something for long enough that the route needs redrawing — a corner the
   * collision box will not round, or a shore the clearance margin missed.
   *
   * Travel and roaming both walk through here, so a beast the player sent
   * somewhere and a beast that chose for itself move the same way.
   */
  private stepRoute(dt: number, r: Route): boolean {
    const p = this.player
    while (r.at < r.path.length - 1) {
      const wp = r.path[r.at]!
      if (dist(p.x, p.y, wp.x, wp.y) > 24) break
      r.at++
    }
    const wp = r.path[r.at] ?? { x: r.x, y: r.y }
    const a = Math.atan2(wp.y - p.y, wp.x - p.x)
    p.facing = a
    const wasX = p.x
    const wasY = p.y
    this.moveEntity(p, Math.cos(a) * this.moveSpeed * dt, Math.sin(a) * this.moveSpeed * dt)
    p.moving = true
    p.anim += dt * 8
    if (dist(p.x, p.y, wasX, wasY) >= this.moveSpeed * dt * 0.3) {
      r.stuck = 0
      return true
    }
    r.stuck += dt
    return r.stuck <= 1.2
  }

  /** Is one of the beasts this journey is for already within reach of a fight? */
  private huntNear(hunt: EnemyKind | 'elite' | 'any', range: number): boolean {
    const p = this.player
    for (const e of this.enemies) {
      if (!e.alive || e.bossId) continue
      const match = hunt === 'any' || (hunt === 'elite' ? e.elite : e.kind === hunt)
      if (!match) continue
      if (dist(p.x, p.y, e.x, e.y) <= range) return true
    }
    return false
  }

  /**
   * Where the work for a task is. The tracker and the Tasks panel both offer to
   * walk there, so the answer is derived here once rather than in the HUD.
   */
  questDestination(q: QuestDef): TravelTarget | null {
    // A task nobody has handed over yet points at the person holding it.
    if (q.from && q === this.offeredQuest) {
      const npc = npcById(q.from)
      if (!npc) return null
      return {
        x: npc.x,
        y: npc.y,
        label: npc.name,
        arrive: npc.radius * 0.6,
        questId: q.id,
        stopHere: true,
      }
    }
    const objective = q.objective
    if (objective.type === 'reach') {
      const camp = CAMPS.find((c) => c.id === objective.camp)
      if (!camp) return null
      return {
        x: camp.x,
        y: camp.y,
        label: camp.name,
        arrive: camp.radius * 0.5,
        questId: q.id,
        stopHere: true,
      }
    }
    const want = objective.kind
    if (want === 'boss') {
      const boss = this.nearestBoss()
      if (!boss) return null
      return { x: boss.x, y: boss.y, label: boss.name, arrive: 140, questId: q.id }
    }
    const node = this.nearestNodeFor(want)
    if (!node) return null
    const region = this.world.regionAt(node.x, node.y)
    const label =
      want === 'any'
        ? `the hunting in ${region.name}`
        : want === 'elite'
          ? `the elite ground in ${region.name}`
          : `the ${ENEMIES[want].plural.toLowerCase()} of ${region.name}`
    return { x: node.x, y: node.y, label, arrive: 90, questId: q.id, hunt: want }
  }

  /** The nearest den that breeds what the task wants, populated ones first. */
  private nearestNodeFor(want: EnemyKind | 'elite' | 'any'): SpawnNode | null {
    let best: SpawnNode | null = null
    let bestScore = Infinity
    for (const n of this.world.nodes) {
      const match = want === 'any' || (want === 'elite' ? n.elite : n.kind === want)
      if (!match) continue
      // An empty den is still the right place; it simply loses a tie.
      const score = dist(this.player.x, this.player.y, n.x, n.y) + (n.alive.length ? 0 : 400)
      if (score < bestScore) {
        bestScore = score
        best = n
      }
    }
    return best
  }

  private nearestBoss(): Enemy | null {
    let best: Enemy | null = null
    let bestD = Infinity
    for (const e of this.enemies) {
      if (!e.alive || !e.bossId) continue
      const d = dist(this.player.x, this.player.y, e.x, e.y)
      if (d < bestD) {
        bestD = d
        best = e
      }
    }
    return best
  }

  /**
   * With nothing in reach, walk to where the work is.
   *
   * The task comes first. A character that always walks to the nearest den
   * finishes a task only by accident, and drifts off the one it was sent to as
   * soon as the local beasts are dead. With no task to serve, the nearest
   * populated den is still the answer.
   */
  private roam(dt: number) {
    const p = this.player
    this.roamRetry = Math.max(0, this.roamRetry - dt)
    const r = this.roamRoute
    if ((!r || dist(p.x, p.y, r.x, r.y) < AUTO.arrive) && this.roamRetry <= 0) this.pickRoam()
    const route = this.roamRoute
    if (!route) {
      // Standing on the ground it wanted, waiting for the next one to walk out
      // of the den. Better than setting off for somewhere else.
      p.moving = false
      p.anim += dt * 3
      return
    }
    // Held up: drop the route and draw a fresh one from where we stand.
    if (!this.stepRoute(dt, route)) this.roamRoute = null
  }

  /**
   * Draw a route to the work. Failure is throttled, because a place with no
   * route costs a whole search of the map to find that out, and a character
   * standing next to one would pay it in every frame.
   */
  private pickRoam() {
    const p = this.player
    const goal = this.autoGoal()
    this.roamRoute = null
    this.roamRetry = 1
    if (!goal || dist(p.x, p.y, goal.x, goal.y) < AUTO.arrive) return
    this.roamRoute = this.routeTo(goal.x, goal.y)
    // No way through to the task's ground is not a reason to stand still.
    if (!this.roamRoute) {
      const den = this.nearestPopulatedNode()
      if (den && dist(p.x, p.y, den.x, den.y) >= AUTO.arrive) {
        this.roamRoute = this.routeTo(den.x, den.y)
      }
    }
    if (this.roamRoute) this.roamRetry = 0
  }

  /**
   * Where auto-battle should be when there is nothing to fight.
   *
   * A task that is only on offer is not counted: taking it needs a
   * conversation, and walking to the giver to stand there would end the hunt
   * rather than advance it. An apex is not counted either, for the same reason
   * auto-battle never targets one.
   */
  private autoGoal(): { x: number; y: number } | null {
    const q = this.quest
    const huntsBoss = q?.objective.type === 'kill' && q.objective.kind === 'boss'
    if (q && !huntsBoss) {
      const dest = this.questDestination(q)
      if (dest) return dest
    }
    return this.nearestPopulatedNode()
  }

  private nearestPopulatedNode(): SpawnNode | null {
    const p = this.player
    let best: SpawnNode | null = null
    let bestD = Infinity
    for (const n of this.world.nodes) {
      if (!n.alive.length) continue
      const d = dist(p.x, p.y, n.x, n.y)
      if (d < bestD) {
        bestD = d
        best = n
      }
    }
    return best
  }

  private stepSwing(dt: number) {
    const p = this.player
    p.attackCd = Math.max(0, p.attackCd - dt)
    if (p.swingT > 0) {
      p.swingT -= dt
      // Damage lands partway through the animation, not on the wind-up.
      if (!this.swingApplied && p.swingT <= SWING_DURATION * 0.55) {
        this.swingApplied = true
        this.resolveSwing()
      }
      if (p.swingT <= 0) p.swingT = 0
      return
    }
    if (p.attackCd > 0) return
    const target = this.nearestEnemy({ x: p.x, y: p.y, maxDistance: this.swingRange + 20, huntable: true })
    if (!target) return
    p.targetId = target.id
    p.facing = Math.atan2(target.y - p.y, target.x - p.x)
    p.dir = facingToDir(p.facing)
    p.swingT = SWING_DURATION
    p.swingDir = p.facing
    p.attackCd = this.stats.attackInterval
    this.swingApplied = false
  }

  private resolveSwing() {
    const p = this.player
    const range = this.swingRange
    const arc = this.swingArc
    let hits = 0
    for (const e of this.enemies) {
      if (!e.alive || e.state === 'return') continue
      const dx = e.x - p.x
      const dy = e.y - p.y
      const d = Math.hypot(dx, dy)
      if (d > range + e.radius) continue
      let da = Math.abs(Math.atan2(dy, dx) - p.swingDir) % (Math.PI * 2)
      if (da > Math.PI) da = Math.PI * 2 - da
      if (da > arc) continue
      this.damageEnemy(e, this.rollDamage(1, e))
      hits++
    }
    this.effects.push({
      kind: 'slash',
      x: p.x + Math.cos(p.swingDir) * 16,
      y: p.y + Math.sin(p.swingDir) * 16 - 14,
      t: 0,
      life: 0.22,
      angle: p.swingDir,
      radius: range * 0.86,
      color: '#eaf1ff',
    })
    if (hits) this.outOfCombat = 0
  }

  /**
   * The target matters now: species, wounds and how crowded you are all move
   * the number, and `ambush` skips the crit roll outright. Passing no target is
   * still valid — it just means none of those rules can apply.
   */
  private rollDamage(mult = 1, target?: Enemy): { amount: number; crit: boolean } {
    let m = mult * this.frenzyMult()
    let certain = false
    if (target) {
      m *= damageVs(this.mods, target.kind)
      if (target.hp >= target.maxHp) {
        m *= this.mods.openerMult
        certain = this.mods.ambush
      }
      if (target.hp <= target.maxHp * EXECUTE_BELOW) m *= this.mods.executeMult
    }
    const crit = certain || this.rand() < this.stats.crit
    const base = this.stats.damage * m * this.rand.range(0.9, 1.1)
    return { amount: Math.max(1, Math.round(base * (crit ? CRIT_MULT : 1))), crit }
  }

  /** Warlord: the more of them there are, the harder each blow lands. */
  private frenzyMult(): number {
    if (this.mods.frenzyPer <= 0) return 1
    const near = this.countEnemiesWithin(this.player.x, this.player.y, this.whirlwindRadius)
    return 1 + Math.min(this.mods.frenzyCap, this.mods.frenzyPer * Math.max(0, near - 1))
  }

  /* ================= abilities ================= */

  useAbility(id: 'whirlwind' | 'secondwind'): boolean {
    const ab = this.abilities.find((a) => a.id === id)
    if (!ab || ab.cd > 0 || !this.player.alive) return false
    const p = this.player
    if (id === 'whirlwind') {
      ab.cd = ab.cooldown
      const radius = this.whirlwindRadius
      let hits = 0
      for (const e of this.enemies) {
        if (!e.alive || e.state === 'return') continue
        if (dist(p.x, p.y, e.x, e.y) > radius + e.radius) continue
        this.damageEnemy(e, this.rollDamage(WHIRLWIND.damageMult * this.mods.wwDamageMult, e))
        hits++
      }
      this.effects.push({
        kind: 'ring',
        x: p.x,
        y: p.y - 12,
        t: 0,
        life: 0.42,
        angle: 0,
        radius,
        color: this.mods.emberTrail ? '#ffb066' : '#cfe0ff',
      })
      if (this.mods.emberTrail) this.lightGround(p.x, p.y, radius * EMBER.radiusMult)
      // Stormcrow Quill: a spin through a flock pays for most of the next one.
      if (this.mods.wwRefundPerHit > 0 && hits > 0) {
        ab.cd = Math.max(0, ab.cd - hits * this.mods.wwRefundPerHit)
      }
      this.hooks.log(hits ? `Whirlwind hits ${hits}` : 'Whirlwind swings wide', '#cfe0ff')
    } else {
      ab.cd = ab.cooldown
      const heal = Math.round(p.maxHp * SECOND_WIND.healFraction * this.mods.swHealMult)
      p.hp = Math.min(p.maxHp, p.hp + heal)
      this.pushFloat(p.x, p.y - 34, `+${heal}`, '#7ed48d', 9)
      this.effects.push({
        kind: 'heal',
        x: p.x,
        y: p.y - 10,
        t: 0,
        life: 0.7,
        angle: 0,
        radius: 34,
        color: '#7ed48d',
      })
    }
    this.hooks.dirty()
    return true
  }

  /**
   * Emberfang's burning ground. Damage is fixed at the moment it is lit rather
   * than sampled per tick, so a patch is worth what the swing that made it was
   * worth — dropping your weapon mid-burn does not put the fire out.
   */
  private lightGround(x: number, y: number, radius: number) {
    this.grounds.push({
      x,
      y,
      radius,
      t: 0,
      life: EMBER.seconds,
      perTick: Math.max(1, Math.round(this.stats.damage * EMBER.dpsFraction * EMBER.tick)),
      next: EMBER.tick,
    })
  }

  private stepGrounds(dt: number) {
    for (let i = this.grounds.length - 1; i >= 0; i--) {
      const g = this.grounds[i]!
      g.t += dt
      g.next -= dt
      if (g.next <= 0) {
        g.next += EMBER.tick
        for (const e of this.spatial.queryRadius(g.x, g.y, g.radius + 80)) {
          if (!e.alive || e.state === 'return') continue
          if (dist(e.x, e.y, g.x, g.y) > g.radius + e.radius) continue
          this.damageEnemy(e, { amount: g.perTick, crit: false }, 'burn')
        }
      }
      if (g.t >= g.life) this.grounds.splice(i, 1)
    }
  }

  /* ================= enemies ================= */

  private stepEnemies(dt: number) {
    const p = this.player
    const active: Enemy[] = []

    for (const e of this.enemies) {
      if (!e.alive) continue
      const d = dist(e.x, e.y, p.x, p.y)
      e.hitFlash = Math.max(0, e.hitFlash - dt)
      // Distant packs are frozen. Anything still mid-chase out there has
      // clearly lost the player, so send it straight home.
      if (d > 1500) {
        if (isEngaged(e.state) || e.state === 'return') {
          e.x = e.ax
          e.y = e.ay
          e.hp = e.maxHp
          this.setEnemyState(e, 'idle')
        }
        continue
      }
      active.push(e)
      this.stepEnemy(e, dt, d)
    }

    // Soft separation uses neighboring spatial cells instead of an N² scan.
    this.spatial.rebuild(active)
    for (const a of active) {
      for (const b of this.spatial.queryRadius(a.x, a.y, a.radius * 2 + 80)) {
        if (b.id <= a.id) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const min = a.radius + b.radius
        const d2 = dx * dx + dy * dy
        if (d2 > min * min || d2 < 0.0001) continue
        const d = Math.sqrt(d2)
        const push = ((min - d) / d) * 0.5
        a.x -= dx * push
        a.y -= dy * push
        b.x += dx * push
        b.y += dy * push
      }
    }
  }

  private stepEnemy(e: Enemy, dt: number, dPlayer: number) {
    const p = this.player
    const type = ENEMIES[e.kind]
    e.stateT += dt
    e.attackCd = Math.max(0, e.attackCd - dt)
    e.special = Math.max(0, e.special - dt)
    e.moving = false

    if (e.state === 'return') {
      const d = dist(e.x, e.y, e.ax, e.ay)
      e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 1.2 * dt)
      if (d < 24) {
        this.setEnemyState(e, 'idle')
        e.hp = e.maxHp
        return
      }
      const a = Math.atan2(e.ay - e.y, e.ax - e.x)
      this.moveEntity(e, Math.cos(a) * e.speed * 1.7 * dt, Math.sin(a) * e.speed * 1.7 * dt)
      e.facing = a
      e.moving = true
      e.anim += dt * 11
      e.dir = facingToDir(e.facing)
      return
    }

    // --- aggro / de-aggro ---------------------------------------------
    // A species trick counts as engagement, so the de-aggro rule governs a
    // charging boar and a scattering flock exactly as it governs a wolf.
    if (isEngaged(e.state)) {
      if (this.shouldGiveUp(e, dPlayer)) {
        this.setEnemyState(e, 'return')
        this.pushFloat(e.x, e.y - 28, 'lost interest', '#8b93a5', 7)
        return
      }
    } else if (
      p.alive &&
      dPlayer < e.aggroRange &&
      !this.world.campAt(p.x, p.y) &&
      dist(p.x, p.y, e.ax, e.ay) < e.leash
    ) {
      this.setEnemyState(e, 'chase')
      if (e.elite) this.pushFloat(e.x, e.y - 34, '!', '#ff6a3d', 11)
    }

    switch (e.state) {
      case 'idle':
        if (e.stateT > 1.4 + this.rand() * 2.4) {
          const node = this.world.nodes[e.nodeId]
          if (node) {
            const w = this.world.nodeWanderPoint(node, this.rand)
            e.wx = w.x
            e.wy = w.y
          }
          this.setEnemyState(e, 'wander')
        }
        e.anim += dt * 2
        break

      case 'wander': {
        const d = dist(e.x, e.y, e.wx, e.wy)
        if (d < 18 || e.stateT > 6) {
          this.setEnemyState(e, 'idle')
          break
        }
        const a = Math.atan2(e.wy - e.y, e.wx - e.x)
        this.moveEntity(e, Math.cos(a) * e.speed * 0.4 * dt, Math.sin(a) * e.speed * 0.4 * dt)
        e.facing = a
        e.moving = true
        e.anim += dt * 4
        break
      }

      case 'chase': {
        const reach = e.attackRange + p.radius
        if (dPlayer <= reach && e.attackCd <= 0) {
          this.setEnemyState(e, 'attack')
          e.windup = type.windup
          break
        }
        // A boar would rather run at you than walk to you, but only from far
        // enough out that the wind-up is visible and the line is dodgeable.
        if (
          type.behaviour === 'charge' &&
          e.special <= 0 &&
          dPlayer > reach * 1.6 &&
          dPlayer < BEHAVIOUR.charge.range
        ) {
          this.setEnemyState(e, 'charge')
          e.windup = BEHAVIOUR.charge.windup
          this.pushFloat(e.x, e.y - 30, '!', '#ffb066', 9)
          break
        }
        const a = Math.atan2(p.y - e.y, p.x - e.x)
        e.facing = a
        if (dPlayer > reach * 0.85) {
          this.moveEntity(e, Math.cos(a) * e.speed * dt, Math.sin(a) * e.speed * dt)
          e.moving = true
          e.anim += dt * 10
        } else {
          e.anim += dt * 3
        }
        break
      }

      case 'attack': {
        e.facing = Math.atan2(p.y - e.y, p.x - e.x)
        e.windup -= dt
        e.anim += dt * 6
        if (e.windup <= 0) {
          const reach = e.attackRange + p.radius + 8
          if (dPlayer <= reach) this.damagePlayer(e)
          e.attackCd = type.attackCd
          this.setEnemyState(e, 'chase')
        }
        break
      }

      /**
       * The boar's run. It tracks the player while pawing the ground and then
       * stops steering entirely — a charge that homed in would be an attack
       * with extra steps, where a committed line is something you can walk out
       * of. It ends on contact, on a wall, or when it simply runs out.
       */
      case 'charge': {
        if (e.windup > 0) {
          e.windup -= dt
          e.facing = Math.atan2(p.y - e.y, p.x - e.x)
          e.anim += dt * 5
          if (e.windup <= 0) {
            e.vx = Math.cos(e.facing)
            e.vy = Math.sin(e.facing)
            e.stateT = 0
          }
          break
        }
        const speed = e.speed * BEHAVIOUR.charge.speedMult
        const fromX = e.x
        const fromY = e.y
        this.moveEntity(e, e.vx * speed * dt, e.vy * speed * dt)
        e.moving = true
        e.anim += dt * 18
        const travelled = dist(fromX, fromY, e.x, e.y)
        const gap = dist(e.x, e.y, p.x, p.y)
        if (p.alive && gap <= e.attackRange + p.radius) {
          this.damagePlayer(e, BEHAVIOUR.charge.damageMult)
          this.endCharge(e)
        } else if (travelled < speed * dt * 0.5 || e.stateT > BEHAVIOUR.charge.seconds) {
          // Ran into water, a shoulder of rock, or simply out of run.
          this.endCharge(e)
        }
        break
      }

      /**
       * Blown off the kill. Flies the heading it was given when the flock
       * broke, then re-forms — the ordinary chase rules take it from there.
       */
      case 'scatter': {
        const speed = e.speed * BEHAVIOUR.flock.speedMult
        this.moveEntity(e, e.vx * speed * dt, e.vy * speed * dt)
        e.facing = Math.atan2(e.vy, e.vx)
        e.moving = true
        e.anim += dt * 16
        if (e.stateT > BEHAVIOUR.flock.seconds) this.setEnemyState(e, 'chase')
        break
      }

      default:
        break
    }

    // Never let a beast stand inside the player's sprite.
    const overlap = e.radius + p.radius - dPlayer
    if (overlap > 0 && dPlayer > 0.001) {
      e.x += ((e.x - p.x) / dPlayer) * overlap
      e.y += ((e.y - p.y) / dPlayer) * overlap
    }
    e.dir = facingToDir(e.facing)
  }

  /**
   * The chase ends when the enemy is dragged off the visible screen, pulled
   * too far from home, or the player reaches the safety of a camp.
   */
  private shouldGiveUp(e: Enemy, dPlayer: number): boolean {
    const p = this.player
    if (!p.alive) return true
    if (this.world.campAt(p.x, p.y)) return true
    // `leashMult` is only ever set below 1 — content may end a chase sooner,
    // never stretch it, or the no-monster-trains rule stops being a rule.
    const shorten = Math.min(1, this.mods.leashMult)
    if (dist(e.x, e.y, e.ax, e.ay) > e.leash * shorten) return true
    if (dPlayer > e.aggroRange * 2.6 * shorten) return true
    const pad = 30
    const off =
      e.x < this.view.x0 - pad ||
      e.x > this.view.x1 + pad ||
      e.y < this.view.y0 - pad ||
      e.y > this.view.y1 + pad
    return off
  }

  private setEnemyState(e: Enemy, s: Enemy['state']) {
    e.state = s
    e.stateT = 0
  }

  /** Back to an ordinary chase, and no second run for a while. */
  private endCharge(e: Enemy) {
    e.special = BEHAVIOUR.charge.cooldown
    e.attackCd = Math.max(e.attackCd, ENEMIES[e.kind].attackCd)
    this.setEnemyState(e, 'chase')
  }

  /**
   * One rook is hit and the whole unkindness leaves at once, each on its own
   * heading away from the player, re-forming a second later. Scoped to the
   * node so a flock is a flock rather than every bird on the crag.
   */
  private scatterFlock(hit: Enemy) {
    const p = this.player
    for (const e of this.enemies) {
      if (!e.alive || e.kind !== hit.kind || e.nodeId !== hit.nodeId) continue
      if (e.state === 'return' || e.state === 'scatter') continue
      if (dist(e.x, e.y, hit.x, hit.y) > BEHAVIOUR.flock.radius) continue
      const away = Math.atan2(e.y - p.y, e.x - p.x) + this.rand.range(-0.6, 0.6)
      e.vx = Math.cos(away)
      e.vy = Math.sin(away)
      e.facing = away
      // The cooldown is what keeps this a disruption rather than a kite: a
      // rook that broke off on every blow could never be finished.
      e.special = BEHAVIOUR.flock.cooldown
      this.setEnemyState(e, 'scatter')
    }
  }

  /* ================= damage ================= */

  damageEnemy(e: Enemy, hit: { amount: number; crit: boolean }, source: 'hit' | 'burn' = 'hit') {
    if (!e.alive) return
    e.hp -= hit.amount
    e.hitFlash = 0.12
    this.outOfCombat = 0
    this.pushFloat(
      e.x + this.rand.range(-6, 6),
      e.y - e.radius - 12,
      `${hit.amount}`,
      source === 'burn' ? '#ff9b4a' : hit.crit ? '#ffd166' : '#ffffff',
      hit.crit ? 10 : 8,
    )
    // Burning ground ticks twice a second on everything standing in it; a spark
    // per beast per tick would bury the screen for no extra information.
    if (source === 'hit') {
      this.effects.push({
        kind: 'spark',
        x: e.x,
        y: e.y - e.radius * 0.6,
        t: 0,
        life: 0.18,
        angle: this.rand() * Math.PI * 2,
        radius: 9,
        color: '#ffe6c0',
      })
    }
    // Getting hit while wandering is a valid way to start a fight.
    if (e.state === 'idle' || e.state === 'wander') this.setEnemyState(e, 'chase')
    if (e.hp <= 0) {
      this.killEnemy(e)
      return
    }
    // Survivors of a flock break off together. Done after the kill check so a
    // dead rook does not take its neighbours with it, and only on a blow —
    // burning ground ticks twice a second and would herd a flock forever.
    if (source === 'hit' && ENEMIES[e.kind].behaviour === 'flock' && e.special <= 0) {
      this.scatterFlock(e)
    }
  }

  /**
   * `mult` is the charge's extra weight — the one attack in the game that is
   * worth more than the statline, because it costs the animal its wind-up and
   * its ability to steer.
   */
  private damagePlayer(e: Enemy, mult = 1) {
    const p = this.player
    if (!p.alive || p.invuln > 0) return
    const raw = e.dmg * mult * this.rand.range(0.9, 1.12)
    const resist = resistFrom(this.mods, e.kind)
    let amount = Math.max(1, Math.round(mitigate(raw, this.stats.armor, e.level) * resist))
    // A cap on the largest single blow. Default is the whole health bar, which
    // is no cap at all, so nothing special-cases the absence of a relic.
    amount = Math.min(amount, Math.max(1, Math.round(p.maxHp * this.mods.maxHitFraction)))
    if (ENEMIES[e.kind].behaviour === 'web') this.applyWeb()
    p.hp -= amount
    p.hitFlash = 0.18
    this.outOfCombat = 0
    this.pushFloat(p.x + this.rand.range(-6, 6), p.y - 40, `-${amount}`, '#ff8b82', 9)
    if (p.hp <= 0) {
      p.hp = 0
      p.alive = false
      p.deadT = 0
      this.hooks.banner('You Fell', 'Returning to the nearest camp…')
      this.hooks.dirty()
    }
  }

  /**
   * Webbing. It does not stack in duration — a second bite refreshes it rather
   * than accumulating, or a nest of spiders would pin a character in place
   * permanently, which is a stun and not what this is.
   */
  private applyWeb() {
    const p = this.player
    if (this.mods.webproof) return
    const fresh = p.webbed <= 0
    p.webbed = BEHAVIOUR.web.seconds
    if (fresh) {
      this.pushFloat(p.x, p.y - 46, 'webbed', '#cfe6b0', 8)
      this.effects.push({
        kind: 'ring',
        x: p.x,
        y: p.y - 6,
        t: 0,
        life: 0.5,
        angle: 0,
        radius: 26,
        color: '#cfe6b0',
      })
    }
  }

  /**
   * The world half of a kill: the bookkeeping every observer of a shared world
   * would agree on, and which must happen exactly once no matter how many
   * players landed a hit. Grants nothing — rewards live in `creditKill`.
   */
  private killEnemy(e: Enemy) {
    e.alive = false
    e.hp = 0
    e.state = 'dead'
    this.corpses.push({
      x: e.x,
      y: e.y,
      sheet: e.sheet,
      lean: this.rand() < 0.5 ? Math.PI / 2 : -Math.PI / 2,
      t: 0,
    })
    this.effects.push({
      kind: 'burst',
      x: e.x,
      y: e.y - e.radius * 0.5,
      t: 0,
      life: 0.36,
      angle: 0,
      radius: e.radius * 1.6,
      color: e.elite ? '#ff9b5c' : '#d8c9a8',
    })

    // Bookkeeping for the node this beast belonged to. A boss has none — its
    // return is the clock's business, not a den's.
    const node = this.world.nodes[e.nodeId]
    if (node) {
      const i = node.alive.indexOf(e.id)
      if (i >= 0) node.alive.splice(i, 1)
      node.respawnAt = this.time + (e.elite ? 45 : 9 + this.rand() * 8)
    }
    if (e.bossId) {
      this.bossCleared[e.bossId] = bossWindow(this.dependencies.clock.now())
      const def = bossById(e.bossId)
      if (def) this.hooks.banner(def.name, `${def.title} — felled`)
    }

    this.creditKill(e)
    this.hooks.dirty()
  }

  /**
   * The private half of a kill: everything owned by one character rather than by
   * the world. Split out from `killEnemy` because credit is universal — every
   * player who damaged the beast earns the full amount, so once the world is
   * shared this runs once per contributor while the bookkeeping above runs once.
   *
   * (Today there is one player, and `gainXp`/`gainGold`/`addItem` all write to
   * `this.player`. Taking a player argument here would only pretend to credit
   * someone else, so the loop lands with the player registry, not before it.)
   */
  private creditKill(e: Enemy) {
    // Acknowledgment is unconditional; only the payout scales. Mastery reads
    // off these counters, so its tier can only ever move here.
    const tierBefore = masteryTier(this.counters.species[e.kind])
    this.counters.kills++
    this.counters.species[e.kind]++
    if (e.elite) this.counters.elite++
    if (e.bossId) this.counters.bosses++
    this.advanceQuestOnKill(e)
    const tierAfter = masteryTier(this.counters.species[e.kind])
    if (tierAfter > tierBefore) this.announceMastery(e.kind, tierAfter)

    // Gold and drops keep the floored curve — a trivial beast is still worth
    // looting. Experience alone can reach zero, so a region can be outgrown.
    const scale = rewardScale(this.player.level, e.level)
    const xps = xpScale(this.player.level, e.level)
    this.gainGold(Math.max(1, Math.round(e.goldValue * scale * this.mods.goldMult)))
    if (xps > 0) this.gainXp(Math.max(1, Math.round(e.xpValue * xps)))
    this.rollDrop(e, scale)
    this.rollUnique(e, scale)
    this.payKillRules()
  }

  /**
   * Rules that fire on a kill regardless of what died — the half of a relic or
   * talent that is a verb rather than a number.
   */
  private payKillRules() {
    const p = this.player
    if (this.mods.lifeOnKill > 0 && p.hp < p.maxHp) {
      const heal = Math.max(1, Math.round(p.maxHp * this.mods.lifeOnKill))
      p.hp = Math.min(p.maxHp, p.hp + heal)
      this.pushFloat(p.x, p.y - 40, `+${heal}`, '#7ed48d', 8)
    }
    if (this.mods.breathOnKill > 0) {
      const sw = this.abilities[1]!
      sw.cd =
        p.hp < p.maxHp * DESPERATE_BELOW ? 0 : Math.max(0, sw.cd - this.mods.breathOnKill)
    }
  }

  private announceMastery(kind: Enemy['kind'], tier: number) {
    // Mastery feeds `mods`, so the build genuinely changes at a threshold.
    this.recalc()
    const t = MASTERY_TIERS[tier]
    if (t) this.hooks.banner(`${ENEMIES[kind].name} — ${t.name}`, 'Beast mastery deepens')
  }

  /* ================= loot & progression ================= */

  private rollDrop(e: Enemy, scale = 1) {
    const type = ENEMIES[e.kind]
    const chance = (e.elite ? ELITE.dropChance : type.dropChance) * scale * this.mods.dropChanceMult
    if (this.rand() > chance) return
    const rarity = Math.min(
      4,
      Math.max(
        0,
        (e.elite ? ELITE.rarityBonus : 0) +
          (this.rand() < 0.5 ? 0 : 1) +
          (this.rand() < 0.16 ? 1 : 0),
      ),
    )
    // Item level slides from the beast's level toward the player's own as the
    // gap widens, so a lucky tap on something far above you still yields gear
    // you could have earned rather than a jackpot.
    const ilvl = e.level * scale + this.player.level * (1 - scale)
    const item = makeItem(this.rand, Math.max(1, Math.round(ilvl) + this.rand.int(-1, 2)), rarity, this.uids)
    this.addItem(item)
  }

  /**
   * Only elites carry relics, only ones this character has never found, and the
   * chance rides the same level-gap curve as everything else — tapping an Elder
   * Bear at level 3 must not be the fastest way to a build.
   *
   * Item level tracks the *player*, not the beast, because there is exactly one
   * of each and it has to stay wearable.
   */
  private rollUnique(e: Enemy, scale: number) {
    if (!e.elite) return
    // An apex is the one encounter a player can plan to be present for, so it
    // is also the reliable way to finish a set.
    const chance = e.bossId ? BOSS.uniqueChance : UNIQUE_DROP_CHANCE
    if (this.rand() > chance * scale) return
    const pool = UNIQUES.filter(
      (u) => !this.foundUniques.has(u.id) && (u.from === null || u.from === e.kind),
    )
    if (!pool.length) return
    const def = this.rand.pick(pool)
    this.foundUniques.add(def.id)
    this.hooks.banner('Relic Found', def.name)
    this.addItem(makeUnique(def, this.player.level, this.uids))
  }

  addItem(item: Item) {
    // A relic is never ranked in either direction: auto-equip will not put one
    // on, and will not take one off. `itemScore` cannot see the rule it carries,
    // so letting it decide would quietly undo the only choice in the game.
    if (item.unique) {
      this.stowUnique(item)
      return
    }
    const slot = this.bag.indexOf(null)
    const current = this.equipped[item.slot]
    const better = !current?.unique && itemScore(item) > itemScore(current)
    if (this.autoEquip && better) {
      const old = this.equipped[item.slot]
      this.equipped[item.slot] = item
      this.recalc()
      this.hooks.log(`Equipped ${item.name}`, '#7ed48d')
      if (old) {
        if (slot >= 0) this.bag[slot] = old
        else this.sellItem(old, true)
      }
      this.hooks.dirty()
      return
    }
    if (slot < 0) {
      this.sellItem(item, true)
      return
    }
    this.bag[slot] = item
    this.hooks.log(`Looted ${item.name}${better ? ' ▲' : ''}`, better ? '#7ed48d' : undefined)
    this.hooks.dirty()
  }

  /**
   * Relics are unsellable, so the bag-overflow auto-sell that catches ordinary
   * loot must never reach one. A full bag makes room by selling its worst
   * ordinary item instead — with forty slots and six relics in the whole game,
   * there is always one to sell.
   */
  private stowUnique(item: Item) {
    let slot = this.bag.indexOf(null)
    if (slot < 0) {
      let worst = -1
      let worstScore = Infinity
      for (let i = 0; i < this.bag.length; i++) {
        const it = this.bag[i]
        if (!it || it.unique) continue
        const s = itemScore(it)
        if (s < worstScore) {
          worstScore = s
          worst = i
        }
      }
      if (worst < 0) {
        this.hooks.log(`No room for ${item.name}`, '#ff8b82')
        return
      }
      const evicted = this.bag[worst]!
      this.bag[worst] = null
      this.sellItem(evicted, true)
      slot = worst
    }
    this.bag[slot] = item
    const def = uniqueDefOf(item)
    this.hooks.log(`${item.name} — ${def?.rule ?? ''}`, RARITY_COLORS[4])
    this.hooks.dirty()
  }

  sellItem(item: Item, auto = false) {
    this.gainGold(item.value)
    this.hooks.log(
      `${auto ? 'Bag full — sold' : 'Sold'} ${item.name} for ${item.value}g`,
      '#d8c07a',
    )
    this.hooks.dirty()
  }

  sellFromBag(index: number) {
    const item = this.bag[index]
    if (!item) return
    // There is one of each relic and it never drops again. Nothing in the game
    // may turn one into gold, least of all a stray right-click.
    if (item.unique) {
      this.hooks.log(`${item.name} cannot be sold`, '#ff8b82')
      return
    }
    this.bag[index] = null
    this.sellItem(item)
  }

  equipFromBag(index: number) {
    const item = this.bag[index]
    if (!item) return
    const old = this.equipped[item.slot]
    this.equipped[item.slot] = item
    this.bag[index] = old
    this.recalc()
    this.hooks.log(`Equipped ${item.name}`, '#7ed48d')
    this.hooks.dirty()
  }

  unequip(slot: Slot) {
    const item = this.equipped[slot]
    if (!item) return
    const free = this.bag.indexOf(null)
    if (free < 0) {
      this.hooks.log('Bag is full', '#ff8b82')
      return
    }
    this.bag[free] = item
    this.equipped[slot] = null
    this.recalc()
    this.hooks.dirty()
  }

  gainGold(amount: number) {
    this.player.gold += amount
    this.counters.gold += amount
  }

  /** `quiet` suppresses the per-level banner and flourish — used when settling
   *  an offline run, where several levels land at once and the report says so. */
  gainXp(amount: number, quiet = false) {
    const p = this.player
    p.xp += amount
    while (p.xp >= p.xpNext) {
      p.xp -= p.xpNext
      p.level++
      p.str += 2
      p.vit += 2
      p.agi += 1
      p.xpNext = xpForLevel(p.level)
      this.recalc()
      p.hp = p.maxHp
      if (quiet) continue
      // A row unlocking is the more interesting half of the level-up, so it
      // gets the banner and the stat trickle drops to a log line.
      const row = TALENT_ROWS.find((r) => r.level === p.level)
      if (row) {
        this.hooks.banner('Talent Unlocked', row.name)
        this.hooks.log(`Level ${p.level} — choose a ${row.name} talent`, '#9ad0ff')
      } else {
        this.hooks.banner(`Level ${p.level}`, '+2 Strength  +2 Vitality  +1 Agility')
      }
      this.effects.push({
        kind: 'ring',
        x: p.x,
        y: p.y - 12,
        t: 0,
        life: 0.8,
        angle: 0,
        radius: 70,
        color: '#f2c14e',
      })
    }
  }

  /* ---- quests ---- */

  /**
   * The task in progress, and the one place that decides whether progress
   * counts. A task an NPC holds is not this task until the player takes it, so
   * kills, camps and the offline ledger all stop crediting it through one
   * getter rather than through a check at each of the three.
   */
  get quest(): QuestDef | null {
    const q = QUESTS[this.questIndex] ?? null
    if (!q) return null
    return q.from && !this.questTaken ? null : q
  }

  /** The task a person is holding out, which the player has not taken yet. */
  get offeredQuest(): QuestDef | null {
    const q = QUESTS[this.questIndex] ?? null
    if (!q) return null
    return q.from && !this.questTaken ? q : null
  }

  /** The task this person is holding out right now, if it is theirs to give. */
  offerFrom(npc: Npc): QuestDef | null {
    const q = this.offeredQuest
    return q && q.from === npc.id ? q : null
  }

  /** Take the offered task. Nothing done before this counts toward it. */
  acceptQuest() {
    const q = this.offeredQuest
    if (!q) return
    this.questTaken = true
    this.questProgress = 0
    // The journey to the giver ends at the giver.
    if (this.travel?.questId === q.id) this.endTravel(true)
    this.hooks.banner('Task Accepted', q.name)
    this.hooks.log(`New task: ${q.name}`, '#f2c14e')
    this.hooks.dirty()
  }

  get questGoal(): number {
    const q = this.quest
    if (!q) return 0
    return q.objective.type === 'kill' ? q.objective.count : 1
  }

  private advanceQuestOnKill(e: Enemy) {
    const q = this.quest
    if (!q || q.objective.type !== 'kill') return
    const want = q.objective.kind
    // A wolf quest counts alphas too — they are still wolves.
    const match =
      want === 'any' ||
      (want === 'elite' ? e.elite : want === 'boss' ? !!e.bossId : want === e.kind)
    if (!match) return
    this.questProgress++
    if (this.questProgress >= q.objective.count) this.completeQuest()
  }

  isDiscovered(camp: Camp): boolean {
    return this.discovered.has(camp.id)
  }

  /**
   * A landmark grants nothing. It is worth marking anyway — the whole value of
   * a named place is that you can tell someone else about it, and a place you
   * walked past without noticing has no name to tell.
   */
  private findLandmark(l: Landmark) {
    this.seenLandmarks.add(l.id)
    this.hooks.banner(l.name, this.world.regionAt(l.x, l.y).name)
    this.hooks.log(`${l.name} — ${l.blurb}`, '#cbb489')
    this.hooks.dirty()
  }

  /**
   * Standing in a camp. Discovery happens once; the task check happens every
   * time. A player who walked into Thornrest before anyone asked them to would
   * otherwise hold a task that no later visit could ever finish.
   */
  private enterCamp(camp: Camp) {
    if (!this.discovered.has(camp.id)) {
      this.discovered.add(camp.id)
      this.hooks.banner('Camp Discovered', camp.name)
      this.hooks.log(`Discovered ${camp.name}`, '#f2c14e')
      this.hooks.dirty()
    }
    const q = this.quest
    if (q && q.objective.type === 'reach' && q.objective.camp === camp.id) {
      this.questProgress = 1
      this.completeQuest()
    }
  }

  private completeQuest() {
    const q = this.quest
    if (!q) return
    this.counters.quests++
    // Finishing the task is the end of the journey it was for, and it counts as
    // arriving: a camp reached is a camp reached, whichever check saw it first.
    if (this.travel?.questId === q.id) this.endTravel(true)
    this.grantReward(q.reward, `Quest Complete`, q.name)
    this.questIndex++
    this.questProgress = 0
    this.questTaken = false
    const next = QUESTS[this.questIndex] ?? null
    if (next && !next.from) this.hooks.log(`New task: ${next.name}`, '#f2c14e')
    else if (next) {
      const who = npcById(next.from!)
      this.hooks.log(`Speak to ${who?.name ?? 'the camp'} for the next task.`, '#f2c14e')
    }
    this.hooks.dirty()
  }

  private grantReward(reward: QuestReward, title: string, sub: string) {
    if (reward.xp) this.gainXp(reward.xp)
    if (reward.gold) this.gainGold(reward.gold)
    if (reward.item) {
      const item = makeItem(this.rand, reward.item.ilvl, reward.item.rarity, this.uids, reward.item.base)
      this.addItem(item)
    }
    this.hooks.banner(title, sub)
    const bits = [reward.xp ? `${reward.xp} xp` : '', reward.gold ? `${reward.gold}g` : '']
      .filter(Boolean)
      .join(', ')
    if (bits) this.hooks.log(`Reward: ${bits}`, '#f2c14e')
  }

  /* ---- milestones ---- */

  metricValue(metric: Metric): number {
    switch (metric) {
      case 'kills':
        return this.counters.kills
      case 'elite':
        return this.counters.elite
      case 'bosses':
        return this.counters.bosses
      case 'gold':
        return this.counters.gold
      case 'level':
        return this.player.level
      case 'quests':
        return this.counters.quests
      default:
        // `slain:<kind>` — the only remaining shape of the union.
        return this.counters.species[metric.slice(6) as EnemyKind] ?? 0
    }
  }

  get claimableCount(): number {
    let n = 0
    for (const m of MILESTONES) {
      if (!this.claimed.has(m.id) && this.metricValue(m.metric) >= m.threshold) n++
    }
    return n
  }

  claimMilestone(id: string): boolean {
    const m = MILESTONES.find((x) => x.id === id)
    if (!m || this.claimed.has(m.id)) return false
    if (this.metricValue(m.metric) < m.threshold) return false
    this.claimed.add(m.id)
    this.grantReward(m.reward, 'Reward Claimed', m.name)
    this.hooks.dirty()
    return true
  }

  /* ================= misc ================= */

  private stepRegen(dt: number) {
    const p = this.player
    p.hitFlash = Math.max(0, p.hitFlash - dt)
    p.invuln = Math.max(0, p.invuln - dt)
    p.webbed = Math.max(0, p.webbed - dt)
    this.outOfCombat += dt
    if (p.hp >= p.maxHp) return
    let rate = 0
    if (this.currentCamp) rate = 0.14
    else if (this.outOfCombat > 5) rate = 0.03 * this.mods.regenMult
    if (rate > 0) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * rate * dt)
  }

  private stepSpawns() {
    for (const node of this.world.nodes) {
      if (node.alive.length >= node.cap) continue
      if (this.time < node.respawnAt) continue
      const pos = this.world.nodeWanderPoint(node, this.rand)
      if (dist(pos.x, pos.y, this.player.x, this.player.y) < 320) continue
      this.spawnEnemy(node, pos.x, pos.y)
      node.respawnAt = this.time + 3 + this.rand() * 4
    }
    // Reap the dead — their corpse now lives in the corpse list instead.
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (!this.enemies[i]!.alive) this.enemies.splice(i, 1)
    }
  }

  private stepTransient(dt: number) {
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i]!
      f.t += dt
      f.y += f.vy * dt
      f.vy += 26 * dt
      if (f.t >= f.life) this.floats.splice(i, 1)
    }
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i]!
      e.t += dt
      if (e.t >= e.life) this.effects.splice(i, 1)
    }
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i]!
      c.t += dt
      if (c.t > 9) this.corpses.splice(i, 1)
    }
  }

  private respawn() {
    const p = this.player
    let camp = CAMPS[0]!
    let best = Infinity
    for (const c of CAMPS) {
      if (!this.isDiscovered(c)) continue
      const d = dist(p.x, p.y, c.x, c.y)
      if (d < best) {
        best = d
        camp = c
      }
    }
    p.x = camp.x
    p.y = camp.y + 70
    p.hp = p.maxHp
    p.alive = true
    p.deadT = 0
    p.invuln = 2
    p.webbed = 0
    p.targetId = -1
    this.roamRoute = null
    // The route started somewhere else. Waking at a camp makes it nonsense.
    this.cancelTravel()
    for (const e of this.enemies) {
      if (isEngaged(e.state)) this.setEnemyState(e, 'return')
    }
    this.hooks.log(`Recovered at ${camp.name}`, '#9ad0ff')
    this.hooks.dirty()
  }

  pushFloat(x: number, y: number, text: string, color: string, size: number) {
    this.floats.push({ x, y, vy: -26, t: 0, life: 0.85, text, color, size })
  }

  enemyById(id: number): Enemy | null {
    if (id < 0) return null
    for (const e of this.enemies) if (e.id === id) return e
    return null
  }

  /**
   * `skipBosses` is for the auto-battle *seek* only. Auto-battle picking a
   * fight with an apex would walk a level 3 character into a level 10 wall,
   * die, respawn, and walk back — forever. Swinging at one that is already in
   * reach still works, so choosing to fight a boss stays the player's call and
   * only the choosing is taken away from the robot.
   */
  nearestEnemy(options: {
    x: number
    y: number
    maxDistance: number
    huntable?: boolean
    skipBosses?: boolean
    /** Only this species, or only elites. Left out, anything counts. */
    only?: EnemyKind | 'elite'
  }): Enemy | null {
    const { x, y, maxDistance, huntable = false, skipBosses = false, only } = options
    let best: Enemy | null = null
    let bestD = maxDistance
    for (const e of this.spatial.queryRadius(x, y, maxDistance + 80)) {
      if (!e.alive) continue
      if (skipBosses && e.bossId) continue
      if (huntable && e.state === 'return') continue
      if (only && (only === 'elite' ? !e.elite : e.kind !== only)) continue
      const d = dist(x, y, e.x, e.y) - e.radius
      if (d < bestD) {
        bestD = d
        best = e
      }
    }
    return best
  }

  countEnemiesWithin(x: number, y: number, r: number): number {
    let n = 0
    for (const e of this.spatial.queryRadius(x, y, r + 80)) {
      if (e.alive && e.state !== 'return' && dist(x, y, e.x, e.y) <= r + e.radius) n++
    }
    return n
  }

  enemiesInRect(view: ViewRect, padding = 0): readonly Enemy[] {
    return this.spatial.queryRect(
      view.x0 - padding,
      view.y0 - padding,
      view.x1 + padding,
      view.y1 + padding,
    )
  }

  get state(): GameSnapshot {
    return this.snapshot()
  }

  snapshot(): Readonly<GameSnapshot> {
    const cloneItem = (item: Item | null): Item | null =>
      item ? { ...item, stats: { ...item.stats } } : null
    return Object.freeze({
      player: Object.freeze({ ...this.player }),
      enemies: Object.freeze(this.enemies.map((enemy) => Object.freeze({ ...enemy }))),
      bag: Object.freeze(this.bag.map(cloneItem)),
      equipped: Object.freeze({
        weapon: cloneItem(this.equipped.weapon),
        head: cloneItem(this.equipped.head),
        chest: cloneItem(this.equipped.chest),
        hands: cloneItem(this.equipped.hands),
        feet: cloneItem(this.equipped.feet),
        ring: cloneItem(this.equipped.ring),
      }),
      questIndex: this.questIndex,
      questProgress: this.questProgress,
      counters: Object.freeze({
        ...this.counters,
        species: Object.freeze({ ...this.counters.species }),
      }),
      travel: this.travel ? Object.freeze({ ...this.travel }) : null,
      revisions: Object.freeze({ ...this.revisions }),
    })
  }

  dispatch(command: GameCommand): CommandResult {
    switch (command.type) {
      case 'toggle-auto':
        this.player.auto = !this.player.auto
        this.player.targetId = -1
        if (!this.player.auto) this.cancelTravel()
        this.hooks.dirty()
        return { ok: true }
      case 'use-ability':
        return { ok: this.useAbility(command.ability), reason: 'Ability is unavailable.' }
      case 'travel-to':
        return { ok: this.travelTo(command.target), reason: 'No route is available.' }
      case 'cancel-travel':
        this.cancelTravel('Travel stopped.')
        return { ok: true }
      case 'equip': {
        const before = this.bag[command.bagIndex]
        this.equipFromBag(command.bagIndex)
        return { ok: before !== null && before !== undefined, reason: 'No item is in that bag slot.' }
      }
      case 'unequip': {
        const before = this.equipped[command.slot]
        this.unequip(command.slot)
        return { ok: before !== null, reason: 'That equipment slot is empty.' }
      }
      case 'sell': {
        const before = this.bag[command.bagIndex]
        this.sellFromBag(command.bagIndex)
        return { ok: !!before && !before.unique, reason: 'That item cannot be sold.' }
      }
      case 'choose-talent':
        return { ok: this.chooseTalent(command.talentId), reason: 'That talent cannot be chosen.' }
      case 'respec':
        return { ok: this.respec(), reason: 'The respec is unavailable.' }
      case 'accept-quest': {
        const offered = this.offeredQuest
        this.acceptQuest()
        return { ok: offered !== null, reason: 'No task is on offer.' }
      }
      case 'claim-milestone':
        return { ok: this.claimMilestone(command.milestoneId), reason: 'That reward is unavailable.' }
    }
  }

  drainEvents(): readonly DomainEvent[] {
    const events = this.eventQueue
    this.eventQueue = []
    return events
  }

  private rebuildSpatial() {
    this.spatial.rebuild(this.enemies.filter((enemy) => enemy.alive))
  }

  private syncPlayerComponents() {
    const id = EcsSimulation.PLAYER_ENTITY
    const player = this.player
    this.components.transform.set(id, { x: player.x, y: player.y, facing: player.facing })
    this.components.motion.set(id, { vx: player.vx, vy: player.vy, moving: player.moving })
    this.components.collider.set(id, { radius: player.radius })
    this.components.combatant.set(id, {
      hp: player.hp,
      maxHp: player.maxHp,
      damage: this.stats.damage,
      attackRange: this.swingRange,
    })
    this.components.renderable.set(id, { sheet: 'warrior', scale: 1 })
    this.components.statusEffects.set(id, {
      webbed: player.webbed,
      invulnerable: player.invuln,
      hitFlash: player.hitFlash,
    })
    this.components.playerControl.set(id, { auto: player.auto, targetId: player.targetId })
  }

  private syncEnemyComponents(enemy: Enemy) {
    const id = enemy.id
    this.components.transform.set(id, { x: enemy.x, y: enemy.y, facing: enemy.facing })
    this.components.motion.set(id, { vx: enemy.vx, vy: enemy.vy, moving: enemy.moving })
    this.components.collider.set(id, { radius: enemy.radius })
    this.components.combatant.set(id, {
      hp: enemy.hp,
      maxHp: enemy.maxHp,
      damage: enemy.dmg,
      attackRange: enemy.attackRange,
    })
    this.components.renderable.set(id, { sheet: enemy.sheet, scale: enemy.scale })
    this.components.enemyAi.set(id, {
      kind: enemy.kind,
      state: enemy.state,
      aggroRange: enemy.aggroRange,
      leash: enemy.leash,
    })
    this.components.spawnLink.set(id, { nodeId: enemy.nodeId, anchorX: enemy.ax, anchorY: enemy.ay })
    this.components.statusEffects.set(id, { webbed: 0, invulnerable: 0, hitFlash: enemy.hitFlash })
  }

  private syncComponentState() {
    this.syncPlayerComponents()
    const live = new Set<number>([EcsSimulation.PLAYER_ENTITY])
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue
      live.add(enemy.id)
      this.syncEnemyComponents(enemy)
    }
    for (const store of Object.values(this.components)) {
      for (const id of store.keys()) if (!live.has(id)) store.delete(id)
    }
    this.rebuildSpatial()
    this.revisions.combat++
  }

  /** Axis-separated movement so sliding along water edges feels natural. */
  private moveEntity(e: { x: number; y: number; radius: number }, dx: number, dy: number) {
    const pad = e.radius * 0.7
    if (dx !== 0) {
      const nx = e.x + dx
      if (!this.world.isSolid(nx + Math.sign(dx) * pad, e.y)) e.x = nx
    }
    if (dy !== 0) {
      const ny = e.y + dy
      if (!this.world.isSolid(e.x, ny + Math.sign(dy) * pad)) e.y = ny
    }
    e.x = clamp(e.x, TILE, WORLD_SIZE - TILE)
    e.y = clamp(e.y, TILE, WORLD_SIZE - TILE)
  }
}
