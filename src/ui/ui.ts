/**
 * The HUD. Everything here is DOM layered over the canvas — bars, panels and
 * the joystick — while the world itself stays entirely canvas-rendered.
 *
 * Cheap widgets (bars, cooldowns, minimap) refresh every frame; the heavy
 * panels only rebuild when the game marks itself dirty or a panel is opened.
 */
import { clamp } from '../core/math'
import {
  BOSS,
  BOSSES,
  ENEMIES,
  MASTERY_TIERS,
  MILESTONES,
  QUESTS,
  RARITY_COLORS,
  TALENT_ROWS,
  UNIQUES,
  bossWindowRemaining,
  damageVs,
  masteryTier,
  type UniqueDef,
} from '../game/content'
import { itemScore, rarityName, statLines, uniqueDefOf } from '../game/loot'
import type { EcsSimulation } from '../game/state'
import { ENEMY_KINDS, SLOTS, SLOT_LABEL, type EnemyKind, type Item } from '../game/types'
import type { QuestObjective } from '../game/content'
import {
  CAMPS,
  LANDMARKS,
  MAP_TILES,
  REGIONS,
  WORLD_SIZE,
  groundLevelOf,
  npcById,
  type Npc,
} from '../game/world'
import { killsPerHour, type OfflineReport } from '../game/offline'
import { OFFLINE } from '../game/content'
import type { Renderer } from '../render/renderer'
import { abilityIcon, itemIcon, warriorPortrait } from '../render/assets'
import { bakeMinimap } from '../render/minimap'

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
  private worldTitle!: HTMLElement
  private mmCtx!: CanvasRenderingContext2D
  private minimapBase!: HTMLCanvasElement
  private tracker!: HTMLElement
  private trackerGo!: HTMLButtonElement
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
  private talkPrompt!: HTMLButtonElement
  private dialog!: HTMLElement

  private tab: Tab = 'bag'
  private open = false
  private needsPanel = true
  private bannerTimer = 0
  private banners: { title: string; sub: string }[] = []
  /** Who the player is talking to, and how far through what they say. */
  private dialogNpc: Npc | null = null
  private dialogPage = 0

  constructor(
    private game: EcsSimulation,
    private renderer: Renderer,
  ) {
    this.root = document.getElementById('ui')!
    this.buildVitals()
    this.buildMap()
    this.buildWorldTitle()
    this.minimapBase = bakeMinimap(game.world)
    this.buildTracker()
    this.buildActions()
    this.buildLog()
    this.buildBanner()
    this.buildPanel()
    this.buildTooltip()
    this.buildDeath()
    this.buildReport()
    this.buildTalk()
    this.buildChromeToggle()
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
    this.show('bag')
  }

  /* ================= construction ================= */

  private buildVitals() {
    const box = el('div', 'frame')
    box.id = 'vitals'
    box.innerHTML = `
      <img class="portrait" alt="Warrior portrait" src="${warriorPortrait()}">
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

  private buildWorldTitle() {
    const title = el('div')
    title.id = 'world-title'
    this.root.appendChild(title)
    this.worldTitle = title
  }

  private buildTracker() {
    const box = el('div', 'frame')
    box.id = 'tracker'
    // The text is rewritten every frame; the button is not. A control that is
    // recreated between the press and the release never gets its click.
    const body = el('div')
    const go = el('button', 'btn t-go')
    go.addEventListener('click', () => this.travelToTask())
    box.append(body, go)
    this.root.appendChild(box)
    this.tracker = body
    this.trackerGo = go
  }

  /** Walk to the current task's work, or stop walking if already on the way. */
  private travelToTask() {
    const g = this.game
    if (g.travel) {
      g.dispatch({ type: 'cancel-travel' })
      return
    }
    const q = g.offeredQuest ?? g.quest
    if (!q) return
    const dest = g.questDestination(q)
    if (dest) g.dispatch({ type: 'travel-to', target: dest })
  }

  private buildActions() {
    const wrap = el('div')
    wrap.id = 'actions'
    const abilities = el('div')
    abilities.id = 'abilities'
    for (const ab of this.game.abilities) {
      const node = el('button', 'ability clickable')
      node.innerHTML = `<span class="key">${ab.key}</span>
        <img alt="${ab.name}" src="${abilityIcon(ab.id)}">
        <div class="cd"></div><div class="cdtext"></div><span class="ability-name">${ab.name}</span>`
      node.title = `${ab.name} — ${ab.desc}`
      node.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        this.game.dispatch({ type: 'use-ability', ability: ab.id })
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
    mk('Hunt', 'H', 'hunt')
    mk('Talents', 'T', 'talents', 'talents')
    mk('Beasts', 'B', 'beasts')

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

  private buildTalk() {
    const prompt = el('button', 'btn')
    prompt.id = 'talkprompt'
    prompt.addEventListener('click', () => this.speak())
    this.root.appendChild(prompt)
    this.talkPrompt = prompt

    const box = el('div', 'frame')
    box.id = 'dialog'
    this.root.appendChild(box)
    this.dialog = box
  }

  private buildChromeToggle() {
    const button = el('button', 'btn')
    button.id = 'chrome-toggle'
    button.type = 'button'
    button.setAttribute('aria-label', 'Collapse interface')
    button.textContent = '⌄'
    button.addEventListener('click', () => {
      const collapsed = this.root.classList.toggle('chrome-collapsed')
      button.textContent = collapsed ? '⌃' : '⌄'
      button.setAttribute('aria-label', collapsed ? 'Expand interface' : 'Collapse interface')
      if (collapsed) this.hide()
    })
    this.root.appendChild(button)
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

  /* ================= talking to people ================= */

  /**
   * One key does the whole conversation: it starts it, and it turns the page.
   * The lines a person says are chosen from the quest chain rather than stored,
   * so a character who reloads mid-conversation hears the same thing again.
   */
  private speak() {
    const g = this.game
    if (!g.player.alive) return
    if (this.dialogNpc) {
      const lines = this.linesFor(this.dialogNpc)
      if (this.dialogPage >= lines.length - 1) {
        // A task held out waits for a deliberate answer. Anything else ends.
        if (!g.offerFrom(this.dialogNpc)) this.closeDialog()
        return
      }
      this.dialogPage++
      this.renderDialog()
      return
    }
    const npc = g.nearbyNpc
    if (!npc) return
    this.dialogNpc = npc
    this.dialogPage = 0
    this.renderDialog()
  }

  private closeDialog() {
    this.dialogNpc = null
    this.dialog.classList.remove('show')
  }

  /** What this person has to say, given where the quest chain stands. */
  private linesFor(npc: Npc): string[] {
    const g = this.game
    if (g.offerFrom(npc)) return npc.intro
    if (g.quest?.from === npc.id) return [npc.waiting]
    return [npc.done]
  }

  private renderDialog() {
    const npc = this.dialogNpc
    if (!npc) return
    const g = this.game
    const lines = this.linesFor(npc)
    const page = clamp(this.dialogPage, 0, lines.length - 1)
    const last = page >= lines.length - 1
    // The task is held out on the last page, so the offer arrives after the
    // reason for it rather than on top of it.
    const offer = last ? g.offerFrom(npc) : null

    const box = this.dialog
    box.innerHTML = ''
    const who = el('div', 'd-who')
    who.innerHTML = `${npc.name}<small>${npc.title}</small>`
    box.appendChild(who)
    box.appendChild(el('div', 'd-text', lines[page]!))

    if (offer) {
      const card = el('div', 'd-offer')
      const goal = offer.objective.type === 'kill' ? offer.objective.count : 1
      card.innerHTML = `<div class="ctitle">${offer.name}</div>
        <div class="cdesc">${offer.desc}</div>
        <div class="cdesc" style="margin-top:3px">${objectiveText(offer.objective, 0, goal)}</div>
        <div class="crew">${rewardText(offer.reward)}</div>`
      box.appendChild(card)
    }

    // The page count goes above the buttons: below them it hangs off the box
    // and reads as part of the HUD underneath.
    if (lines.length > 1) box.appendChild(el('div', 'd-page', `${page + 1} / ${lines.length}`))

    const row = el('div', 'd-btns')
    if (offer) {
      const take = el('button', 'btn on')
      take.textContent = 'Accept'
      take.addEventListener('click', () => {
        g.dispatch({ type: 'accept-quest' })
        this.closeDialog()
      })
      const later = el('button', 'btn')
      later.textContent = 'Not yet'
      later.addEventListener('click', () => this.closeDialog())
      row.append(take, later)
    } else {
      const next = el('button', 'btn')
      next.innerHTML = last ? 'Farewell <span style="opacity:.5">G</span>' : 'Next <span style="opacity:.5">G</span>'
      next.addEventListener('click', () => this.speak())
      row.appendChild(next)
    }
    box.appendChild(row)
    box.classList.add('show')
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
    else if (k === 'g') this.speak()
    else if (k === 'escape') {
      if (this.dialogNpc) this.closeDialog()
      else this.hide()
    }
    else if (k === 'q') this.game.dispatch({ type: 'use-ability', ability: 'whirlwind' })
    else if (k === 'e') this.game.dispatch({ type: 'use-ability', ability: 'secondwind' })
    else if (k === ' ') this.toggleAuto()
    else if (k === 'f') this.toggleAutoEquip()
  }

  private toggleAuto() {
    const p = this.game.player
    this.game.dispatch({ type: 'toggle-auto' })
    this.log(p.auto ? 'Auto-battle engaged' : 'Auto-battle disengaged', '#9ad0ff')
    this.syncAuto()
  }

  /**
   * The button reads the simulation rather than remembering what it was last
   * told. Travel switches auto-battle on, and taking the stick switches it off
   * again, so the label has more than one author.
   */
  private syncAuto() {
    const g = this.game
    const on = g.player.auto
    const sub = g.travel
      ? `on the road to ${g.travel.label}`
      : on
        ? 'seeking beasts…'
        : 'seek &amp; slay nearby beasts'
    const html = `Auto: ${on ? 'On' : 'Off'}<small>${sub}</small>`
    if (this.autoBtn.innerHTML !== html) this.autoBtn.innerHTML = html
    this.autoBtn.classList.toggle('on', on)
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

  /**
   * Banners queue rather than overwrite. Walking into a camp can finish a task
   * in the same frame that finds the place, and the one the player most wants
   * to read is the one that used to be thrown away.
   */
  banner(title: string, sub: string) {
    this.banners.push({ title, sub })
    // Three deep is enough for any one moment; past that the parade is longer
    // than the event that caused it. The ones dropped are the last to arrive,
    // because the first is what the player did and the rest are its change.
    if (this.banners.length > 3) this.banners.length = 3
    if (this.bannerTimer <= 0) this.showBanner()
  }

  private showBanner() {
    const next = this.banners.shift()
    if (!next) {
      this.bannerBox.classList.remove('show')
      return
    }
    this.bannerBox.innerHTML = `<div class="banner-t">${next.title}</div><div class="banner-s">${next.sub}</div>`
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
      `<span>Damage <b>${Math.round(s.damage)}</b></span>` +
      `<span>Armor <b>${s.armor}</b></span>` +
      `<span>Critical Chance <b>${Math.round(s.crit * 100)}%</b></span>` +
      `<span>Attack Speed <b>${(1 / s.attackInterval).toFixed(2)}</b></span>`
    this.goldLabel.textContent = `${p.gold.toLocaleString()} gold`

    // A named place wins the headline and demotes its region to the subtitle:
    // "The Wind Altar" is the useful half of "somewhere on Stonewatch Ridge".
    const camp = g.currentCamp
    const region = g.world.regionAt(p.x, p.y)
    const here = camp?.name ?? g.currentLandmark?.name
    const label = here ? `${here}<small>${region.name}</small>` : region.name
    if (this.zoneLabel.innerHTML !== label) this.zoneLabel.innerHTML = label
    const worldHeading = window.innerWidth > 860
      ? `Wildmarch<small>${here ?? region.name}</small>`
      : label
    if (this.worldTitle.innerHTML !== worldHeading) this.worldTitle.innerHTML = worldHeading

    for (let i = 0; i < this.abilityEls.length; i++) {
      const ab = g.abilities[i]!
      const node = this.abilityEls[i]!
      const pct = ab.cd > 0 ? (ab.cd / ab.cooldown) * 100 : 0
      node.cd.style.height = `${pct}%`
      node.text.textContent = ab.cd > 0 ? `${Math.ceil(ab.cd)}` : ''
      node.root.classList.toggle('ready', ab.cd <= 0)
    }

    this.death.classList.toggle('show', !p.alive)

    // Walking away ends a conversation, and so does dying in the middle of one.
    const npc = p.alive ? g.nearbyNpc : null
    if (this.dialogNpc && this.dialogNpc !== npc) this.closeDialog()
    const prompt = npc && !this.dialogNpc ? `Speak to ${npc.name}` : ''
    if (prompt) {
      const html = `${prompt} <span style="opacity:.5">G</span>`
      if (this.talkPrompt.innerHTML !== html) this.talkPrompt.innerHTML = html
    }
    this.talkPrompt.classList.toggle('show', !!prompt)

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
    this.syncAuto()

    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt
      if (this.bannerTimer <= 0) this.showBanner()
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
    const travel = g.travel
    let html: string
    // A task nobody has handed over yet points at the person holding it, not at
    // an objective — otherwise the tracker asks for wolves the kills of which
    // count for nothing.
    const offer = g.offeredQuest
    const q = g.quest
    if (offer) {
      const who = npcById(offer.from!)
      html = `<h4>Current Task</h4>
        <div class="q-name">Speak to ${who?.name ?? 'the warden'}</div>
        <div class="q-desc">There is work waiting at ${who?.title ?? 'the camp'}.</div>
        <div class="q-obj">Stand beside them and press G</div>`
    } else if (!q) {
      html = `<h4>Task</h4><div class="q-name">All tasks complete</div>
        <div class="q-desc">The Wildmarch is yours. Keep hunting for rewards.</div>`
    } else {
      const goal = g.questGoal
      const have = Math.min(g.questProgress, goal)
      const objective = objectiveText(q.objective, have, goal)
      html = `<h4>Current Task</h4>
        <div class="q-name">${q.name}</div>
        <div class="q-desc">${q.desc}</div>
        <div class="q-obj${have >= goal ? ' done' : ''}">${objective}</div>
        <div class="q-bar"><i style="width:${(have / goal) * 100}%"></i></div>`
    }
    if (travel) html += `<div class="q-travel">On the road to ${travel.label}</div>`
    if (this.tracker.innerHTML !== html) this.tracker.innerHTML = html

    // The button offers the walk, and takes it back while one is under way.
    const task = offer ?? q
    const canGo = !!travel || (!!task && !!g.questDestination(task))
    this.trackerGo.classList.toggle('hide', !canGo)
    const label = travel ? 'Stop travelling' : 'Travel there'
    if (this.trackerGo.textContent !== label) this.trackerGo.textContent = label
    this.trackerGo.classList.toggle('on', !!travel)
  }

  private drawMinimap() {
    const g = this.game
    const ctx = this.mmCtx
    const size = 164
    const k = size / WORLD_SIZE
    ctx.clearRect(0, 0, size, size)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(this.minimapBase, 0, 0, MAP_TILES, MAP_TILES, 0, 0, size, size)

    // Visible slice of the world.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth = 1
    ctx.strokeRect(
      Math.round(this.renderer.viewX0 * k) + 0.5,
      Math.round(this.renderer.viewY0 * k) + 0.5,
      Math.round(this.renderer.vw * k),
      Math.round(this.renderer.vh * k),
    )

    for (const e of g.spatial.queryRadius(g.player.x, g.player.y, 1500)) {
      if (!e.alive) continue
      const d = Math.hypot(e.x - g.player.x, e.y - g.player.y)
      if (d > 1500) continue
      ctx.fillStyle = e.elite ? '#ff8a3c' : ENEMIES[e.kind].mapColor
      const s = e.elite ? 3 : 2
      ctx.fillRect(Math.round(e.x * k) - 1, Math.round(e.y * k) - 1, s, s)
    }

    // Landmarks under the camps: smaller, and only once found, so the map
    // fills in as the character learns the country rather than arriving solved.
    for (const l of LANDMARKS) {
      if (!g.seenLandmarks.has(l.id)) continue
      const lx = Math.round(l.x * k)
      const ly = Math.round(l.y * k)
      // A site with its apex standing on it burns; the rest are quiet marks.
      // Knowing where to be is most of a world boss.
      const boss = BOSSES.find((b) => b.site === l.id && g.bossIsUp(b.id))
      ctx.fillStyle = boss ? '#f0913a' : '#cbb489'
      ctx.fillRect(lx - 1, ly - 3, 2, 6)
      ctx.fillRect(lx - 3, ly - 1, 6, 2)
      if (boss) {
        ctx.fillRect(lx - 2, ly - 2, 4, 4)
        ctx.fillStyle = 'rgba(240,145,58,0.35)'
        ctx.fillRect(lx - 4, ly - 4, 8, 8)
      }
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

    // Where the walk is going, and the line it is walking. A destination the
    // map does not show is a destination the player has to take on trust.
    const t = g.travel
    if (t) {
      const tx = Math.round(t.x * k)
      const ty = Math.round(t.y * k)
      ctx.strokeStyle = 'rgba(154,208,255,0.5)'
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(px + 0.5, py + 0.5)
      ctx.lineTo(tx + 0.5, ty + 0.5)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = '#0a0b11'
      ctx.fillRect(tx - 4, ty - 1, 9, 3)
      ctx.fillRect(tx - 1, ty - 4, 3, 9)
      ctx.fillStyle = '#9ad0ff'
      ctx.fillRect(tx - 4, ty, 9, 1)
      ctx.fillRect(tx, ty - 4, 1, 9)
    }

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
          if (g.dispatch({ type: 'choose-talent', talentId: choice.id }).ok) this.renderPanel()
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
        g.dispatch({ type: 'respec' })
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

    for (const kind of ENEMY_KINDS) {
      const type = ENEMIES[kind]
      const kills = g.counters.species[kind]
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

    wrap.appendChild(this.apexSection())

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

  /**
   * The apex roster. The clock is the content here: it is derived from wall
   * time rather than from anything this character did, so what it says is what
   * it says for everybody — which is what makes it worth telling someone.
   */
  private apexSection(): HTMLElement {
    const g = this.game
    const now = Date.now()
    const card = el('div', 'beast')
    card.appendChild(
      el(
        'div',
        'g-head',
        `<b>Apex Beasts</b><span>${g.counters.bosses.toLocaleString()} felled</span>`,
      ),
    )
    card.appendChild(
      el(
        'div',
        'g-desc',
        `Five beasts hold the named places. Each keeps to the same hour for every
         hunter in the march — a new one walks every ${BOSS.periodMinutes} minutes,
         and the next is in ${duration(bossWindowRemaining(now) / 1000)}.`,
      ),
    )

    const list = el('div', 'b-relics')
    for (const def of BOSSES) {
      const site = LANDMARKS.find((l) => l.id === def.site)
      const up = g.bossIsUp(def.id)
      const row = el('div', 'relic')
      row.classList.toggle('unfound', !up)
      row.innerHTML = `<b style="color:${up ? RARITY_COLORS[4] : '#8b93a5'}">${def.name}</b>
        <span>${def.title} · level ${def.level} · ${
          site ? site.name : 'somewhere'
        } — ${up ? 'walking now' : `returns in ${duration(bossWindowRemaining(now) / 1000)}`}</span>
        <em>${def.lore}</em>`
      list.appendChild(row)
    }
    card.appendChild(list)
    return card
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
      const beast = ENEMIES[r.kind].plural
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
        g.dispatch({ type: 'unequip', slot })
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
        g.dispatch({ type: 'equip', bagIndex: i })
        this.needsPanel = true
      })
      if (item) {
        node.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          g.dispatch({ type: 'sell', bagIndex: i })
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
      const offered = active && !!g.offeredQuest
      const card = el('div', `card${done ? ' done' : active ? '' : ' locked'}`)
      const main = el('div', 'cmain')
      const goal = q.objective.type === 'kill' ? q.objective.count : 1
      const have = done ? goal : active && !offered ? Math.min(g.questProgress, goal) : 0
      const objective = objectiveText(q.objective, have, goal)
      const giver = q.from ? `<div class="cdesc">Given by ${q.giver}</div>` : ''
      main.innerHTML = `<div class="ctitle">${q.name}</div>
        <div class="cdesc">${q.desc}</div>
        ${giver}
        <div class="cdesc" style="margin-top:3px">${objective}</div>
        <div class="crew">${rewardText(q.reward)}</div>`
      card.appendChild(main)
      const side = el('div', 'cprog')
      side.appendChild(
        el(
          'div',
          undefined,
          done ? '<span class="tick">✔</span>' : offered ? 'Offered' : active ? 'Active' : 'Locked',
        ),
      )
      // Only the task in hand can be walked to. A locked one has no place yet,
      // and a finished one has no work left at the place it had.
      const dest = active ? g.questDestination(q) : null
      if (dest) {
        const going = g.travel?.questId === q.id
        const go = el('button', `btn c-go${going ? ' on' : ''}`)
        go.textContent = going ? 'Stop' : 'Travel'
        go.addEventListener('click', () => {
          if (going) {
            g.cancelTravel('Travel stopped.')
            this.needsPanel = true
            return
          }
          // Close the panel: the walk is the thing to watch, and it starts now.
          if (g.travelTo(dest)) this.hide()
        })
        side.appendChild(go)
      }
      card.appendChild(side)
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
          g.dispatch({ type: 'claim-milestone', milestoneId: m.id })
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

function labelFor(kind: EnemyKind | 'elite' | 'boss' | 'any'): string {
  if (kind === 'any') return 'Beasts slain'
  if (kind === 'elite') return 'Elites slain'
  if (kind === 'boss') return 'World bosses felled'
  return `${ENEMIES[kind].plural} slain`
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
