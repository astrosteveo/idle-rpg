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
import {
  CRIT_MULT,
  ELITE,
  ENEMIES,
  MILESTONES,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  QUESTS,
  SECOND_WIND,
  SWING_DURATION,
  SWING_HALF_ANGLE,
  SWING_RANGE,
  WHIRLWIND,
  deriveStats,
  mitigate,
  rewardScale,
  xpForLevel,
  xpScale,
  type DerivedStats,
  type QuestReward,
} from './content'
import { itemScore, makeItem, restoreUidMark, sumStats, uidMark } from './loot'
import type { OfflineReport } from './offline'
import { SAVE_VERSION, type SaveV1 } from './save'
import {
  CAMPS,
  REGIONS,
  TILE,
  World,
  WORLD_SIZE,
  groundLevelOf,
  type BiomeId,
  type Camp,
  type Region,
  type SpawnNode,
} from './world'
import {
  SLOTS,
  type Ability,
  type Corpse,
  type Effect,
  type Enemy,
  type FloatText,
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

interface ViewRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface Counters {
  kills: number
  wolf: number
  bear: number
  elite: number
  gold: number
  quests: number
}

export class Game {
  readonly world: World
  readonly player: Player
  readonly enemies: Enemy[] = []
  readonly corpses: Corpse[] = []
  readonly floats: FloatText[] = []
  readonly effects: Effect[] = []
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
  counters: Counters = { kills: 0, wolf: 0, bear: 0, elite: 0, gold: 0, quests: 0 }
  questIndex = 0
  questProgress = 0
  claimed = new Set<string>()
  /** Camps this character has found. Per-player progress, never world state. */
  discovered = new Set<string>(CAMPS.filter((c) => c.startDiscovered).map((c) => c.id))
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
  hooks: GameHooks = { log: () => {}, banner: () => {}, dirty: () => {} }

  private rand: Rng = rng(0xc0ffee)
  private nextId = 1
  private view: ViewRect = { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }
  private swingApplied = false
  private outOfCombat = 0
  private roamTarget: { x: number; y: number } | null = null

  constructor(world = new World()) {
    this.world = world
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
    }
    this.stats = this.recalc()
    this.player.hp = this.stats.maxHp
    // Seed the world so the first screen isn't empty while nodes warm up.
    for (const node of this.world.nodes) this.fillNode(node, true)
  }

  /* ================= persistence ================= */

  serialize(): SaveV1 {
    const p = this.player
    return {
      v: SAVE_VERSION,
      seed: this.world.seed,
      savedAt: Date.now(),
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
      nextUid: uidMark(),
      counters: { ...this.counters },
      questIndex: this.questIndex,
      questProgress: this.questProgress,
      claimed: [...this.claimed],
      discovered: [...this.discovered],
      huntingGround: this.huntingGround,
      groundPinned: this.groundPinned,
      autoEquip: this.autoEquip,
    }
  }

  /**
   * Applied on top of a freshly constructed game, so the world is already
   * generated and every spawn node already full. Only the character is restored.
   */
  hydrate(s: SaveV1) {
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
    restoreUidMark(s.nextUid)

    this.counters = { ...s.counters }
    this.questIndex = s.questIndex
    this.questProgress = s.questProgress
    this.claimed = new Set(s.claimed)
    this.discovered = new Set(s.discovered)
    this.huntingGround = s.huntingGround
    this.groundPinned = s.groundPinned ?? false
    this.autoEquip = s.autoEquip

    // The loot stream is fixed-seed and its position is not recoverable from the
    // closure, so reseed it. Without this every session rolls the same sequence
    // of drops from the top.
    this.rand = rng((s.savedAt ^ 0x9e3779b1) >>> 0)

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
    this.counters[r.kind] += r.kills
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
    for (const item of r.items) this.addItem(item)
    this.hooks.dirty()
  }

  /* ================= derived stats ================= */

  recalc(): DerivedStats {
    const gear = sumStats(SLOTS.map((s) => this.equipped[s]))
    this.stats = deriveStats(this.player.level, this.player, gear)
    const p = this.player
    const prevMax = p.maxHp
    p.maxHp = this.stats.maxHp
    if (prevMax <= 1) p.hp = p.maxHp
    else if (p.maxHp > prevMax) p.hp += p.maxHp - prevMax
    p.hp = clamp(p.hp, 0, p.maxHp)
    return this.stats
  }

  setView(x0: number, y0: number, x1: number, y1: number) {
    this.view = { x0, y0, x1, y1 }
  }

  /* ================= spawning ================= */

  private fillNode(node: SpawnNode, instant = false) {
    while (node.alive.length < node.cap) {
      const pos = this.world.nodeWanderPoint(node, this.rand)
      if (!instant && dist(pos.x, pos.y, this.player.x, this.player.y) < 300) return
      this.spawnEnemy(node, pos.x, pos.y)
    }
  }

  private spawnEnemy(node: SpawnNode, x: number, y: number) {
    const type = ENEMIES[node.kind]
    const elite = node.elite
    const level = node.level
    const maxHp = Math.round(type.hp(level) * (elite ? ELITE.hpMult : 1))
    const e: Enemy = {
      id: this.nextId++,
      kind: node.kind,
      elite,
      level,
      name: elite ? type.eliteName : type.name,
      x,
      y,
      vx: 0,
      vy: 0,
      radius: type.radius * (elite ? 1.2 : 1),
      scale: elite ? 1 : 1,
      facing: this.rand() * Math.PI * 2,
      dir: 0,
      hp: maxHp,
      maxHp,
      dmg: type.dmg(level) * (elite ? ELITE.dmgMult : 1),
      speed: type.speed * (elite ? ELITE.speedMult : 1),
      xpValue: Math.round(type.xp(level) * (elite ? ELITE.xpMult : 1)),
      goldValue: Math.round(type.gold(level) * (elite ? ELITE.goldMult : 1)),
      alive: true,
      state: 'idle',
      stateT: this.rand.range(0, 2),
      anim: this.rand() * 4,
      moving: false,
      attackCd: 0,
      windup: 0,
      hitFlash: 0,
      nodeId: node.id,
      ax: x,
      ay: y,
      wx: x,
      wy: y,
      aggroRange: type.aggroRange * (elite ? 1.15 : 1),
      leash: type.leash,
      attackRange: type.attackRange * (elite ? 1.15 : 1),
      deadT: 0,
    }
    this.enemies.push(e)
    node.alive.push(e.id)
  }

  /* ================= main step ================= */

  update(dt: number, moveX: number, moveY: number) {
    this.time += dt
    const p = this.player

    for (const a of this.abilities) a.cd = Math.max(0, a.cd - dt)

    if (!p.alive) {
      p.deadT += dt
      if (p.deadT > 2.6) this.respawn()
      this.stepTransient(dt)
      return
    }

    this.currentCamp = this.world.campAt(p.x, p.y)
    if (this.currentCamp && !this.isDiscovered(this.currentCamp)) this.discoverCamp(this.currentCamp)
    this.trackGround()

    if (p.auto) this.stepAuto(dt)
    else this.stepManual(dt, moveX, moveY)

    this.stepSwing(dt)
    this.stepEnemies(dt)
    this.stepRegen(dt)
    this.stepSpawns()
    this.stepTransient(dt)
  }

  private stepManual(dt: number, mx: number, my: number) {
    const p = this.player
    const mag = Math.hypot(mx, my)
    if (mag > 0.05) {
      p.facing = Math.atan2(my, mx)
      this.moveEntity(p, mx * PLAYER_SPEED * dt, my * PLAYER_SPEED * dt)
      p.moving = true
      p.anim += dt * 8 * Math.min(1, mag * 1.4)
    } else {
      p.moving = false
      p.anim += dt * 3
    }
    p.dir = facingToDir(p.facing)
    // Standing still with a beast in reach still swings — the warrior never
    // waits for a button.
    const t = this.nearestEnemy(p.x, p.y, SWING_RANGE + 26, true)
    if (t && !p.moving) p.facing = Math.atan2(t.y - p.y, t.x - p.x)
    if (t) p.dir = facingToDir(p.facing)
  }

  private stepAuto(dt: number) {
    const p = this.player
    // Emergency heal first.
    const sw = this.abilities[1]!
    if (sw.cd <= 0 && p.hp < p.maxHp * 0.45) this.useAbility('secondwind')

    let target = this.enemyById(p.targetId)
    if (!target || !target.alive || target.state === 'return' || dist(p.x, p.y, target.x, target.y) > 1100) {
      target = this.nearestEnemy(p.x, p.y, 1000, true)
      p.targetId = target ? target.id : -1
    }

    if (target) {
      this.roamTarget = null
      const d = dist(p.x, p.y, target.x, target.y)
      const reach = SWING_RANGE * 0.62 + target.radius
      p.facing = Math.atan2(target.y - p.y, target.x - p.x)
      if (d > reach) {
        this.moveEntity(
          p,
          Math.cos(p.facing) * PLAYER_SPEED * dt,
          Math.sin(p.facing) * PLAYER_SPEED * dt,
        )
        p.moving = true
        p.anim += dt * 8
      } else {
        p.moving = false
        p.anim += dt * 3
      }
      // Whirlwind pays for itself once a pack closes in.
      const ww = this.abilities[0]!
      if (ww.cd <= 0 && this.countEnemiesWithin(p.x, p.y, WHIRLWIND.radius) >= 2) {
        this.useAbility('whirlwind')
      }
    } else {
      this.roam(dt)
    }
    p.dir = facingToDir(p.facing)
  }

  /** With nothing in sight, walk toward the nearest populated den. */
  private roam(dt: number) {
    const p = this.player
    if (!this.roamTarget || dist(p.x, p.y, this.roamTarget.x, this.roamTarget.y) < 90) {
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
      this.roamTarget = best ? { x: best.x, y: best.y } : null
    }
    if (!this.roamTarget) {
      p.moving = false
      p.anim += dt * 3
      return
    }
    const a = Math.atan2(this.roamTarget.y - p.y, this.roamTarget.x - p.x)
    p.facing = a
    this.moveEntity(p, Math.cos(a) * PLAYER_SPEED * dt, Math.sin(a) * PLAYER_SPEED * dt)
    p.moving = true
    p.anim += dt * 8
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
    const target = this.nearestEnemy(p.x, p.y, SWING_RANGE + 20, true)
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
    let hits = 0
    for (const e of this.enemies) {
      if (!e.alive || e.state === 'return') continue
      const dx = e.x - p.x
      const dy = e.y - p.y
      const d = Math.hypot(dx, dy)
      if (d > SWING_RANGE + e.radius) continue
      let da = Math.abs(Math.atan2(dy, dx) - p.swingDir) % (Math.PI * 2)
      if (da > Math.PI) da = Math.PI * 2 - da
      if (da > SWING_HALF_ANGLE) continue
      this.damageEnemy(e, this.rollDamage())
      hits++
    }
    this.effects.push({
      kind: 'slash',
      x: p.x + Math.cos(p.swingDir) * 16,
      y: p.y + Math.sin(p.swingDir) * 16 - 14,
      t: 0,
      life: 0.22,
      angle: p.swingDir,
      radius: SWING_RANGE * 0.86,
      color: '#eaf1ff',
    })
    if (hits) this.outOfCombat = 0
  }

  private rollDamage(mult = 1): { amount: number; crit: boolean } {
    const crit = this.rand() < this.stats.crit
    const base = this.stats.damage * mult * this.rand.range(0.9, 1.1)
    return { amount: Math.max(1, Math.round(base * (crit ? CRIT_MULT : 1))), crit }
  }

  /* ================= abilities ================= */

  useAbility(id: 'whirlwind' | 'secondwind'): boolean {
    const ab = this.abilities.find((a) => a.id === id)
    if (!ab || ab.cd > 0 || !this.player.alive) return false
    const p = this.player
    if (id === 'whirlwind') {
      ab.cd = ab.cooldown
      let hits = 0
      for (const e of this.enemies) {
        if (!e.alive || e.state === 'return') continue
        if (dist(p.x, p.y, e.x, e.y) > WHIRLWIND.radius + e.radius) continue
        this.damageEnemy(e, this.rollDamage(WHIRLWIND.damageMult))
        hits++
      }
      this.effects.push({
        kind: 'ring',
        x: p.x,
        y: p.y - 12,
        t: 0,
        life: 0.42,
        angle: 0,
        radius: WHIRLWIND.radius,
        color: '#cfe0ff',
      })
      this.hooks.log(hits ? `Whirlwind hits ${hits}` : 'Whirlwind swings wide', '#cfe0ff')
    } else {
      ab.cd = ab.cooldown
      const heal = Math.round(p.maxHp * SECOND_WIND.healFraction)
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
        if (e.state === 'chase' || e.state === 'attack' || e.state === 'return') {
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

    // Soft separation so a pack surrounds rather than stacks into one sprite.
    for (let i = 0; i < active.length; i++) {
      const a = active[i]!
      for (let j = i + 1; j < active.length; j++) {
        const b = active[j]!
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
    e.stateT += dt
    e.attackCd = Math.max(0, e.attackCd - dt)
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
    const engaged = e.state === 'chase' || e.state === 'attack'
    if (engaged) {
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
          e.windup = ENEMIES[e.kind].windup
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
          e.attackCd = ENEMIES[e.kind].attackCd
          this.setEnemyState(e, 'chase')
        }
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
    if (dist(e.x, e.y, e.ax, e.ay) > e.leash) return true
    if (dPlayer > e.aggroRange * 2.6) return true
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

  /* ================= damage ================= */

  damageEnemy(e: Enemy, hit: { amount: number; crit: boolean }) {
    if (!e.alive) return
    e.hp -= hit.amount
    e.hitFlash = 0.12
    this.outOfCombat = 0
    this.pushFloat(
      e.x + this.rand.range(-6, 6),
      e.y - e.radius - 12,
      `${hit.amount}`,
      hit.crit ? '#ffd166' : '#ffffff',
      hit.crit ? 10 : 8,
    )
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
    // Getting hit while wandering is a valid way to start a fight.
    if (e.state === 'idle' || e.state === 'wander') this.setEnemyState(e, 'chase')
    if (e.hp <= 0) this.killEnemy(e)
  }

  private damagePlayer(e: Enemy) {
    const p = this.player
    if (!p.alive || p.invuln > 0) return
    const raw = e.dmg * this.rand.range(0.9, 1.12)
    const amount = Math.max(1, Math.round(mitigate(raw, this.stats.armor, e.level)))
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
   * The world half of a kill: the bookkeeping every observer of a shared world
   * would agree on, and which must happen exactly once no matter how many
   * players landed a hit. Grants nothing — rewards live in `creditKill`.
   */
  private killEnemy(e: Enemy) {
    e.alive = false
    e.hp = 0
    e.state = 'dead'
    const type = ENEMIES[e.kind]
    this.corpses.push({
      x: e.x,
      y: e.y,
      sheet: e.elite ? type.eliteSheet : type.sheet,
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

    // Bookkeeping for the node this beast belonged to.
    const node = this.world.nodes[e.nodeId]
    if (node) {
      const i = node.alive.indexOf(e.id)
      if (i >= 0) node.alive.splice(i, 1)
      node.respawnAt = this.time + (e.elite ? 45 : 9 + this.rand() * 8)
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
    // Acknowledgment is unconditional; only the payout scales.
    this.counters.kills++
    this.counters[e.kind]++
    if (e.elite) this.counters.elite++
    this.advanceQuestOnKill(e)

    // Gold and drops keep the floored curve — a trivial beast is still worth
    // looting. Experience alone can reach zero, so a region can be outgrown.
    const scale = rewardScale(this.player.level, e.level)
    const xps = xpScale(this.player.level, e.level)
    this.gainGold(Math.max(1, Math.round(e.goldValue * scale)))
    if (xps > 0) this.gainXp(Math.max(1, Math.round(e.xpValue * xps)))
    this.rollDrop(e, scale)
  }

  /* ================= loot & progression ================= */

  private rollDrop(e: Enemy, scale = 1) {
    const type = ENEMIES[e.kind]
    const chance = (e.elite ? ELITE.dropChance : type.dropChance) * scale
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
    const item = makeItem(this.rand, Math.max(1, Math.round(ilvl) + this.rand.int(-1, 2)), rarity)
    this.addItem(item)
  }

  addItem(item: Item) {
    const slot = this.bag.indexOf(null)
    const better = itemScore(item) > itemScore(this.equipped[item.slot])
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
      this.hooks.banner(`Level ${p.level}`, '+2 Strength  +2 Vitality  +1 Agility')
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

  get quest() {
    return QUESTS[this.questIndex] ?? null
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
    const match = want === 'any' || (want === 'elite' ? e.elite : want === e.kind)
    if (!match) return
    this.questProgress++
    if (this.questProgress >= q.objective.count) this.completeQuest()
  }

  isDiscovered(camp: Camp): boolean {
    return this.discovered.has(camp.id)
  }

  private discoverCamp(camp: Camp) {
    this.discovered.add(camp.id)
    this.hooks.banner('Camp Discovered', camp.name)
    this.hooks.log(`Discovered ${camp.name}`, '#f2c14e')
    const q = this.quest
    if (q && q.objective.type === 'reach' && q.objective.camp === camp.id) {
      this.questProgress = 1
      this.completeQuest()
    }
    this.hooks.dirty()
  }

  private completeQuest() {
    const q = this.quest
    if (!q) return
    this.counters.quests++
    this.grantReward(q.reward, `Quest Complete`, q.name)
    this.questIndex++
    this.questProgress = 0
    const next = this.quest
    if (next) this.hooks.log(`New task: ${next.name}`, '#f2c14e')
    this.hooks.dirty()
  }

  private grantReward(reward: QuestReward, title: string, sub: string) {
    if (reward.xp) this.gainXp(reward.xp)
    if (reward.gold) this.gainGold(reward.gold)
    if (reward.item) {
      const item = makeItem(this.rand, reward.item.ilvl, reward.item.rarity, reward.item.base)
      this.addItem(item)
    }
    this.hooks.banner(title, sub)
    const bits = [reward.xp ? `${reward.xp} xp` : '', reward.gold ? `${reward.gold}g` : '']
      .filter(Boolean)
      .join(', ')
    if (bits) this.hooks.log(`Reward: ${bits}`, '#f2c14e')
  }

  /* ---- milestones ---- */

  metricValue(metric: string): number {
    switch (metric) {
      case 'kills':
        return this.counters.kills
      case 'wolf':
        return this.counters.wolf
      case 'bear':
        return this.counters.bear
      case 'elite':
        return this.counters.elite
      case 'gold':
        return this.counters.gold
      case 'level':
        return this.player.level
      case 'quests':
        return this.counters.quests
      default:
        return 0
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
    this.outOfCombat += dt
    if (p.hp >= p.maxHp) return
    let rate = 0
    if (this.currentCamp) rate = 0.14
    else if (this.outOfCombat > 5) rate = 0.03
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
    p.targetId = -1
    this.roamTarget = null
    for (const e of this.enemies) {
      if (e.state === 'chase' || e.state === 'attack') this.setEnemyState(e, 'return')
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

  nearestEnemy(x: number, y: number, maxDist: number, huntable: boolean): Enemy | null {
    let best: Enemy | null = null
    let bestD = maxDist
    for (const e of this.enemies) {
      if (!e.alive) continue
      if (huntable && e.state === 'return') continue
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
    for (const e of this.enemies) {
      if (e.alive && e.state !== 'return' && dist(x, y, e.x, e.y) <= r + e.radius) n++
    }
    return n
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
