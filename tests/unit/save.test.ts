import { describe, expect, it } from 'vitest'
import { SAVE_KEY, SAVE_VERSION, readSave, type Save } from '../../src/game/save'
import { perSpecies } from '../../src/game/types'
import { EcsSimulation } from '../../src/game/state'
import { World } from '../../src/game/world'

const seed = 20260812

function validSave(): Save {
  return {
    v: SAVE_VERSION,
    seed,
    savedAt: 1_786_700_000_000,
    player: { x: 2400, y: 3750, level: 1, xp: 0, xpNext: 100, str: 7, vit: 7, agi: 5, hp: 50, gold: 0, auto: false },
    bag: new Array(40).fill(null),
    equipped: { weapon: null, head: null, chest: null, hands: null, feet: null, ring: null },
    nextUid: 1,
    counters: { kills: 0, elite: 0, bosses: 0, gold: 0, quests: 0, species: perSpecies(0) },
    questIndex: 0,
    questProgress: 0,
    questTaken: false,
    claimed: [],
    discovered: ['hearthglen'],
    seenLandmarks: [],
    bossCleared: {},
    huntingGround: null,
    groundPinned: false,
    autoEquip: true,
    talents: [],
    foundUniques: [],
  }
}

describe('save decoder', () => {
  it('round trips the current schema', () => {
    const source = validSave()
    expect(readSave(JSON.parse(JSON.stringify(source)) as unknown, seed)).toEqual(source)
  })

  it('accepts the production serializer atomically', () => {
    const world = new World()
    const simulation = new EcsSimulation(world)
    // Serialize once. `serialize` stamps `savedAt` from the clock, so calling
    // it twice and comparing the two fails whenever the millisecond turns over
    // between them.
    const save = simulation.serialize()
    expect(readSave(JSON.parse(JSON.stringify(save)) as unknown, world.seed)).toEqual(save)
  })

  it.each([
    ['malformed nested player', (save: any) => { save.player.hp = 'full' }],
    ['NaN', (save: any) => { save.player.gold = Number.NaN }],
    ['infinity', (save: any) => { save.savedAt = Number.POSITIVE_INFINITY }],
    ['out of range', (save: any) => { save.player.x = -1 }],
    ['unknown id', (save: any) => { save.talents = ['missing-talent'] }],
    ['oversized array', (save: any) => { save.bag.push(null) }],
    ['wrong seed', (save: any) => { save.seed++ }],
  ])('rejects %s atomically', (_name, mutate) => {
    const save = validSave()
    mutate(save)
    expect(readSave(save, seed)).toBeNull()
  })

  it('uses a new key and leaves the old key isolated', () => {
    expect(SAVE_KEY).toBe('wildmarch.ecs.save.v1')
    expect(SAVE_KEY).not.toBe('wildmarch.save')
  })
})
