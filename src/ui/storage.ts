/**
 * The only file that knows persistence is a browser feature.
 *
 * `Game` produces and consumes a plain object; everything here is storage and
 * lifecycle plumbing, so swapping localStorage for a server call later touches
 * nothing in the simulation.
 */
import type { Game } from '../game/state'
import { SAVE_KEY, isSaveV1, type SaveV1 } from '../game/save'

export function loadSave(expectSeed: number): SaveV1 | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isSaveV1(parsed, expectSeed) ? parsed : null
  } catch {
    // Corrupt or unreadable storage is the same as no save.
    return null
  }
}

export function writeSave(game: Game) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(game.serialize()))
  } catch {
    // Quota or private-mode failures must never interrupt play.
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * Autosave on a timer plus the two lifecycle events that actually fire on
 * mobile. `beforeunload` is deliberately not used — it is unreliable on phones,
 * and this game is built to be played on one.
 */
export function installAutosave(game: Game, intervalMs = 10000) {
  setInterval(() => writeSave(game), intervalMs)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') writeSave(game)
  })
  window.addEventListener('pagehide', () => writeSave(game))
}
