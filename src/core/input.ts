import { clamp } from './math'

/**
 * Movement comes from either WASD/arrows or an on-screen virtual joystick.
 * The stick lives in the lower-left "stickzone" element: press anywhere in
 * that zone and the stick materialises under your finger.
 */
export class Input {
  /** Normalised move vector, magnitude 0..1. */
  moveX = 0
  moveY = 0
  usingStick = false

  private keys = new Set<string>()
  private pressedThisFrame = new Set<string>()
  private stickId: number | null = null
  private originX = 0
  private originY = 0
  private readonly maxRadius = 52

  constructor(
    private zone: HTMLElement,
    private stick: HTMLElement,
  ) {
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', () => this.keys.clear())

    zone.addEventListener('pointerdown', this.onDown)
    zone.addEventListener('pointermove', this.onMove)
    zone.addEventListener('pointerup', this.onUp)
    zone.addEventListener('pointercancel', this.onUp)
    // Stop the browser hijacking drags as text selection / scroll gestures.
    zone.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return
    const k = e.key.toLowerCase()
    this.keys.add(k)
    this.pressedThisFrame.add(k)
    if (['w', 'a', 's', 'd', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      e.preventDefault()
    }
  }

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key.toLowerCase())
  }

  private onDown = (e: PointerEvent) => {
    if (this.stickId !== null) return
    this.stickId = e.pointerId
    this.zone.setPointerCapture(e.pointerId)
    this.originX = e.clientX
    this.originY = e.clientY
    this.stick.style.left = `${this.originX}px`
    this.stick.style.top = `${this.originY}px`
    this.stick.classList.add('live')
    this.usingStick = true
    this.updateStick(e.clientX, e.clientY)
  }

  private onMove = (e: PointerEvent) => {
    if (e.pointerId !== this.stickId) return
    this.updateStick(e.clientX, e.clientY)
  }

  private onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.stickId) return
    this.stickId = null
    this.usingStick = false
    this.stick.classList.remove('live')
    const knob = this.stick.firstElementChild as HTMLElement | null
    if (knob) knob.style.transform = ''
  }

  private updateStick(cx: number, cy: number) {
    let dx = cx - this.originX
    let dy = cy - this.originY
    const len = Math.hypot(dx, dy)
    // Small dead zone so a tap doesn't twitch the character.
    if (len < 6) {
      dx = 0
      dy = 0
    }
    const clamped = Math.min(len, this.maxRadius)
    const nx = len > 0 ? (dx / len) * clamped : 0
    const ny = len > 0 ? (dy / len) * clamped : 0
    const knob = this.stick.firstElementChild as HTMLElement | null
    if (knob) knob.style.transform = `translate(${nx}px, ${ny}px)`
  }

  /** Call once per frame, before reading moveX/moveY. */
  sample() {
    let kx = 0
    let ky = 0
    if (this.keys.has('a') || this.keys.has('arrowleft')) kx -= 1
    if (this.keys.has('d') || this.keys.has('arrowright')) kx += 1
    if (this.keys.has('w') || this.keys.has('arrowup')) ky -= 1
    if (this.keys.has('s') || this.keys.has('arrowdown')) ky += 1

    if (kx || ky) {
      const l = Math.hypot(kx, ky)
      this.moveX = kx / l
      this.moveY = ky / l
      return
    }

    if (this.stickId !== null) {
      const knob = this.stick.firstElementChild as HTMLElement | null
      const t = knob?.style.transform ?? ''
      const m = /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(t)
      if (m) {
        const dx = parseFloat(m[1]!)
        const dy = parseFloat(m[2]!)
        const l = Math.hypot(dx, dy)
        const mag = clamp(l / this.maxRadius, 0, 1)
        this.moveX = l > 0 ? (dx / l) * mag : 0
        this.moveY = l > 0 ? (dy / l) * mag : 0
        return
      }
    }

    this.moveX = 0
    this.moveY = 0
  }

  down(key: string): boolean {
    return this.keys.has(key)
  }

  /** True only on the frame the key went down. Clear with endFrame(). */
  pressed(key: string): boolean {
    return this.pressedThisFrame.has(key)
  }

  endFrame() {
    this.pressedThisFrame.clear()
  }
}
