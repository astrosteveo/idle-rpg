import type { BeastSheetId } from '../assets/types'
import type { EntityId } from './contracts'
import type { EnemyKind, EnemyState } from './types'

export interface Transform { x: number; y: number; facing: number }
export interface Motion { vx: number; vy: number; moving: boolean }
export interface Collider { radius: number }
export interface Combatant { hp: number; maxHp: number; damage: number; attackRange: number }
export interface Renderable { sheet: BeastSheetId | 'warrior'; scale: number }
export interface EnemyAi { kind: EnemyKind; state: EnemyState; aggroRange: number; leash: number }
export interface SpawnLink { nodeId: number; anchorX: number; anchorY: number }
export interface StatusEffects { webbed: number; invulnerable: number; hitFlash: number }
export interface Lifetime { age: number; limit: number }
export interface PlayerControl { auto: boolean; targetId: EntityId }

export interface ComponentStores {
  transform: Map<EntityId, Transform>
  motion: Map<EntityId, Motion>
  collider: Map<EntityId, Collider>
  combatant: Map<EntityId, Combatant>
  renderable: Map<EntityId, Renderable>
  enemyAi: Map<EntityId, EnemyAi>
  spawnLink: Map<EntityId, SpawnLink>
  statusEffects: Map<EntityId, StatusEffects>
  lifetime: Map<EntityId, Lifetime>
  playerControl: Map<EntityId, PlayerControl>
}

export function componentStores(): ComponentStores {
  return {
    transform: new Map(), motion: new Map(), collider: new Map(), combatant: new Map(),
    renderable: new Map(), enemyAi: new Map(), spawnLink: new Map(), statusEffects: new Map(),
    lifetime: new Map(), playerControl: new Map(),
  }
}
