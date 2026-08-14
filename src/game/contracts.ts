import type { Rng } from '../core/math'
import type { Ability, Enemy, Item, Player, Slot } from './types'
import type { TravelTarget } from './state'
import type { Counters } from './state'

export type EntityId = number
export type AbilityId = Ability['id']

export interface InputFrame {
  moveX: number
  moveY: number
}

export interface ViewRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export type GameCommand =
  | { type: 'toggle-auto' }
  | { type: 'use-ability'; ability: AbilityId }
  | { type: 'travel-to'; target: TravelTarget }
  | { type: 'cancel-travel' }
  | { type: 'equip'; bagIndex: number }
  | { type: 'unequip'; slot: Slot }
  | { type: 'sell'; bagIndex: number }
  | { type: 'choose-talent'; talentId: string }
  | { type: 'respec' }
  | { type: 'accept-quest' }
  | { type: 'claim-milestone'; milestoneId: string }

export interface CommandResult {
  ok: boolean
  reason?: string
}

export type DomainEvent =
  | { type: 'log'; text: string; color?: string }
  | { type: 'banner'; title: string; subtitle: string }
  | { type: 'death'; entity: EntityId }
  | { type: 'discovery'; id: string }
  | { type: 'quest-changed'; questIndex: number }
  | { type: 'inventory-changed' }
  | { type: 'progression-changed'; level: number }

export interface Revisions {
  inventory: number
  progression: number
  quests: number
  world: number
  combat: number
}

export interface GameSnapshot {
  player: Readonly<Player>
  enemies: readonly Readonly<Enemy>[]
  bag: readonly (Readonly<Item> | null)[]
  equipped: Readonly<Record<Slot, Readonly<Item> | null>>
  questIndex: number
  questProgress: number
  counters: Readonly<Counters>
  travel: Readonly<TravelTarget> | null
  revisions: Readonly<Revisions>
}

export interface Clock {
  now(): number
}

export interface RngFactory {
  create(seed: number): Rng
}

export interface SimulationDependencies {
  clock: Clock
  rngFactory: RngFactory
}

export interface Simulation {
  readonly state: GameSnapshot
  update(dt: number, input: InputFrame): void
  dispatch(command: GameCommand): CommandResult
  snapshot(): Readonly<GameSnapshot>
  setView(view: ViewRect): void
  drainEvents(): readonly DomainEvent[]
}

export const SYSTEM_ORDER = [
  'command-input',
  'travel-target-selection',
  'movement',
  'player-attacks',
  'ground-effects',
  'enemy-ai-attacks',
  'rewards-progression',
  'regeneration',
  'spawning-bosses',
  'transient-cleanup',
] as const
