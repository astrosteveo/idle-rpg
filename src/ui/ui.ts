/**
 * The HUD. Everything here is DOM layered over the canvas — bars, panels and
 * the joystick — while the world itself stays entirely canvas-rendered.
 *
 * Cheap widgets (bars, cooldowns, minimap) refresh every frame; the heavy
 * panels only rebuild when the game marks itself dirty or a panel is opened.
 */
import { clamp } from '../core/math'
import {
  ENEMIES,
  MASTERY_TIERS,
  MILESTONES,
  QUESTS,
  RARITY_COLORS,
  TALENT_ROWS,
  UNIQUES,
  damageVs,
  masteryTier,
  type UniqueDef,
} from '../game/content'
import { itemScore, rarityName, statLines, uniqueDefOf } from '../game/loot'
import type { Game } from '../game/state'
import { SLOTS, SLOT_LABEL, type EnemyKind, type Item } from '../game/types'
import type { QuestObjective } from '../game/content'
import { CAMPS, MAP_TILES, REGIONS, WORLD_SIZE, groundLevelOf } from '../game/world'
import { killsPerHour, type OfflineReport } from '../game/offline'
import { OFFLINE } from '../game/content'
import type { Renderer } from '../render/renderer'
import { abilityIcon, itemIcon } from '../render/sprites'

type Tab = 'bag' | 'quests' | 'rewards' | 'hunt' | 'talents' | 'beasts'

const TABS: Tab[] = ['bag', 'quests', 'rewards', 'hunt', 'talents', 'beasts']

/** "4h 12m", "18m" — the report and the Hunt tab both read better than seconds. */
function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (h && m) return `${h}h ${m}m`
  if (h) return `${h}h`
  return `${Math.max(1, m)}m`
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (html !== undefined) n.innerHTML = html
  return n
}

export class UI {
  readonly stickZone: HTMLElement
  readonly stick: HTMLElement

  private root: HTMLElement
  private hpFill!: HTMLElement
  private hpLabel!: HTMLElement
  private xpFill!: HTMLElement
  private xpLabel!: HTMLElement
  private lvlLabel!: HTMLElement
  private statLine!: HTMLElement
  private goldLabel!: HTMLElement
  private zoneLabel!: HTMLElement
  private mmCtx!: CanvasRenderingContext2D
  private tracker!: HTMLElement
  private abilityEls: {
    root: HTMLElement
    cd: HTMLElement
    text: HTMLElement
  }[] = []
  private autoBtn!: HTMLButtonElement
  private logBox!: HTMLElement
  private bannerBox!: HTMLElement
  private panel!: HTMLElement
  private panelBody!: HTMLElement
  private tabs: Record<Tab, HTMLButtonElement> = {} as never
  private badges: Record<string, HTMLElement> = {}
  private tip!: HTMLElement
  private death!: HTMLElement
  private report!: HTMLElement

  private tab: Tab = 'bag'
  private open = false
  private needsPanel = true
  private bannerTimer = 0

  constructor(
    private game: Game,
    private renderer: Renderer,
  ) {
    this.root = document.getElementById('ui')!
    this.buildVitals()
    this.buildMap()
    this.buildTracker()
    this.buildActions()
    this.buildLog()
    this.buildBanner()
    this.buildPanel()
    this.buildTooltip()
    this.buildDeath()
    this.buildReport()
    const zone = el('div')
    zone.id = 'stickzone'
    const stick = el('div')
    stick.id = 'stick'
    stick.appendChild(el('i'))
    this.root.append(zone, stick)
    this.stickZone = zone
    this.stick = stick

    game.hooks = {
      log: (t, c) => this.log(t, c),
      banner: (t, s) => this.banner(t, s),
      dirty: () => {
        this.needsPanel = true
      },
    }

    window.addEventListener('keydown', this.onKey)
  }

  /* ================= construction ================= */

  private buildVitals() {
    const box = el('div', 'frame')
    box.id = 'vitals'
    box.innerHTML = `
      <div class="v-row">
        <span class="v-name">Wildmarch</span>
        <span class="v-class">Warrior</span>
        <span class="v-lvl">Lv 1</span>
      </div>
      <div class="bar hp"><div class="fill"></div><div class="label"></div></div>
      <div class="bar xp"><div class="fill"></div><div class="label"></div></div>
      <div class="v-stats"></div>`
    this.root.appendChild(box)
    this.lvlLabel = box.querySelector('.v-lvl')!
    this.hpFill = box.querySelector('.bar.hp .fill')!
    this.hpLabel = box.querySelector('.bar.hp .label')!
    this.xpFill = box.querySelector('.bar.xp .fill')!
    this.xpLabel = box.querySelector('.bar.xp .label')!
    this.statLine = box.querySelector('.v-stats')!
  }

