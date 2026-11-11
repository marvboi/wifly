/** Pure helpers for the onboarding logo-field mouse follow (speed.12.6.6). */

export const PLAY_LERP = 0.16
export const PLAY_HOT_PX = 96
export const PLAY_REST_EPS = 0.001

export function lerp(cur: number, target: number, t: number): number {
  return cur + (target - cur) * t
}

export function lerpToward(cur: number, target: number, t: number, eps = PLAY_REST_EPS): number {
  const next = lerp(cur, target, t)
  return Math.abs(target - next) < eps ? target : next
}

export function atRest(curX: number, curY: number, targetX: number, targetY: number, eps = PLAY_REST_EPS): boolean {
  return Math.abs(targetX - curX) < eps && Math.abs(targetY - curY) < eps
}

/** Normalize a pointer into [-1, 1] relative to a box. */
export function playNorm(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  return {
    x: ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
    y: ((clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1,
  }
}

export function clampNorm(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(-1, Math.min(1, x)),
    y: Math.max(-1, Math.min(1, y)),
  }
}

/** Layout-space center of a positioned child inside a field (ignores CSS transforms). */
export function layoutCenter(
  fieldRect: { left: number; top: number },
  el: { offsetLeft: number; offsetTop: number; offsetWidth: number; offsetHeight: number },
): { x: number; y: number } {
  return {
    x: fieldRect.left + el.offsetLeft + el.offsetWidth / 2,
    y: fieldRect.top + el.offsetTop + el.offsetHeight / 2,
  }
}

export function isHotAt(pointerX: number, pointerY: number, cx: number, cy: number, radius = PLAY_HOT_PX): boolean {
  const dx = pointerX - cx
  const dy = pointerY - cy
  return dx * dx + dy * dy < radius * radius
}

export function orientationNorm(gamma: number, beta: number): { x: number; y: number } {
  return clampNorm(gamma / 18, (beta - 45) / 30)
}
