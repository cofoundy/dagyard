import { describe, expect, it } from 'vitest';
import { createSky } from './index';

describe('scaffold', () => {
  it('expone createSky con el contrato completo', () => {
    const sky = createSky({
      canvas: document.createElement('canvas'),
      labels: document.createElement('div'),
      handlers: { onPick: () => {} },
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    for (const k of ['setGraph', 'pulse', 'overview', 'focus', 'mark', 'replay', 'setSafeArea', 'setCardArea', 'dispose'] as const) {
      expect(typeof sky[k]).toBe('function');
    }
  });
});
