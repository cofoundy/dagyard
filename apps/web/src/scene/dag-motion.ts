// Cámara y coreografía de la vista DAG: matemática pura (sin WebGL), la escena la usa cuadro a cuadro y los tests la
// fijan. El lenguaje es el de la constelación (#74, docs/qa/demo-viva/DISENO.md en demo/escena): travelling de grúa en
// la entrada, vuelo a una tarea al abrir su ficha y regreso, órbita lenta en reposo y luz que viaja por las líneas.

import type { PerspectiveCamera } from 'three';
import type { CardArea, SafeArea, SceneEdge } from './contract';
import type { NodeStatus } from '../data/types';

/** Cámara orbital alrededor de un punto + desplazamiento del centro óptico en px (camera.setViewOffset). */
export interface CamState {
  tx: number;
  ty: number;
  tz: number;
  r: number;
  theta: number;
  phi: number;
  ox: number;
  oy: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** 1 px del plano del grafo = K unidades del mundo (con la cámara de la vista general, 1 px del plano = 1 px de pantalla). */
export const K = 0.05;
export const FOV = 40;
/** Plano casi de frente: la cámara lo mira apenas desde arriba (profundidad sin perder la lectura izquierda → derecha). */
export const REST_PHI = Math.PI / 2 - 0.05;

/** Duración del travelling de entrada (s); el grafo crece de izquierda a derecha dentro de él. */
export const INTRO_DUR = 5;
export const GROW_START = 0.35;
export const GROW_DUR = 4.2;
/** Vuelo a una tarea y regreso (s). */
export const FLY_DUR = 1.7;
/** Un relevo de luz recorre su línea en este tiempo (s). */
export const RELAY_DUR = 1.1;
/** Cuánto se acerca la cámara a una tarea abierta (fracción de la distancia de la vista general). */
export const FOCUS_ZOOM = 0.42;

export function placeCamera(camera: PerspectiveCamera, s: CamState): void {
  const sp = Math.sin(s.phi);
  camera.position.set(s.tx + s.r * sp * Math.sin(s.theta), s.ty + s.r * Math.cos(s.phi), s.tz + s.r * sp * Math.cos(s.theta));
  camera.up.set(0, 1, 0);
  camera.lookAt(s.tx, s.ty, s.tz);
  camera.updateMatrixWorld(true);
}

/** Distancia a la que el plano z = 0 se ve 1:1 (1 px del grafo = 1 px de pantalla). */
export function restDistance(vp: Viewport, fov = FOV): number {
  return (vp.height / 2 / Math.tan(((fov / 2) * Math.PI) / 180)) * K;
}

export function safeSize(vp: Viewport, safe: SafeArea): { w: number; h: number } {
  return { w: Math.max(80, vp.width - safe.left - safe.right), h: Math.max(80, vp.height - safe.top - safe.bottom) };
}

/**
 * La vista general: mira el centro de la ventana del grafo que se ve (desplazada `pan` px) y lo pone en el centro del
 * rectángulo seguro. El plano (0,0) es la esquina superior izquierda del contenido.
 */
export function overviewCam(vp: Viewport, safe: SafeArea, pan: { x: number; y: number }): CamState {
  const { w, h } = safeSize(vp, safe);
  return {
    tx: (pan.x + w / 2) * K,
    ty: -(pan.y + h / 2) * K,
    tz: 0,
    r: restDistance(vp),
    theta: 0,
    phi: REST_PHI,
    ox: vp.width / 2 - (safe.left + w / 2),
    oy: vp.height / 2 - (safe.top + h / 2),
  };
}

/**
 * Vuelo a una tarea: se acerca, gira un poco hacia el lado de donde está (así se ve la profundidad de sus líneas) y la
 * deja en el centro de lo que la ficha no tapa.
 */
export function focusCam(vp: Viewport, safe: SafeArea, card: CardArea, p: { x: number; y: number }, side: number): CamState {
  const x0 = safe.left, x1 = Math.max(x0 + 80, vp.width - Math.max(safe.right, card.right));
  const y0 = safe.top, y1 = Math.max(y0 + 80, vp.height - Math.max(safe.bottom, card.bottom));
  return {
    tx: p.x * K,
    ty: -p.y * K,
    tz: 0,
    r: restDistance(vp) * FOCUS_ZOOM,
    theta: 0.2 * (side < 0 ? -1 : 1),
    phi: Math.PI / 2 - 0.13,
    ox: vp.width / 2 - (x0 + x1) / 2,
    oy: vp.height / 2 - (y0 + y1) / 2,
  };
}

/** Dónde arranca el travelling: cerca, de costado y un poco desde arriba sobre lo primero que nació. */
export function introStartCam(end: CamState, first: { x: number; y: number }): CamState {
  return { ...end, tx: first.x * K, ty: -first.y * K, r: end.r * 0.36, theta: end.theta - 0.62, phi: end.phi - 0.4 };
}

/**
 * En celular (#108) el travelling no viaja desde lo primero que nació (queda fuera de la pantalla, y el cielo se ve vacío
 * varios segundos): arranca ya encuadrado en lo de ahora, un poco más cerca y de costado, y solo se posa.
 */
export function introStartCamNear(end: CamState): CamState {
  return { ...end, r: end.r * 0.78, theta: end.theta - 0.24, phi: end.phi - 0.16 };
}

/** En celular la entrada es más corta: el frente de crecimiento solo recorre lo que se ve. */
export const INTRO_DUR_NEAR = 3.2;
export const GROW_DUR_NEAR = 2.4;
export const GROW_START_NEAR = 0.12;

/** Curva del travelling: arranca ya en movimiento (sin aire muerto) y se posa suave. */
export function introEase(t: number): number {
  const k = Math.min(1, Math.max(0, t));
  if (k >= 1) return 1;
  const out = 1 - Math.pow(2, -9 * k);
  const io = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  return out * 0.35 + io * 0.65;
}

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Frente de crecimiento (px) a los `s` segundos del travelling: de lo primero que nació a «ahora». */
export function growFront(s: number, x0: number, x1: number, dur = GROW_DUR, near = false): number {
  // en celular arranca casi enseguida y rápido (sale frenando): lo que se ve se enciende en el primer medio segundo
  const k = Math.min(1, Math.max(0, (s - (near ? GROW_START_NEAR : GROW_START)) / dur));
  const e = near ? 1 - (1 - k) * (1 - k) : k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
  return k <= 0 ? -Infinity : k >= 1 ? Infinity : x0 - 10 + (x1 + 14 - (x0 - 10)) * e;
}

/** Órbita lenta en reposo: un vaivén de ~3° en un ciclo de 40 s (y un poco de cabeceo, desfasado). */
export function restOrbit(t: number): { theta: number; phi: number } {
  return { theta: Math.sin((t * Math.PI * 2) / 40) * 0.052, phi: Math.sin((t * Math.PI * 2) / 57 + 1.3) * 0.022 };
}

/** Interpola dos cámaras; theta por el camino corto. */
export function lerpCam(a: CamState, b: CamState, k: number, out: CamState): CamState {
  let d = b.theta - a.theta;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  out.tx = a.tx + (b.tx - a.tx) * k;
  out.ty = a.ty + (b.ty - a.ty) * k;
  out.tz = a.tz + (b.tz - a.tz) * k;
  out.r = a.r + (b.r - a.r) * k;
  out.theta = a.theta + d * k;
  out.phi = a.phi + (b.phi - a.phi) * k;
  out.ox = a.ox + (b.ox - a.ox) * k;
  out.oy = a.oy + (b.oy - a.oy) * k;
  return out;
}

export interface RelayLeg {
  from: string;
  to: string;
}

/**
 * Por dónde viaja la luz cuando cambia un estado: lo que termina la pasa a lo que lo necesitaba; lo que arranca la recibe
 * de sus dependencias ya listas. «Nació de» no lleva relevos: no es una dependencia.
 */
export function relayLegs(edges: readonly SceneEdge[], nodeId: string, to: NodeStatus, statusOf: (id: string) => NodeStatus | undefined): RelayLeg[] {
  const needs = edges.filter((e) => e.kind === 'needs');
  if (to === 'done') return needs.filter((e) => e.from === nodeId).map((e) => ({ from: e.from, to: e.to }));
  if (to === 'working') return needs.filter((e) => e.to === nodeId && statusOf(e.from) === 'done').map((e) => ({ from: e.from, to: e.to }));
  return [];
}

/** Pan permitido (px) para ver un contenido de `cw × ch` en una ventana de `w × h`. */
export function clampPan(p: { x: number; y: number }, cw: number, ch: number, w: number, h: number): { x: number; y: number } {
  return { x: Math.max(0, Math.min(p.x, Math.max(0, cw - w))), y: Math.max(0, Math.min(p.y, Math.max(0, ch - h))) };
}