  private buildMap() {
    const box = el('div', 'frame')
    box.id = 'mapbox'
    const zone = el('div')
    zone.id = 'zonename'
    const cv = el('canvas')
    cv.id = 'minimap'
    cv.width = 164
    cv.height = 164
    const gold = el('div')
    gold.id = 'gold'
    box.append(zone, cv, gold)
    this.root.appendChild(box)
    this.zoneLabel = zone
    this.goldLabel = gold
    const ctx = cv.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    this.mmCtx = ctx
  }

  private buildTracker() {
    const box = el('div', 'frame')
    box.id = 'tracker'
    this.root.appendChild(box)
    this.tracker = box
  }

  private buildActions() {
    const wrap = el('div')
    wrap.id = 'actions'
    const abilities = el('div')
    abilities.id = 'abilities'
    for (const ab of this.game.abilities) {
      const node = el('div', 'ability clickable')
      node.innerHTML = `<span class="key">${ab.key}</span>
        <img alt="${ab.name}" src="${abilityIcon(ab.id)}">
        <div class="cd"></div><div class="cdtext"></div>`
      node.title = `${ab.name} — ${ab.desc}`
      node.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        this.game.useAbility(ab.id)
      })
      abilities.appendChild(node)
      this.abilityEls.push({
        root: node,
        cd: node.querySelector('.cd')!,
        text: node.querySelector('.cdtext')!,
      })
    }

    const menu = el('div')
    menu.id = 'menubar'
    const mk = (label: string, key: string, tab: Tab, badge?: string) => {
      const b = el('button', 'btn menu-btn')
      b.innerHTML = `${label} <span style="opacity:.5">${key}</span>`
      const badgeEl = el('span', 'badge hide')
      b.appendChild(badgeEl)
      if (badge) this.badges[badge] = badgeEl
      b.addEventListener('click', () => this.toggle(tab))
      menu.appendChild(b)
    }
    mk('Bag', 'I', 'bag', 'bag')
    mk('Tasks', 'J', 'quests')
    mk('Rewards', 'R', 'rewards', 'rewards')
    mk('Talents', 'T', 'talents', 'talents')
    mk('Beasts', 'B', 'beasts')
    mk('Hunt', 'H', 'hunt')

    wrap.append(abilities, menu)
    this.root.appendChild(wrap)

    const auto = el('button', 'btn')
    auto.id = 'autobtn'
    auto.innerHTML = 'Auto: Off<small>seek &amp; slay nearby beasts</small>'
    auto.addEventListener('click', () => this.toggleAuto())
    this.root.appendChild(auto)
    this.autoBtn = auto
  }

  private buildLog() {
    const box = el('div')
    box.id = 'log'
    this.root.appendChild(box)
    this.logBox = box
  }

  private buildBanner() {
    const box = el('div')
    box.id = 'banner'
    this.root.appendChild(box)
    this.bannerBox = box
  }

  private buildPanel() {
    const p = el('div', 'frame')
    p.id = 'panel'
    const head = el('div', 'p-head')
    const mkTab = (id: Tab, label: string) => {
      const b = el('button', 'tab')
      b.textContent = label
      b.addEventListener('click', () => this.show(id))
      head.appendChild(b)
      this.tabs[id] = b
    }
    mkTab('bag', 'Inventory')
    mkTab('quests', 'Tasks')
    mkTab('rewards', 'Rewards')
    mkTab('talents', 'Talents')
    mkTab('beasts', 'Bestiary')
    mkTab('hunt', 'Hunt')
    const close = el('button', 'btn p-close')
    close.textContent = 'Close'
    close.addEventListener('click', () => this.hide())
    head.appendChild(close)
    const body = el('div', 'p-body')
    p.append(head, body)
    this.root.appendChild(p)
    this.panel = p
    this.panelBody = body
  }

  private buildTooltip() {
    const t = el('div', 'frame')
    t.id = 'tip'
    document.body.appendChild(t)
    this.tip = t
  }

  private buildDeath() {
    const d = el('div')
    d.id = 'death'
    d.innerHTML = `<div class="d-in"><h2>You Fell</h2><p>Recovering at the nearest camp…</p></div>`
    this.root.appendChild(d)
    this.death = d
  }

  private buildReport() {
    const d = el('div')
    d.id = 'report'
    this.root.appendChild(d)
    this.report = d
  }

  /**
   * The most-read screen in an idle game — a log of the hunt, not a receipt.
   * Shown once on load when the ledger found something worth reporting.
   */
  showReport(r: OfflineReport) {
    const type = ENEMIES[r.kind]
    const levels = r.levelTo - r.levelFrom
    const inner = el('div', 'r-in frame')

    inner.appendChild(
      el(
        'div',
        'r-head',
        `<span class="r-eyebrow">While you were away</span>
         <h2>${duration(r.creditedSeconds)} in ${r.groundName}</h2>`,
      ),
    )

    if (r.capped) {
      inner.appendChild(
        el(
          'div',
          'r-capped',
          `You were gone ${duration(r.elapsedSeconds)}. A hunt pays out its first
           ${OFFLINE.capHours} hours.`,
        ),
      )
    }

    const rows: string[] = [`<div><span>Beasts slain</span><b>${r.kills.toLocaleString()}</b></div>`]
    if (r.eliteKills > 0) {
      rows.push(`<div><span>${type.eliteName} slain</span><b>${r.eliteKills}</b></div>`)
    }
    rows.push(`<div><span>Experience</span><b>${r.xp.toLocaleString()}</b></div>`)
    if (levels > 0) {
      rows.push(`<div><span>Levels</span><b>${r.levelFrom} → ${r.levelTo}</b></div>`)
    }
    rows.push(`<div><span>Gold</span><b>${r.gold.toLocaleString()}</b></div>`)
    if (r.soldCount > 0) {
      rows.push(`<div><span>Sold in the field</span><b>${r.soldCount}</b></div>`)
    }
    inner.appendChild(el('div', 'r-stats', rows.join('')))

    if (r.items.length) {
      const loot = el('div', 'r-loot')
      loot.appendChild(el('div', 'col-h', 'Brought home'))
      for (const it of r.items) {
        const relic = uniqueDefOf(it)
        loot.appendChild(
          el(
            'div',
            `r-item${relic ? ' relic' : ''}`,
            relic
              ? `<b style="color:${RARITY_COLORS[4]}">${relic.name}</b>
                 <span>a relic — ${relic.rule}</span>`
              : `<b style="color:${RARITY_COLORS[it.rarity]}">${it.name}</b>
                 <span>ilvl ${it.ilvl}</span>`,
          ),
        )
      }
      inner.appendChild(loot)
    }

    const btn = el('button', 'btn')
    btn.textContent = 'Back to the march'
    btn.addEventListener('click', () => this.report.classList.remove('show'))
    inner.appendChild(btn)

    this.report.innerHTML = ''
    this.report.appendChild(inner)
    this.report.classList.add('show')
  }

  /* ================= interaction ================= */

  private onKey = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase()
    if (k === 'i') this.toggle('bag')
    else if (k === 'j') this.toggle('quests')
    else if (k === 'r') this.toggle('rewards')
    else if (k === 'h') this.toggle('hunt')
    else if (k === 't') this.toggle('talents')
    else if (k === 'b') this.toggle('beasts')
    else if (k === 'escape') this.hide()
    else if (k === 'q') this.game.useAbility('whirlwind')
    else if (k === 'e') this.game.useAbility('secondwind')
    else if (k === ' ') this.toggleAuto()
    else if (k === 'f') this.toggleAutoEquip()
  }

  private toggleAuto() {
    const p = this.game.player
    p.auto = !p.auto
    p.targetId = -1
    this.autoBtn.classList.toggle('on', p.auto)
    this.autoBtn.innerHTML = p.auto
      ? 'Auto: On<small>seeking beasts…</small>'
      : 'Auto: Off<small>seek &amp; slay nearby beasts</small>'
    this.log(p.auto ? 'Auto-battle engaged' : 'Auto-battle disengaged', '#9ad0ff')
  }

  private toggleAutoEquip() {
    this.game.autoEquip = !this.game.autoEquip
    this.log(`Auto-equip upgrades ${this.game.autoEquip ? 'on' : 'off'}`, '#9ad0ff')
    this.needsPanel = true
  }

  private toggle(tab: Tab) {
    if (this.open && this.tab === tab) this.hide()
    else this.show(tab)
  }

  private show(tab: Tab) {
    this.tab = tab
    this.open = true
    this.panel.classList.add('open')
    for (const id of TABS) {
      this.tabs[id].classList.toggle('sel', id === tab)
    }
    this.needsPanel = true
    this.renderPanel()
  }

  private hide() {
    this.open = false
    this.panel.classList.remove('open')
    this.hideTip()
  }

  log(text: string, color?: string) {
    const line = el('div', 'logline')
    line.textContent = text
    if (color) line.style.color = color
    this.logBox.prepend(line)
    while (this.logBox.childElementCount > 9) this.logBox.lastElementChild!.remove()
    setTimeout(() => line.classList.add('fade'), 5200)
    setTimeout(() => line.remove(), 5900)
  }

  banner(title: string, sub: string) {
    this.bannerBox.innerHTML = `<div class="banner-t">${title}</div><div class="banner-s">${sub}</div>`
    this.bannerBox.classList.remove('show')
    void this.bannerBox.offsetWidth // restart the CSS animation
    this.bannerBox.classList.add('show')
    this.bannerTimer = 2.6
  }

  /* ================= per-frame ================= */

  update(dt: number) {
    const g = this.game
    const p = g.player
    const s = g.stats

    const hpPct = clamp(p.hp / p.maxHp, 0, 1) * 100
    this.hpFill.style.width = `${hpPct}%`
    this.hpLabel.textContent = `${Math.ceil(p.hp)} / ${p.maxHp}`
    this.xpFill.style.width = `${clamp(p.xp / p.xpNext, 0, 1) * 100}%`
    this.xpLabel.textContent = ''
    this.lvlLabel.textContent = `Lv ${p.level}`
    this.statLine.innerHTML =
      `<span>DMG <b>${Math.round(s.damage)}</b></span>` +
      `<span>ARM <b>${s.armor}</b></span>` +
      `<span>CRIT <b>${Math.round(s.crit * 100)}%</b></span>` +
      `<span>SPD <b>${(1 / s.attackInterval).toFixed(2)}/s</b></span>`
    this.goldLabel.textContent = `${p.gold.toLocaleString()} gold`

    const camp = g.currentCamp
    const region = g.world.regionAt(p.x, p.y)
    this.zoneLabel.textContent = camp ? camp.name : region.name

    for (let i = 0; i < this.abilityEls.length; i++) {
      const ab = g.abilities[i]!
      const node = this.abilityEls[i]!
      const pct = ab.cd > 0 ? (ab.cd / ab.cooldown) * 100 : 0
      node.cd.style.height = `${pct}%`
      node.text.textContent = ab.cd > 0 ? `${Math.ceil(ab.cd)}` : ''
      node.root.classList.toggle('ready', ab.cd <= 0)
    }

    this.death.classList.toggle('show', !p.alive)

    const claim = g.claimableCount
    this.setBadge('rewards', claim)
    this.setBadge('bag', this.upgradesInBag())
    this.setBadge('talents', g.talentPoints)

    // Ability text is derived from the build, so a talent that changes a
    // cooldown or a heal has to change the button's tooltip with it.
    for (let i = 0; i < this.abilityEls.length; i++) {
      const ab = g.abilities[i]!
      const node = this.abilityEls[i]!
      const title = `${ab.name} — ${ab.desc}`
      if (node.root.title !== title) node.root.title = title
    }

    this.drawMinimap()
    this.updateTracker()

    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt
      if (this.bannerTimer <= 0) this.bannerBox.classList.remove('show')
    }

    if (this.open && this.needsPanel) this.renderPanel()
  }

  private setBadge(key: string, n: number) {
    const b = this.badges[key]
    if (!b) return
    b.textContent = n > 0 ? `${n}` : ''
    b.classList.toggle('hide', n <= 0)
  }

  /**
   * A relic outscores nothing and is outscored by almost everything, so it is
   * never an upgrade and never has one — badging either way would nag the
   * player to undo the one decision they made deliberately.
   */
  private isUpgrade(it: Item | null): boolean {
    if (!it || it.unique) return false
    const current = this.game.equipped[it.slot]
    if (current?.unique) return false
    return itemScore(it) > itemScore(current)
  }

  private upgradesInBag(): number {
    let n = 0
    for (const it of this.game.bag) if (this.isUpgrade(it)) n++
    return n
  }

  private updateTracker() {
    const g = this.game
    const q = g.quest
    if (!q) {
      this.tracker.innerHTML = `<h4>Task</h4><div class="q-name">All tasks complete</div>
        <div class="q-desc">The Wildmarch is yours. Keep hunting for rewards.</div>`
      return
    }
    const goal = g.questGoal
    const have = Math.min(g.questProgress, goal)
    const objective = objectiveText(q.objective, have, goal)
    this.tracker.innerHTML = `<h4>Current Task</h4>
      <div class="q-name">${q.name}</div>
      <div class="q-desc">${q.desc}</div>
      <div class="q-obj${have >= goal ? ' done' : ''}">${objective}</div>
      <div class="q-bar"><i style="width:${(have / goal) * 100}%"></i></div>`
  }

  private drawMinimap() {
    const g = this.game
    const ctx = this.mmCtx
    const size = 164
    const k = size / WORLD_SIZE
    ctx.clearRect(0, 0, size, size)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(g.world.minimap, 0, 0, MAP_TILES, MAP_TILES, 0, 0, size, size)

    // Visible slice of the world.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth = 1
    ctx.strokeRect(
      Math.round(this.renderer.viewX0 * k) + 0.5,
      Math.round(this.renderer.viewY0 * k) + 0.5,
      Math.round(this.renderer.vw * k),
      Math.round(this.renderer.vh * k),
    )

    for (const e of g.enemies) {
      if (!e.alive) continue
      const d = Math.hypot(e.x - g.player.x, e.y - g.player.y)
      if (d > 1500) continue
      ctx.fillStyle = e.elite ? '#ff8a3c' : e.kind === 'bear' ? '#c96a4a' : '#d8483f'
      const s = e.elite ? 3 : 2
      ctx.fillRect(Math.round(e.x * k) - 1, Math.round(e.y * k) - 1, s, s)
    }

    for (const c of CAMPS) {
      const cx = Math.round(c.x * k)
      const cy = Math.round(c.y * k)
      ctx.fillStyle = g.isDiscovered(c) ? '#f2c14e' : '#6d7383'
      ctx.fillRect(cx - 3, cy - 3, 6, 6)
      ctx.fillStyle = '#12151d'
      ctx.fillRect(cx - 1, cy - 1, 2, 2)
    }

    const px = Math.round(g.player.x * k)
    const py = Math.round(g.player.y * k)
    ctx.fillStyle = '#0a0b11'
    ctx.fillRect(px - 3, py - 3, 6, 6)
    ctx.fillStyle = '#eaf1ff'
    ctx.fillRect(px - 2, py - 2, 4, 4)
  }

  /* ================= panels ================= */

  private renderPanel() {
    this.needsPanel = false
    const body = this.panelBody
    body.innerHTML = ''
    if (this.tab === 'bag') this.renderBag(body)
    else if (this.tab === 'quests') this.renderQuests(body)
    else if (this.tab === 'hunt') this.renderHunt(body)
    else if (this.tab === 'talents') this.renderTalents(body)
    else if (this.tab === 'beasts') this.renderBestiary(body)
    else this.renderRewards(body)
  }

  /**
   * Five rows, one pick each, and a pick is final until it is bought back.
   * Everything on this screen is a choice the simulation refuses to make for
   * the player — the counterweight to auto-equip deciding all the gear.
   */
  private renderTalents(body: HTMLElement) {
    const g = this.game
    const wrap = el('div', 'tal-wrap')

    const points = g.talentPoints
    const intro = el('div', 'hunt-intro')
    intro.innerHTML = points
      ? `<b>${points} ${points === 1 ? 'choice' : 'choices'} waiting.</b> One talent per
         row, and a taken row stays taken until you retrain.`
      : `One talent per row, unlocked by level. A taken row stays taken until you
         retrain.`
    wrap.appendChild(intro)

    for (const row of TALENT_ROWS) {
      const unlocked = g.player.level >= row.level
      const taken = g.talentIn(row)
      const card = el('div', 'tal-row')
      card.classList.toggle('locked', !unlocked)
      card.classList.toggle('open', unlocked && !taken)

      const head = el('div', 'g-head')
      head.innerHTML = `<b>${row.name}</b>
        <span>${unlocked ? (taken ? 'Chosen' : 'Choose one') : `Level ${row.level}`}</span>`
      card.appendChild(head)

      const grid = el('div', 'tal-grid')
      for (const choice of row.choices) {
        const node = el('button', 'tal-node')
        node.innerHTML = `<b>${choice.name}</b><span>${choice.desc}</span>`
        node.classList.toggle('sel', taken === choice.id)
        // A locked row and an already-decided row are both unclickable, but
        // they read differently: one is "not yet", the other is "not this one".
        node.classList.toggle('passed', !!taken && taken !== choice.id)
        node.disabled = !unlocked || !!taken
        node.addEventListener('click', () => {
          if (g.chooseTalent(choice.id)) this.renderPanel()
        })
        grid.appendChild(node)
      }
      card.appendChild(grid)
      wrap.appendChild(card)
    }

    const cost = g.respecCost
    const foot = el('div', 'tal-foot')
    if (cost > 0) {
      const btn = el('button', 'btn')
      btn.textContent = `Retrain — ${cost.toLocaleString()}g`
      btn.disabled = g.player.gold < cost
      btn.addEventListener('click', () => {
        g.respec()
        this.renderPanel()
      })
      foot.appendChild(btn)
      foot.appendChild(
        el(
          'div',
          'hunt-intro',
          `Clears every pick and hands the choices back. The gold is spent, not
           refunded — it is the only real drain on the purse in the game.`,
        ),
      )
    } else {
      foot.appendChild(el('div', 'hunt-intro', 'Nothing to retrain yet.'))
    }
    wrap.appendChild(foot)

    body.appendChild(wrap)
  }

  /**
   * The bestiary is a view of `counters`, not a new record — which is why it
   * can never disagree with the kill totals the rest of the HUD shows.
   */
  private renderBestiary(body: HTMLElement) {
    const g = this.game
    const wrap = el('div', 'hunt-wrap')

    wrap.appendChild(
      el(
        'div',
        'hunt-intro',
        `Every beast you kill is remembered. Mastery sharpens what you do to a
         species and blunts what it does back — and their elites carry the
         relics.`,
      ),
    )

    for (const kind of ['wolf', 'bear'] as EnemyKind[]) {
      const type = ENEMIES[kind]
      const kills = g.counters[kind]
      const tier = masteryTier(kills)
      const current = MASTERY_TIERS[tier]
      const next = MASTERY_TIERS[tier + 1]
      const card = el('div', 'beast')

      const head = el('div', 'g-head')
      head.innerHTML = `<b>${type.name}</b><span>${kills.toLocaleString()} slain</span>`
      card.append(head, el('div', 'b-lore', type.lore), el('div', 'g-desc', type.habits))

      const where = REGIONS.filter((r) => r.kind === kind)
        .map((r) => `<b style="color:${r.color}">${r.name}</b> ${r.levelMin}–${r.levelMax}`)
        .join(' · ')
      card.appendChild(
        el('div', 'b-where', `Ranges: ${where}. Elites are known as the ${type.eliteName}.`),
      )

      const mastery = el('div', 'b-mastery')
      const rank = current ? current.name : 'Unblooded'
      const bonus = current
        ? `+${Math.round((current.damage - 1) * 100)}% damage dealt` +
          (current.resist < 1 ? `, ${Math.round((1 - current.resist) * 100)}% less taken` : '')
        : 'No bonus yet'
      const toGo = next ? next.at - kills : 0
      mastery.innerHTML = `<div class="b-rank"><b>${rank}</b><span>${bonus}</span></div>
        <div class="q-bar"><i style="width:${
          next ? clamp(kills / next.at, 0, 1) * 100 : 100
        }%"></i></div>
        <div class="b-next">${
          next
            ? `${toGo.toLocaleString()} more to ${next.name}`
            : 'Mastered — nothing left to learn about them'
        }</div>`
      card.appendChild(mastery)

      card.appendChild(this.relicList(UNIQUES.filter((u) => u.from === kind)))
      wrap.appendChild(card)
    }

    const wandering = UNIQUES.filter((u) => u.from === null)
    if (wandering.length) {
      const card = el('div', 'beast')
      card.appendChild(
        el('div', 'g-head', `<b>Unclaimed</b><span>any elite</span>`),
      )
      card.appendChild(
        el('div', 'g-desc', 'Relics with no owner. Any elite in the march may be carrying one.'),
      )
      card.appendChild(this.relicList(wandering))
      wrap.appendChild(card)
    }

    body.appendChild(wrap)
  }

  private relicList(defs: UniqueDef[]): HTMLElement {
    const g = this.game
    const box = el('div', 'b-relics')
    box.appendChild(el('div', 'col-h', 'Relics'))
    for (const def of defs) {
      const found = g.foundUniques.has(def.id)
      const row = el('div', 'relic')
      row.classList.toggle('unfound', !found)
      // An unfound relic still advertises its slot: knowing something exists
      // for your hands is the hook, knowing its name would spend it.
      row.innerHTML = found
        ? `<b style="color:${RARITY_COLORS[4]}">${def.name}</b>
           <span>${def.rule}</span>
           <em>${def.flavour}</em>`
        : `<b>? ? ?</b><span>An undiscovered ${SLOT_LABEL[def.slot].toLowerCase()} relic.</span>`
      box.appendChild(row)
    }
    return box
  }

  private renderHunt(body: HTMLElement) {
    const g = this.game
    const wrap = el('div', 'hunt-wrap')

    const intro = el('div', 'hunt-intro')
    intro.innerHTML = `Your character keeps hunting while you are away, up to
      <b>${OFFLINE.capHours} hours</b>. Pick where — or leave it unpinned and it
      follows wherever you go.`
    wrap.appendChild(intro)

    for (const r of REGIONS) {
      if (!r.kind) continue
      const eligible = g.isGroundEligible(r)
      const outgrown = eligible && g.isGroundOutgrown(r)
      const active = g.huntingGround === r.id
      const card = el('div', 'ground')
      card.classList.toggle('sel', active)
      card.classList.toggle('locked', !eligible)
      card.classList.toggle('outgrown', outgrown)

      // Same call the ledger makes, mastery and relics included, so the rate
      // shown before choosing a ground is the rate that ground will pay.
      const rate = eligible
        ? killsPerHour(g.stats, r.kind, groundLevelOf(r), damageVs(g.mods, r.kind))
        : 0
      const beast = r.kind === 'wolf' ? 'Wolves' : 'Bears'
      const elites = r.eliteNodes > 0 ? ' and their elites' : ''

      const head = el('div', 'g-head')
      head.innerHTML = `<b style="color:${r.color}">${r.name}</b>
        <span>Levels ${r.levelMin}–${r.levelMax}</span>`
      const desc = el('div', 'g-desc', `${beast}${elites}.`)
      const stat = el('div', 'g-stat')
      if (!eligible) {
        stat.innerHTML = `<span class="locked-note">Too dangerous below level ${r.levelMin - 2}.</span>`
      } else if (outgrown) {
        stat.innerHTML = `Roughly <b>${Math.round(rate)}</b> kills an hour —
          <span class="outgrown-note">but you have outgrown it. Gold and gear only,
          no experience.</span>`
      } else {
        stat.innerHTML = `Roughly <b>${Math.round(rate)}</b> kills an hour at your current gear.`
      }

      const btn = el('button', 'btn')
      btn.textContent = active ? (g.groundPinned ? 'Assigned' : 'Following you') : 'Hunt here'
      btn.classList.toggle('on', active)
      btn.disabled = !eligible
      btn.addEventListener('click', () => {
        g.setHuntingGround(active && g.groundPinned ? null : r.id)
        this.renderPanel()
      })

      card.append(head, desc, stat, btn)
      wrap.appendChild(card)
    }

    const note = el('div', 'hunt-intro')
    note.innerHTML = g.groundPinned
      ? `Assigned deliberately. Press the assigned ground again to unpin it.`
      : `Unpinned — following you. Choose a ground to hold it there.`
    wrap.appendChild(note)

    body.appendChild(wrap)
  }

  private renderBag(body: HTMLElement) {
    const g = this.game
    const wrap = el('div', 'inv-wrap')

    const equipCol = el('div', 'equip-col')
    equipCol.appendChild(el('div', 'col-h', 'Equipped'))
    const grid = el('div', 'equip-grid')
    for (const slot of SLOTS) {
      const cell = el('div', 'equip-cell')
      const item = g.equipped[slot]
      const node = this.itemSlot(item, () => {
        g.unequip(slot)
        this.needsPanel = true
      })
      if (!item) node.appendChild(el('span', 'ph', SLOT_LABEL[slot].slice(0, 5)))
      cell.append(node, el('label', undefined, SLOT_LABEL[slot]))
      grid.appendChild(cell)
    }
    equipCol.appendChild(grid)

    const s = g.stats
    const stats = el('div', 'statblock')
    stats.innerHTML = `
      <div><span>Damage</span><b>${Math.round(s.damage)}</b></div>
      <div><span>Attacks / sec</span><b>${(1 / s.attackInterval).toFixed(2)}</b></div>
      <div><span>Crit chance</span><b>${Math.round(s.crit * 100)}%</b></div>
      <div><span>Armour</span><b>${s.armor}</b></div>
      <div><span>Max health</span><b>${s.maxHp}</b></div>
      <div><span>Strength</span><b>${s.str}</b></div>
      <div><span>Vitality</span><b>${s.vit}</b></div>
      <div><span>Agility</span><b>${s.agi}</b></div>`
    equipCol.appendChild(stats)

    const toggle = el('button', 'btn')
    toggle.style.marginTop = '10px'
    toggle.style.width = '100%'
    toggle.textContent = `Auto-equip: ${g.autoEquip ? 'On' : 'Off'}`
    toggle.classList.toggle('on', g.autoEquip)
    toggle.addEventListener('click', () => {
      this.toggleAutoEquip()
      this.renderPanel()
    })
    equipCol.appendChild(toggle)

    const bagCol = el('div', 'bag-col')
    const used = g.bag.filter(Boolean).length
    const header = el('div', 'col-h', `Bag <span>${used} / ${g.bag.length}</span>`)
    bagCol.appendChild(header)
    const bagGrid = el('div', 'bag-grid')
    g.bag.forEach((item, i) => {
      const node = this.itemSlot(item, () => {
        g.equipFromBag(i)
        this.needsPanel = true
      })
      if (item) {
        node.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          g.sellFromBag(i)
          this.hideTip()
          this.needsPanel = true
        })
        if (this.isUpgrade(item)) node.classList.add('up')
        if (item.unique) node.classList.add('relic')
      }
      bagGrid.appendChild(node)
    })
    bagCol.appendChild(bagGrid)

    const hint = el('div', 'col-h')
    hint.style.marginTop = '10px'
    hint.innerHTML = 'Click to equip &nbsp;·&nbsp; Right-click to sell'
    bagCol.appendChild(hint)

    wrap.append(equipCol, bagCol)
    body.appendChild(wrap)
  }

  private itemSlot(item: Item | null, onClick: () => void): HTMLElement {
    const node = el('div', 'slot')
    if (item) {
      node.classList.add(`r${item.rarity}`)
      const img = el('img')
      img.src = itemIcon(item.icon, item.rarity)
      img.alt = item.name
      node.appendChild(img)
      node.addEventListener('click', onClick)
      node.addEventListener('pointerenter', (e) => this.showTip(item, e as PointerEvent))
      node.addEventListener('pointermove', (e) => this.moveTip(e as PointerEvent))
      node.addEventListener('pointerleave', () => this.hideTip())
    }
    return node
  }

  private renderQuests(body: HTMLElement) {
    const g = this.game
    QUESTS.forEach((q, i) => {
      const done = i < g.questIndex
      const active = i === g.questIndex
      const card = el('div', `card${done ? ' done' : active ? '' : ' locked'}`)
      const main = el('div', 'cmain')
      const goal = q.objective.type === 'kill' ? q.objective.count : 1
      const have = done ? goal : active ? Math.min(g.questProgress, goal) : 0
      const objective = objectiveText(q.objective, have, goal)
      main.innerHTML = `<div class="ctitle">${q.name}</div>
        <div class="cdesc">${q.desc}</div>
        <div class="cdesc" style="margin-top:3px">${objective}</div>
        <div class="crew">${rewardText(q.reward)}</div>`
      card.appendChild(main)
      card.appendChild(
        el('div', 'cprog', done ? '<span class="tick">✔</span>' : active ? 'Active' : 'Locked'),
      )
      body.appendChild(card)
    })
  }

  private renderRewards(body: HTMLElement) {
    const g = this.game
    const intro = el('div', 'col-h')
    intro.innerHTML = 'Milestone rewards &nbsp;·&nbsp; claim them once the goal is met'
    body.appendChild(intro)

    for (const m of MILESTONES) {
      const value = g.metricValue(m.metric)
      const ready = value >= m.threshold
      const claimed = g.claimed.has(m.id)
      const card = el('div', `card${claimed ? ' done' : ready ? '' : ' locked'}`)
      const main = el('div', 'cmain')
      main.innerHTML = `<div class="ctitle">${m.name}</div>
        <div class="cdesc">${m.desc} — ${Math.min(value, m.threshold)} / ${m.threshold}</div>
        <div class="crew">${rewardText(m.reward)}</div>`
      card.appendChild(main)
      if (claimed) {
        card.appendChild(el('div', 'cprog', '<span class="tick">✔</span> Claimed'))
      } else if (ready) {
        const btn = el('button', 'btn on')
        btn.textContent = 'Claim'
        btn.addEventListener('click', () => {
          g.claimMilestone(m.id)
          this.renderPanel()
        })
        card.appendChild(btn)
      } else {
        card.appendChild(el('div', 'cprog', `${Math.round((value / m.threshold) * 100)}%`))
      }
      body.appendChild(card)
    }
  }

  /* ================= tooltip ================= */

  private showTip(item: Item, e: PointerEvent) {
    const equipped = this.game.equipped[item.slot]
    const relic = uniqueDefOf(item)
    const color = RARITY_COLORS[item.rarity]
    const lines = statLines(item)
      .map((l) => `<div class="t-stat">${l}</div>`)
      .join('')

    // A relic is compared to nothing. Its worth is a rule, and the score that
    // drives every other comparison in this tooltip cannot see it.
    let cmp = ''
    if (relic) {
      cmp = `<div class="t-rule">${relic.rule}</div>
        <div class="t-flavour">${relic.flavour}</div>`
    } else if (equipped && equipped.uid !== item.uid && !equipped.unique) {
      const delta = itemScore(item) - itemScore(equipped)
      const cls = delta > 0 ? 'up' : delta < 0 ? 'down' : ''
      cmp = `<div class="t-cmp">Equipped: ${equipped.name}<br>
        <span class="${cls}">${delta > 0 ? '▲ upgrade' : delta < 0 ? '▼ downgrade' : '≈ sidegrade'}</span></div>`
    } else if (equipped && equipped.uid !== item.uid && equipped.unique) {
      cmp = `<div class="t-cmp">Equipped: ${equipped.name}<br>
        <span>a relic — swapping it is your call, not auto-equip's</span></div>`
    }

    this.tip.innerHTML = `
      <div class="t-name" style="color:${color}">${item.name}</div>
      <div class="t-sub">${
        relic ? 'Relic' : rarityName(item.rarity)
      } ${SLOT_LABEL[item.slot]} · ilvl ${item.ilvl}</div>
      ${lines}
      ${cmp}
      <div class="t-hint">${
        relic ? 'Never sold, never auto-equipped, never dropped twice.' : `Sells for ${item.value}g`
      }</div>`
    this.tip.classList.add('show')
    this.moveTip(e)
  }

  private moveTip(e: PointerEvent) {
    const pad = 14
    const w = this.tip.offsetWidth
    const h = this.tip.offsetHeight
    let x = e.clientX + pad
    let y = e.clientY + pad
    if (x + w > window.innerWidth - 8) x = e.clientX - w - pad
    if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8
    this.tip.style.left = `${Math.max(8, x)}px`
    this.tip.style.top = `${Math.max(8, y)}px`
  }

  private hideTip() {
    this.tip.classList.remove('show')
  }
}

function objectiveText(objective: QuestObjective, have: number, goal: number): string {
  if (objective.type === 'kill') return `${labelFor(objective.kind)} — ${have} / ${goal}`
  const camp = CAMPS.find((c) => c.id === objective.camp)
  return `Reach ${camp?.name ?? 'the camp'}`
}

function labelFor(kind: string): string {
  if (kind === 'any') return 'Beasts slain'
  if (kind === 'elite') return 'Elites slain'
  if (kind === 'wolf') return 'Wolves slain'
  return 'Bears slain'
}

function rewardText(reward: {
  xp: number
  gold: number
  item?: { base: string; rarity: number; ilvl: number }
}): string {
  const bits: string[] = []
  if (reward.xp) bits.push(`${reward.xp} xp`)
  if (reward.gold) bits.push(`${reward.gold} gold`)
  if (reward.item) bits.push(`${rarityName(reward.item.rarity)} item`)
  return bits.join(' · ')
}
