import { describe, expect, it } from 'vitest';
import { GROW_DUR_NEAR, GROW_START_NEAR, INTRO_DUR_NEAR, growFront, introStartCamNear, overviewCam } from './dag-motion';

describe('entrada en celular (#108)', () => {
  const vp = { width: 390, height: 844 };
  const end = overviewCam(vp, { top: 120, right: 0, bottom: 140, left: 0 }, { x: 520, y: 0 });

  it('arranca ya encuadrada en lo de ahora: mira el mismo punto que el final, sin el vuelo largo', () => {
    const start = introStartCamNear(end);
    expect(start.tx).toBe(end.tx);
    expect(start.ty).toBe(end.ty);
    expect(start.r).toBeGreaterThan(end.r * 0.6);
  });

  it('el frente recorre solo lo que se ve: arranca rápido y termina antes que la entrada', () => {
    const x0 = 500, x1 = 900;
    // a los 0,4 s el frente ya pasó la primera quinta parte de lo que se ve
    expect(growFront(0.4, x0, x1, GROW_DUR_NEAR, true)).toBeGreaterThan(x0 + (x1 - x0) / 5);
    expect(growFront(GROW_START_NEAR + GROW_DUR_NEAR, x0, x1, GROW_DUR_NEAR, true)).toBe(Infinity);
    expect(GROW_START_NEAR + GROW_DUR_NEAR).toBeLessThanOrEqual(INTRO_DUR_NEAR);
  });
});
