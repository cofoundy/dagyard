// #114: el nombre de una tarea en el cielo es tan tocable como su estrella, sin trabar el gesto del cielo.
import { describe, expect, it } from 'vitest';
import { hoverable, injectStyles, pickable, released } from './dag-labels';

const pointer = (type: string, pointerType: string) => Object.assign(new Event(type), { pointerType });

describe('el cielo: estrella y nombre como blancos (#114)', () => {
  it('soltar sin moverse sobre un nombre abre su tarea; en el vacío cierra la ficha; arrastrar no hace nada', () => {
    expect(released({ moved: false, pick: 'gh-25' })).toBe('gh-25');
    expect(released({ moved: false })).toBeNull();
    // arrastrar o deslizar empezando sobre un nombre mueve el cielo y no abre nada
    expect(released({ moved: true, pick: 'gh-25' })).toBeUndefined();
    expect(released(null)).toBeUndefined();
  });

  it('el clic de la estrella abre su tarea y no llega al lienzo (que cerraría la ficha)', () => {
    const el = document.createElement('button');
    const parent = document.createElement('div');
    parent.append(el);
    const log: string[] = [];
    parent.addEventListener('click', () => log.push('lienzo'));
    pickable(el, () => log.push('pick'), () => {});
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(log).toEqual(['pick']);
  });

  it('el ratón encima de un nombre ilumina su estrella; un dedo no deja «encima»', () => {
    const el = document.createElement('div');
    const log: string[] = [];
    hoverable(el, (on) => log.push(on ? 'hover' : 'unhover'));
    el.dispatchEvent(pointer('pointerenter', 'mouse'));
    el.dispatchEvent(pointer('pointerleave', 'mouse'));
    el.dispatchEvent(pointer('pointerenter', 'touch'));
    expect(log).toEqual(['hover', 'unhover']);
  });

  it('solo un nombre que se lee recibe el puntero, deja deslizar el cielo, y las estrellas van por encima', () => {
    const undo = injectStyles(document);
    const css = document.getElementById('dagyard-sky-style')!.textContent!;
    expect(css).toMatch(/\.sky-root \{[^}]*pointer-events: none/);
    expect(css).not.toMatch(/\.sky-lbl \{[^}]*pointer-events: auto/);
    expect(css).toMatch(/\.sky-lbl\.pick \{[^}]*pointer-events: auto[^}]*touch-action: none/);
    expect(css).toMatch(/\.sky-hit \{[^}]*z-index: 1/);
    undo();
  });
});
