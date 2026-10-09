// El cielo del DAG (#75, una sola vista): three.js directo sobre el lenguaje de la constelación (campo estelar, grilla
// celeste, halo, picos de difracción, bloom, niebla, ondas, partículas). El grafo vive en un plano: x = cuándo nació
// cada tarea (scene/dag-layout.ts), y = su rama. La cámara es de verdad: travelling de grúa al entrar mientras el grafo
// crece de izquierda a derecha, vuelo a la tarea que abres y regreso, y una órbita lenta en reposo.
// Concepto aprobado: design/arbol/arbol.html + handoff.md; nota de André: «el artifact no tiene todo eso de las cámaras
// y los efectos especiales. está bien en concepto».

import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  FogExp2,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Points,
  PointsMaterial,
  PerspectiveCamera,
  QuadraticBezierCurve3,
  Scene,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Texture,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { fmtDuration, fmtTime, lang, t, type MessageKey } from '../i18n';
import { buildBackdrop } from './backdrop';
import type { CardArea, CreateSkyOptions, Pulse, SafeArea, SceneEdge, SceneGraph, SceneMode, SceneNode, Sky } from './contract';
import { layoutDag, timeTicks, type DagLayout } from './dag-layout';
import { fallback, fitText, injectStyles, textMeter } from './dag-labels';
import {
  FLY_DUR,
  FOV,
  GROW_DUR,
  GROW_DUR_NEAR,
  INTRO_DUR,
  INTRO_DUR_NEAR,
  K,
  RELAY_DUR,
  clampPan,
  easeInOut,
  focusCam,
  growFront,
  introEase,
  introStartCam,
  introStartCamNear,
  lerpCam,
  overviewCam,
  placeCamera,
  relayLegs,
  restDistance,
  restOrbit,
  safeSize,
  type CamState,
  type Viewport,
} from './dag-motion';
import { nowEdge } from './now-edge';
import { makeTextures, type SkyTextures } from './textures';

const COL = { done: 0xf4eee2, working: 0x9fd3ff, blocked: 0xffb547, pending: 0x8494ad, loose: 0x9aa6b8, ended: 0x5d6a80 } as const;
const PULSE_COL: Record<Pulse, number> = { done: 0xffffff, working: 0x9fd3ff, blocked: 0xffb547, born: 0x9fd3ff, message: 0xdfeeff };
const SEG = 40;
const PCOUNT = 160;
const RELAYS = 24;
const NO_WEBGL: MessageKey = 'scene.noWebgl';
/** Lo terminado se apaga con la edad: a las 6 h llega a su mínimo. */
const AGE_SPAN = 6 * 36e5;
/** En la entrada, las partículas aparecen cuando ya hay líneas por donde fluir (s). */
const GROW_FADE = 1.2;

interface NodeView {
  id: string;
  data: SceneNode;
  /** destino (px del plano) y posición animada con resorte */
  tx: number;
  ty: number;
  te: number;
  x: number;
  y: number;
  e: number;
  vx: number;
  vy: number;
  ve: number;
  /** 0 → 1: nacimiento (resorte con sobrepaso) */
  sc: number;
  vsc: number;
  lit: boolean;
  group: Group;
  glow: Sprite;
  spike: Sprite;
  ring: Sprite;
  shock: Sprite;
  selr: Sprite;
  dash: Sprite;
  thread: Line;
  threadMat: LineDashedMaterial;
  tip: Sprite;
  lbl: HTMLDivElement;
  hit: HTMLButtonElement;
  color: Color;
  dim: number;
  flash: number;
  spikeBoost: number;
  seed: number;
  shockT: number;
  dying: number;
  lblOn: boolean;
  lblTip: boolean;
  lblDx: number;
  lblDy: number;
  lblO: number;
}

interface EdgeView {
  key: string;
  from: string;
  to: string;
  kind: SceneEdge['kind'];
  curve: QuadraticBezierCurve3;
  line: Line;
  geo: BufferGeometry;
  solid: LineBasicMaterial;
  dashed: LineDashedMaterial;
  draw: number;
  base: Color;
  baseO: number;
  isDashed: boolean;
  dying: number;
  twin: boolean;
  flashT: number;
}

interface Relay {
  sprite: Sprite;
  edge: EdgeView | null;
  t: number;
  onArrive?: () => void;
}

function noop(): Sky {
  return { setGraph() {}, pulse() {}, overview() {}, focus() {}, mark() {}, replay() {}, setSafeArea() {}, setCardArea() {}, dispose() {} };
}

const statusClass = (n: SceneNode) => (n.status === 'blocked' ? 'blocked' : n.status);
const isEnded = (n: SceneNode) => n.closedAs === 'replaced' || n.closedAs === 'dropped' || n.closedAs === 'learned';

export function createSky(opts: CreateSkyOptions): Sky {
  const { canvas, handlers } = opts;
  const doc = canvas.ownerDocument;
  const win = doc.defaultView ?? window;
  const removeStyles = injectStyles(doc);
  const root = doc.createElement('div');
  root.className = 'sky-root';
  opts.labels.appendChild(root);

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch {
    fallback(root, t(NO_WEBGL));
    const sky = noop();
    sky.dispose = () => {
      root.remove();
      removeStyles();
    };
    return sky;
  }

  const REDUCED = typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FINE = typeof win.matchMedia === 'function' && win.matchMedia('(pointer: fine)').matches;
  const measure = textMeter(doc);

  renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, 1.75));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new Scene();
  scene.background = new Color(0x04060a);
  const fog = new FogExp2(0x04060a, 0.004);
  scene.fog = fog;
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 3000);
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new Vector2(1, 1), 0.72, 0.36, 0.18);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const T: SkyTextures = makeTextures();
  const dashTex = makeDashRing();
  const backdrop = buildBackdrop(T.dot);
  scene.add(backdrop);
  const world = new Group();
  scene.add(world);
  const axisG = new Group();
  world.add(axisG);

  // ---------- estado ----------
  let graph: SceneGraph = { nodes: [], edges: [], now: Date.now() };
  const byId = new Map<string, SceneNode>();
  const nodes = new Map<string, NodeView>();
  const edges = new Map<string, EdgeView>();
  let L: DagLayout | null = null;
  let rowH = 28;
  let offY = 0;
  let contentH = 300;
  let safe: SafeArea = { ...opts.safeArea };
  let card: CardArea = { right: 0, bottom: 0 };
  let vp: Viewport = { width: 1, height: 1 };
  let pan = { x: 0, y: 0 };
  let panBeforeFocus: { x: number; y: number } | null = null;
  let mode: SceneMode = 'intro';
  let focusId: string | null = null;
  let hoverId: string | null = null;
  let markId: string | null = null;
  let roving: string | null = null;
  let structureKey = '';
  let dirtyLayout = true;
  let dirtySize = true;
  let dirtyLabels = true;
  /** travelling: segundos desde que arrancó; null = no hay */
  let intro: number | null = null;
  let introPending = true;
  let clip = Infinity;
  /** El frente de crecimiento arranca aquí (px) y dura esto (s): en celular, solo lo que se ve. */
  let growX0 = 0;
  let growDur = GROW_DUR;
  const cam: CamState = { tx: 0, ty: 0, tz: 0, r: 60, theta: 0, phi: Math.PI / 2, ox: 0, oy: 0 };
  let tween: { from: CamState; to: CamState; t: number; dur: number; ease: (k: number) => number; onEnd?: () => void } | null = null;
  let restK = 0;
  const parallax = { x: 0, y: 0, tx: 0, ty: 0 };
  let down: { x: number; y: number; px: number; py: number; moved: boolean } | null = null;
  const alive = new Map<string, boolean>();
  /** #107: lo que se nombra en «ahora» con su hilo, y el resto abierto, agrupado. */
  const named = new Set<string>();
  let grouped: string[] = [];
  let groupOpen = false;
  /** #108: la primera estrella a la vista ya se marcó (performance.mark). */
  let firstStar = false;
  let firstFrame = false;

  // ---------- partículas y relevos ----------
  const pGeo = new BufferGeometry();
  const pPos = new Float32Array(PCOUNT * 3);
  pGeo.setAttribute('position', new BufferAttribute(pPos, 3));
  const pMat = new PointsMaterial({ size: 0.4, map: T.dot, color: COL.working, transparent: true, opacity: 0.85, depthWrite: false, blending: AdditiveBlending });
  const particles = new Points(pGeo, pMat);
  particles.frustumCulled = false;
  world.add(particles);
  const sprite = (map: Texture, color: number, opacity = 1) =>
    new Sprite(new SpriteMaterial({ map, color, transparent: true, opacity, depthWrite: false, depthTest: false, blending: AdditiveBlending }));
  const relays: Relay[] = Array.from({ length: RELAYS }, () => {
    const s = sprite(T.glow, 0xffffff, 0);
    s.visible = false;
    world.add(s);
    return { sprite: s, edge: null, t: 0 };
  });

  // ---------- «ahora», marcas del eje y pliegues ----------
  const nowMat = new LineDashedMaterial({ color: COL.working, transparent: true, opacity: 0.32, dashSize: 0.15, gapSize: 0.3, depthWrite: false });
  const nowLine = new Line(new BufferGeometry().setFromPoints([new Vector3(), new Vector3(0, -1, 0)]), nowMat);
  nowLine.frustumCulled = false;
  world.add(nowLine);
  const tickMat = new LineBasicMaterial({ color: 0x0e1622, transparent: true, opacity: 0.9, depthWrite: false });
  const foldMat = new LineBasicMaterial({ color: 0x1a2536, transparent: true, opacity: 0.8, depthWrite: false });
  const axisLabels: { el: HTMLDivElement; x: number; y: number }[] = [];
  const nowEl = doc.createElement('div');
  nowEl.className = 'sky-now';
  root.appendChild(nowEl);
  // el resto de lo abierto: una sola etiqueta bajo «ahora» que se despliega en la lista de sus nombres
  const moreBtn = doc.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'sky-more';
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.style.display = 'none';
  const moreList = doc.createElement('div');
  moreList.className = 'sky-more-list';
  moreList.id = `sky-more-${Math.random().toString(36).slice(2, 8)}`;
  moreList.hidden = true;
  moreBtn.setAttribute('aria-controls', moreList.id);
  moreBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (intro !== null) skipIntro();
    setGroupOpen(!groupOpen);
  });
  root.append(moreBtn, moreList);

  // ---------- nodos ----------
  function buildNode(n: SceneNode): NodeView {
    const group = new Group();
    const glow = sprite(T.glow, COL.done, 0);
    const spike = sprite(T.spike, COL.done, 0);
    spike.material.rotation = 0.12;
    const ring = sprite(T.ring, COL.blocked, 0);
    const shock = sprite(T.ring, 0xffffff, 0);
    const selr = sprite(T.ring, 0xffffff, 0);
    const dash = sprite(dashTex, 0xd9e1ec, 0);
    group.add(glow, spike, ring, shock, selr, dash);
    world.add(group);
    const threadMat = new LineDashedMaterial({ color: COL.working, transparent: true, opacity: 0.4, dashSize: 0.15, gapSize: 0.25, depthWrite: false, blending: AdditiveBlending });
    const thread = new Line(new BufferGeometry().setFromPoints([new Vector3(), new Vector3(1, 0, 0)]), threadMat);
    thread.frustumCulled = false;
    thread.visible = false;
    const tip = sprite(T.glow, COL.working, 0);
    world.add(thread, tip);
    const lbl = doc.createElement('div');
    lbl.className = 'sky-lbl';
    const hit = doc.createElement('button');
    hit.className = 'sky-hit';
    hit.type = 'button';
    hit.tabIndex = -1;
    hit.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (intro !== null) skipIntro();
      handlers.onPick(n.id);
    });
    hit.addEventListener('keydown', (ev) => keyNav(ev, n.id));
    hit.addEventListener('focus', () => reveal(n.id));
    hit.addEventListener('pointerenter', (ev) => {
      if (ev.pointerType === 'mouse' && hoverId !== n.id) {
        hoverId = n.id;
        dirtyLabels = true;
      }
    });
    hit.addEventListener('pointerleave', () => {
      if (hoverId === n.id) {
        hoverId = null;
        dirtyLabels = true;
      }
    });
    root.appendChild(lbl);
    root.appendChild(hit);
    return {
      id: n.id,
      data: n,
      tx: 0, ty: 0, te: 0, x: NaN, y: NaN, e: NaN, vx: 0, vy: 0, ve: 0,
      sc: 0, vsc: 0, lit: false,
      group, glow, spike, ring, shock, selr, dash, thread, threadMat, tip, lbl, hit,
      color: new Color(colorOf(n)),
      dim: 1, flash: 0, spikeBoost: 0,
      seed: (hashSeed(n.id) % 1000) / 100,
      shockT: -1, dying: -1,
      lblOn: false, lblTip: false, lblDx: 0, lblDy: 0, lblO: 0,
    };
  }

  function disposeNode(v: NodeView) {
    world.remove(v.group, v.thread, v.tip);
    for (const s of [v.glow, v.spike, v.ring, v.shock, v.selr, v.dash, v.tip]) s.material.dispose();
    v.thread.geometry.dispose();
    v.threadMat.dispose();
    v.lbl.remove();
    v.hit.remove();
    if (roving === v.id) roving = null;
  }

  function colorOf(n: SceneNode): number {
    if (isEnded(n)) return COL.ended;
    if (n.loose) return COL.loose;
    // un pedido o un trabajo continuo «vivo» no es trabajo en curso (#109): luz quieta, no el azul que late
    if (n.kind !== 'task' && n.kind !== 'goal' && n.status === 'working') return 0xd9e1ec;
    return COL[n.status];
  }

  // ---------- líneas: el extremo brillante es `to` (lo que la necesita, o lo que nació) ----------
  function buildEdge(e: SceneEdge, key: string): EdgeView {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array((SEG + 1) * 3), 3));
    geo.setAttribute('color', new BufferAttribute(new Float32Array((SEG + 1) * 3), 3));
    const solid = new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, blending: AdditiveBlending });
    const dashed = new LineDashedMaterial({ vertexColors: true, transparent: true, opacity: 0.5, dashSize: 0.2, gapSize: 0.2, depthWrite: false, blending: AdditiveBlending });
    const line = new Line(geo, solid);
    line.frustumCulled = false;
    world.add(line);
    return {
      key, from: e.from, to: e.to, kind: e.kind,
      curve: new QuadraticBezierCurve3(new Vector3(), new Vector3(), new Vector3()),
      line, geo, solid, dashed,
      draw: REDUCED ? SEG + 1 : 0,
      base: new Color(COL.pending), baseO: 0.3, isDashed: true, dying: -1, twin: false, flashT: -1,
    };
  }

  function disposeEdge(e: EdgeView) {
    world.remove(e.line);
    e.geo.dispose();
    e.solid.dispose();
    e.dashed.dispose();
  }

  function styleEdge(ed: EdgeView) {
    const a = byId.get(ed.from), b = byId.get(ed.to);
    if (!a || !b) return;
    let c: number = COL.pending, o = 0.36, dashed = true;
    if (ed.kind === 'origin') {
      // «nació de»: un filamento punteado, más tenue; se enciende con su vecindario
      c = b.status === 'blocked' ? COL.blocked : b.status === 'working' ? COL.working : 0xb8c2d2;
      o = b.status === 'working' || b.status === 'blocked' ? 0.4 : alive.get(b.id) ? 0.16 : 0.07;
    } else if (a.status === 'blocked' || b.status === 'blocked') {
      c = COL.blocked;
      o = 0.7;
    } else if (b.status === 'working' || a.status === 'working') {
      c = COL.working;
      o = 0.72;
      dashed = b.status === 'pending';
    } else if (a.status === 'done' && b.status === 'done') {
      c = 0xcfc6b6;
      o = alive.get(b.id) ? 0.4 : 0.16;
      dashed = false;
    } else if (a.status === 'done') {
      c = 0x8fa0b8;
      o = 0.34;
    }
    if (isEnded(a) || isEnded(b)) {
      c = COL.ended;
      o = Math.min(o, 0.16);
    }
    ed.base.set(c);
    ed.baseO = o;
    ed.isDashed = dashed;
    ed.line.material = dashed ? ed.dashed : ed.solid;
  }

  const tv = new Vector3();
  const tc = new Color();
  function shapeEdge(ed: EdgeView) {
    const A = nodes.get(ed.from), B = nodes.get(ed.to);
    if (!A || !B) return;
    const ax = A.x * K, ay = -A.y * K, bx = B.x * K, by = -B.y * K;
    const dx = bx - ax, dy = by - ay;
    const d = Math.hypot(dx, dy) || 1e-3;
    // hacia adelante en el tiempo se arquea arriba; hacia atrás (necesita algo nacido después), abajo
    let k = Math.min(90 * K, d * 0.22) * (dx >= 0 ? 1 : -1);
    if (ed.kind === 'origin') k = Math.min(40 * K, Math.abs(k) * 0.4) * (ed.twin ? -1 : 1);
    ed.curve.v0.set(ax, ay, 0);
    ed.curve.v1.set((ax + bx) / 2, (ay + by) / 2 + k, Math.abs(k) * 0.4);
    ed.curve.v2.set(bx, by, 0);
    const pos = ed.geo.getAttribute('position') as BufferAttribute;
    const col = ed.geo.getAttribute('color') as BufferAttribute;
    for (let i = 0; i <= SEG; i++) {
      const u = i / SEG;
      ed.curve.getPoint(u, tv);
      pos.setXYZ(i, tv.x, tv.y, tv.z);
      const g = ed.kind === 'origin' ? 0.15 + 0.85 * Math.pow(u, 1.4) : 0.04 + 0.96 * Math.pow(u, 2.2);
      tc.copy(ed.base).multiplyScalar(g);
      col.setXYZ(i, tc.r, tc.g, tc.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    if (ed.isDashed) ed.line.computeLineDistances();
    ed.geo.computeBoundingSphere();
  }

  // ---------- disposición ----------
  function measureViewport(): boolean {
    const w = Math.max(1, Math.round(canvas.clientWidth || win.innerWidth));
    const h = Math.max(1, Math.round(canvas.clientHeight || win.innerHeight));
    if (w === vp.width && h === vp.height) return false;
    vp = { width: w, height: h };
    renderer.setSize(w, h, false);
    composer.setPixelRatio(Math.min(win.devicePixelRatio || 1, 1.75));
    composer.setSize(w, h);
    bloom.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    return true;
  }

  const mobile = () => vp.width <= 720;

  function computeAlive() {
    alive.clear();
    const visit = (id: string, stack: Set<string>): boolean => {
      if (alive.has(id)) return alive.get(id)!;
      const n = byId.get(id);
      if (!n || stack.has(id)) return false;
      stack.add(id);
      const v = n.status !== 'done' || n.children.some((c) => visit(c, stack));
      stack.delete(id);
      alive.set(id, v);
      return v;
    };
    for (const n of graph.nodes) visit(n.id, new Set());
  }

  function relayout(animate: boolean) {
    dirtyLayout = false;
    const { w, h } = safeSize(vp, safe);
    if (!graph.nodes.length) {
      L = null;
      named.clear();
      grouped = [];
      renderGroup();
      clearAxis();
      return;
    }
    const width = mobile() ? Math.max(w, 900) : w;
    const prev = L;
    // al borde de «ahora» solo llegan tareas (#109): un pedido o la meta vivos no son trabajo en curso
    const edge = nowEdge(graph.nodes.filter((n) => n.tail), { now: graph.now });
    named.clear();
    for (const id of edge.named) named.add(id);
    grouped = edge.grouped;
    renderGroup();
    L = layoutDag(
      graph.nodes.map((n) => ({ id: n.id, born: n.born, parent: n.parent, children: n.children, status: n.status, toNow: named.has(n.id), labelled: named.has(n.id) || !!n.named || n.kind === 'goal' })),
      { width, now: graph.now, activity: graph.activity, padL: mobile() ? 24 : 40, padR: mobile() ? 150 : 230, labelReserve: mobile() ? 120 : 150, prevRows: prev?.row ?? null },
    );
    const nRows = L.rows[1] - L.rows[0] + 1;
    const keep = animate && prev && prev.rows[0] === L.rows[0] && 34 + nRows * rowH + 30 <= h;
    if (!keep) {
      rowH = Math.max(mobile() ? 32 : 26, Math.min(48, (h - 64) / nRows));
      offY = Math.min(40, Math.max(0, (h - (34 + nRows * rowH + 30)) / 2));
    }
    contentH = 34 + nRows * rowH + 30 + offY;
    for (const n of graph.nodes) {
      const v = nodes.get(n.id);
      if (!v) continue;
      v.tx = L.x.get(n.id)!;
      v.ty = offY + 34 + (L.row.get(n.id)! - L.rows[0]) * rowH + rowH / 2;
      v.te = L.stemEnd.get(n.id)!;
      if (Number.isNaN(v.x) || !animate || REDUCED) {
        // lo que nace en vivo brota de su origen; lo demás aparece en su lugar
        const p = n.parent ? nodes.get(n.parent) : undefined;
        const from = animate && !REDUCED && p && !Number.isNaN(p.x) ? p : null;
        v.x = from ? from.x : v.tx;
        v.y = from ? from.y : v.ty;
        v.e = v.x;
        if (!from) {
          v.x = v.tx;
          v.y = v.ty;
          v.e = v.te;
        }
      }
    }
    for (const ed of edges.values()) shapeEdge(ed);
    drawAxis();
    pan = clampPan(pan, L.width, contentH, w, h);
    dirtyLabels = true;
  }

  function clearAxis() {
    for (const c of [...axisG.children]) {
      axisG.remove(c);
      (c as LineSegments).geometry?.dispose();
    }
    for (const a of axisLabels) a.el.remove();
    axisLabels.length = 0;
    nowEl.style.opacity = '0';
  }

  function drawAxis() {
    clearAxis();
    if (!L) return;
    const { h } = safeSize(vp, safe);
    const top = 14, bottom = Math.max(contentH, h) - 6;
    const pts: number[] = [];
    let prevT: number | null = null;
    for (const tk of timeTicks(L, mobile() ? 56 : 70)) {
      pts.push(tk.x * K, -top * K, -0.5, tk.x * K, -(bottom - 22) * K, -0.5);
      const d = new Date(tk.t);
      const el = doc.createElement('div');
      el.className = 'sky-tick';
      el.textContent =
        (d.getMinutes() ? fmtTime(tk.t, { hour: 'numeric', minute: '2-digit' }) : fmtTime(tk.t, { hour: 'numeric' })) +
        (prevT !== null && new Date(prevT).toDateString() !== d.toDateString() ? ` · ${fmtTime(tk.t, { weekday: 'short' })}` : '');
      prevT = tk.t;
      root.appendChild(el);
      axisLabels.push({ el, x: tk.x, y: bottom - 16 });
    }
    if (pts.length) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
      axisG.add(new LineSegments(g, tickMat));
    }
    const fpts: number[] = [];
    for (const f of L.folds) {
      for (const x of [f.x0 + 6, f.x1 - 6]) fpts.push(x * K, -top * K, -0.5, x * K, -(bottom - 22) * K, -0.5);
      // el silencio se dice corto y en horizontal, en la línea de las horas, y solo si es de días («5 d», #109); uno de
      // horas lo cuentan las marcas de hora a sus lados
      const hrs = (f.to - f.from) / 36e5;
      if (hrs < 36) continue;
      const el = doc.createElement('div');
      el.className = 'sky-fold';
      el.textContent = t('gap.days', { count: Math.round(hrs / 24) });
      el.title = t('scene.quiet', { dur: fmtDuration(f.to - f.from) });
      root.appendChild(el);
      axisLabels.push({ el, x: (f.x0 + f.x1) / 2, y: bottom - 16 });
    }
    if (fpts.length) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(fpts), 3));
      axisG.add(new LineSegments(g, foldMat));
    }
    nowEl.textContent = t('scene.now', { time: fmtTime(graph.now, { hour: 'numeric', minute: '2-digit' }) });
    nowLine.geometry.setFromPoints([new Vector3(L.nowX * K, -(top + 6) * K, 0), new Vector3(L.nowX * K, -(bottom - 22) * K, 0)]);
    nowLine.computeLineDistances();
  }

  // la píldora habla como la brújula (#109): «+2 más en curso · 1 sin noticias», no «+3 más en curso» a secas
  function groupText(list: Array<SceneNode | undefined>): string {
    const quiet = list.filter((n) => n?.quiet).length;
    const moving = list.length - quiet;
    const parts = [moving ? t('scene.moreMoving', { count: moving }) : '', quiet ? t('scene.moreQuiet', { count: quiet }) : ''];
    return parts.filter(Boolean).join(' · ');
  }

  // ---------- el grupo de «ahora» (#107): lo abierto que no lleva hilo, a un click ----------
  let groupKey = '';
  function renderGroup() {
    // se rehace solo si cambió (el reloj relayouta cada minuto: el foco del teclado no se pierde)
    const key = `${lang()}|${grouped.map((id) => `${id}:${byId.get(id)?.status}:${byId.get(id)?.title}:${byId.get(id)?.quiet}`).join('|')}`;
    if (key === groupKey) return;
    groupKey = key;
    moreBtn.style.display = grouped.length ? '' : 'none';
    moreBtn.textContent = grouped.length ? groupText(grouped.map((id) => byId.get(id))) : '';
    moreList.textContent = '';
    if (!grouped.length) {
      setGroupOpen(false);
      return;
    }
    const hint = doc.createElement('p');
    hint.className = 'sky-more-hint';
    hint.textContent = t('scene.moreHint');
    moreList.appendChild(hint);
    for (const id of grouped) {
      const n = byId.get(id);
      if (!n) continue;
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = `sky-more-item ${statusClass(n)}`;
      const pre = prefixOf(n);
      if (pre) {
        const sp = doc.createElement('span');
        sp.className = 'pre';
        sp.textContent = `${pre} · `;
        b.appendChild(sp);
      }
      b.appendChild(doc.createTextNode(n.title || '—'));
      b.title = n.title;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setGroupOpen(false);
        handlers.onPick(id);
      });
      const lightOn = () => {
        hoverId = id;
        dirtyLabels = true;
      };
      const lightOff = () => {
        if (hoverId !== id) return;
        hoverId = null;
        dirtyLabels = true;
      };
      b.addEventListener('pointerenter', lightOn);
      b.addEventListener('pointerleave', lightOff);
      b.addEventListener('focus', () => {
        lightOn();
        reveal(id);
      });
      b.addEventListener('blur', lightOff);
      moreList.appendChild(b);
    }
  }

  function setGroupOpen(on: boolean) {
    if (on === groupOpen) return;
    groupOpen = on;
    moreBtn.setAttribute('aria-expanded', String(on));
    moreList.hidden = !on;
    if (!on && hoverId && grouped.includes(hoverId)) hoverId = null;
    dirtyLabels = true;
  }

  /** Lo que se enciende: el vecindario de la tarea abierta o señalada; con el grupo desplegado, el grupo. */
  function lit(): Set<string> | null {
    const id = focusId ?? hoverId;
    if (id) return related(id);
    return groupOpen ? new Set(grouped) : null;
  }

  // ---------- etiquetas: pocas, por prioridad, sin choques; lo vivo se nombra en el borde de «ahora» ----------
  function related(id: string | null): Set<string> | null {
    if (!id) return null;
    const out = new Set([id]);
    for (const e of graph.edges) {
      if (e.from === id) out.add(e.to);
      if (e.to === id) out.add(e.from);
    }
    return out;
  }

  function prio(n: SceneNode, rel: Set<string> | null): number {
    if (focusId === n.id || hoverId === n.id || markId === n.id) return 1000;
    if (n.status === 'blocked') return 900;
    if (rel?.has(n.id)) return 850;
    if (named.has(n.id)) return 800;
    // además de lo que tiene hilo, solo la meta, los cabos sueltos y lo que sigue (#109); los pedidos, al pasar el mouse
    if (n.kind === 'goal' || n.loose) return 700;
    if (n.named) return 650;
    return 0;
  }

  function prefixOf(n: SceneNode): string {
    if (n.kind === 'goal') return t('scene.goal');
    if (isEnded(n)) return t(n.closedAs === 'dropped' ? 'scene.dropped' : n.closedAs === 'replaced' ? 'scene.replaced' : 'scene.learned');
    // un cabo suelto se ve por su anillo punteado y la ficha lo explica: el rótulo dice solo su nombre, el mismo que la
    // brújula (una palabra por estado en toda la interfaz, #109)
    return '';
  }

  function placeLabels() {
    dirtyLabels = false;
    if (!L) return;
    const rel = focusId ? related(focusId) : groupOpen ? new Set(grouped) : null;
    // en el vuelo a una tarea las estrellas se separan: los choques se miden a esa escala
    const s = focusId ? 1 / 0.42 : 1;
    const fv = focusId ? nodes.get(focusId) : undefined;
    const cx = fv ? fv.tx : 0, cy = fv ? fv.ty : 0;
    const P = (x: number, y: number) => ({ x: cx + (x - cx) * s, y: cy + (y - cy) * s });
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const stars = graph.nodes.map((n) => {
      const v = nodes.get(n.id)!;
      const p = P(v.tx, v.ty);
      return { id: n.id, x0: p.x - 7, x1: p.x + 7, y0: p.y - 7, y1: p.y + 7 };
    });
    const W = Math.max(L.width, safeSize(vp, safe).w);
    const order = graph.nodes
      .map((n) => [prio(n, rel), n] as const)
      .filter(([p]) => p > 0)
      .sort((a, b) => b[0] - a[0] || b[1].born - a[1].born);
    const shown = new Set<string>();
    for (const [p, n] of order) {
      const v = nodes.get(n.id)!;
      const weight = n.status === 'blocked' || n.kind === 'goal' ? 500 : 400;
      const sp = P(v.tx, v.ty);
      const tip = !focusId && named.has(n.id) && v.te > v.tx + 4;
      const max = tip ? Math.max(60, W - (v.te + 14) - 10) : p >= 850 ? 260 : 210;
      const pre = prefixOf(n);
      const preTxt = pre ? `${pre} · ` : '';
      const txt = fitText(n.title || '—', max - measure(preTxt, weight), (q) => measure(q, weight));
      const w = measure(preTxt + txt, weight);
      let x0 = tip ? v.te + 14 : sp.x + 11;
      let dx = tip ? 14 : 11;
      if (!tip && x0 + w > W - 6) {
        x0 = sp.x - 11 - w;
        dx = -11 - w;
      }
      const b = tip ? { x0, x1: x0 + w, y0: sp.y - 8, y1: sp.y + 7 } : { x0, x1: x0 + w, y0: sp.y - 22, y1: sp.y - 7 };
      const clash = placed.some((q) => b.x0 < q.x1 + 4 && b.x1 > q.x0 - 4 && b.y0 < q.y1 && b.y1 > q.y0) || stars.some((q) => q.id !== n.id && b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0);
      if (clash && p < 1000) continue;
      placed.push(b);
      shown.add(n.id);
      v.lblTip = tip;
      v.lblDx = dx;
      v.lblDy = tip ? -8 : -22;
      v.lbl.textContent = '';
      if (pre) {
        const sp2 = doc.createElement('span');
        sp2.className = 'pre';
        sp2.textContent = preTxt;
        v.lbl.appendChild(sp2);
      }
      v.lbl.appendChild(doc.createTextNode(txt));
    }
    for (const n of graph.nodes) {
      const v = nodes.get(n.id)!;
      v.lblOn = shown.has(n.id);
      v.lbl.className = ['sky-lbl', statusClass(n), n.kind === 'goal' ? 'goal' : '', n.kind === 'request' ? 'request' : '', n.loose ? 'loose' : '', isEnded(n) ? 'ended' : '', focusId === n.id ? 'sel' : ''].filter(Boolean).join(' ');
      v.hit.setAttribute('aria-label', hitLabel(n));
    }
  }

  function hitLabel(n: SceneNode): string {
    const pre = prefixOf(n);
    const status = t(n.status === 'done' ? 'status.done' : n.status === 'working' ? 'status.working' : n.status === 'blocked' ? 'status.blocked' : 'status.pending');
    return t('scene.hit', { title: `${pre ? `${pre}: ` : ''}${n.title}`, status, time: fmtTime(n.born, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) });
  }

  // ---------- cámara ----------
  function restCam(): CamState {
    return overviewCam(vp, safe, pan);
  }

  function flyTo(to: CamState, dur: number, ease: (k: number) => number = easeInOut, onEnd?: () => void) {
    tween = { from: { ...cam }, to: { ...to }, t: 0, dur: REDUCED ? 1e-3 : dur, ease, onEnd };
  }

  function setMode(m: SceneMode, notify: boolean) {
    if (mode === m) return;
    mode = m;
    if (notify) handlers.onModeChange?.(m);
  }

  function startIntro() {
    introPending = false;
    if (!L || !graph.nodes.length) return;
    const { w } = safeSize(vp, safe);
    // se abre en lo de ahora: si el grafo no entra, el final del travelling mira el borde derecho
    pan = clampPan({ x: L.width - w, y: pan.y }, L.width, contentH, w, safeSize(vp, safe).h);
    const end = restCam();
    if (REDUCED) {
      for (const v of nodes.values()) {
        v.sc = 1;
        v.lit = true;
      }
      for (const e of edges.values()) e.draw = SEG + 1;
      Object.assign(cam, end);
      intro = null;
      clip = Infinity;
      setMode(focusId ? 'focus' : 'overview', true);
      return;
    }
    const near = mobile();
    const first = graph.nodes.reduce((a, b) => (b.born < a.born ? b : a));
    const fv = nodes.get(first.id)!;
    const x0 = Math.min(...[...nodes.values()].map((v) => v.tx));
    // en celular el grafo es más ancho que la pantalla y la entrada mira lo de ahora: lo que queda a la izquierda
    // (fuera de cuadro) ya está, y el frente recorre solo lo que se ve
    growX0 = near ? Math.max(x0, pan.x - 20) : x0;
    growDur = near ? GROW_DUR_NEAR : GROW_DUR;
    Object.assign(cam, near ? introStartCamNear(end) : introStartCam(end, { x: fv.tx + 120, y: fv.ty }));
    for (const v of nodes.values()) {
      const before = near && v.tx < growX0;
      v.sc = before ? 1 : 0;
      v.vsc = 0;
      v.lit = before;
    }
    for (const e of edges.values()) e.draw = 0;
    intro = 0;
    clip = -Infinity;
    mode = 'intro';
    flyTo(end, near ? INTRO_DUR_NEAR : INTRO_DUR, introEase, () => {
      intro = null;
      clip = Infinity;
      if (focusId) {
        const v = nodes.get(focusId);
        if (v) flyTo(focusCam(vp, safe, card, { x: v.tx, y: v.ty }, sideOf(v)), FLY_DUR);
        setMode('focus', true);
      } else setMode('overview', true);
    });
  }

  function skipIntro() {
    if (intro === null) return;
    intro = null;
    clip = Infinity;
    for (const e of edges.values()) e.draw = Math.max(e.draw, SEG + 1);
    if (tween?.onEnd) {
      const end = tween.onEnd;
      Object.assign(cam, tween.to);
      tween = null;
      end();
    }
  }

  function sideOf(v: NodeView): number {
    const { w } = safeSize(vp, safe);
    return v.tx - pan.x - w / 2 >= 0 ? 1 : -1;
  }

  /** Si la estrella está fuera de la ventana (teclado, buscar), el plano se desplaza hasta ella. */
  function reveal(id: string) {
    const v = nodes.get(id);
    if (!v || !L || mode === 'focus') return;
    const { w, h } = safeSize(vp, safe);
    let { x, y } = pan;
    if (v.tx < pan.x + 60 || v.tx > pan.x + w - 80) x = v.tx - w * 0.55;
    if (v.ty < pan.y + 20 || v.ty > pan.y + h - 20) y = v.ty - h / 2;
    const next = clampPan({ x, y }, L.width, contentH, w, h);
    if (next.x === pan.x && next.y === pan.y) return;
    pan = next;
    if (intro === null) flyTo(restCam(), 0.9);
  }

  // ---------- reconciliación ----------
  function setGraph(next: SceneGraph) {
    graph = { nodes: next.nodes.map((n) => ({ ...n, children: [...n.children] })), edges: next.edges.map((e) => ({ ...e })), now: next.now, activity: next.activity };
    byId.clear();
    for (const n of graph.nodes) byId.set(n.id, n);
    computeAlive();
    const ids = new Set(graph.nodes.map((n) => n.id));
    const live = intro === null && !introPending;
    const born: string[] = [];
    for (const n of graph.nodes) {
      let v = nodes.get(n.id);
      if (!v) {
        v = buildNode(n);
        nodes.set(n.id, v);
        if (live) born.push(n.id);
      } else if (v.dying >= 0) v.dying = -1;
      if (v.data.status !== n.status || v.data.loose !== n.loose || v.data.closedAs !== n.closedAs) v.flash = Math.max(v.flash, 0.6);
      v.data = n;
      v.tip.material.color.set(n.status === 'blocked' ? COL.blocked : COL.working);
      v.threadMat.color.set(n.status === 'blocked' ? COL.blocked : COL.working);
    }
    for (const v of nodes.values()) if (!ids.has(v.id) && v.dying < 0) v.dying = 1;

    const keys = new Set<string>();
    const pairs = new Set(graph.edges.filter((e) => e.kind === 'needs').map((e) => `${e.from}>${e.to}`));
    for (const e of graph.edges) {
      if (!ids.has(e.from) || !ids.has(e.to)) continue;
      const key = `${e.kind}:${e.from}>${e.to}`;
      keys.add(key);
      let ed = edges.get(key);
      if (!ed) {
        ed = buildEdge(e, key);
        edges.set(key, ed);
        if (live) ed.flashT = 0;
      } else if (ed.dying >= 0) ed.dying = -1;
      ed.twin = e.kind === 'origin' && (pairs.has(`${e.from}>${e.to}`) || pairs.has(`${e.to}>${e.from}`));
    }
    for (const ed of edges.values()) {
      if (!keys.has(ed.key) && ed.dying < 0) ed.dying = 1;
      styleEdge(ed);
    }

    const key = `${graph.nodes.map((n) => `${n.id}@${n.born}:${n.parent ?? ''}:${n.status}:${n.touched ?? ''}`).sort().join(',')}#${graph.now}`;
    if (key !== structureKey) {
      structureKey = key;
      if (vp.width > 1) relayout(live);
      else dirtyLayout = true;
      for (const ed of edges.values()) shapeEdge(ed);
    }
    for (const id of born) {
      const v = nodes.get(id)!;
      v.sc = 0;
      v.lit = true;
      v.shockT = 0;
      v.shock.material.color.set(PULSE_COL.born);
    }
    if (!graph.nodes.length) {
      introPending = true;
      intro = null;
      mode = 'intro';
    }
    // lo de ahora se ve: si algo nació fuera de la ventana y no estás mirando otra cosa, el plano lo sigue
    if (born.length && L && mode === 'overview' && !down) {
      const { w } = safeSize(vp, safe);
      if (L.nowX > pan.x + w - 60) {
        pan = clampPan({ x: L.width - w, y: pan.y }, L.width, contentH, w, safeSize(vp, safe).h);
        flyTo(restCam(), 1.2);
      }
    }
    dirtyLabels = true;
  }

  // ---------- teclado: una sola estrella en el orden de Tab; flechas para recorrer ----------
  function setRoving(id: string | null) {
    if (roving && nodes.get(roving)) nodes.get(roving)!.hit.tabIndex = -1;
    roving = id;
    if (id && nodes.get(id)) nodes.get(id)!.hit.tabIndex = 0;
  }

  function keyNav(ev: KeyboardEvent, id: string) {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      handlers.onPick(id);
      return;
    }
    const order = [...nodes.values()].filter((v) => v.dying < 0).sort((a, b) => a.tx - b.tx || a.ty - b.ty);
    const i = order.findIndex((v) => v.id === id);
    const me = order[i];
    if (!me) return;
    let to: NodeView | undefined;
    if (ev.key === 'ArrowRight') to = order[i + 1];
    else if (ev.key === 'ArrowLeft') to = order[i - 1];
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const dir = ev.key === 'ArrowDown' ? 1 : -1;
      to = order.filter((v) => (v.ty - me.ty) * dir > 1).sort((a, b) => Math.hypot(a.tx - me.tx, a.ty - me.ty) - Math.hypot(b.tx - me.tx, b.ty - me.ty))[0];
    } else if (ev.key === 'Home') to = order[0];
    else if (ev.key === 'End') to = order[order.length - 1];
    if (to) {
      ev.preventDefault();
      setRoving(to.id);
      to.hit.focus({ preventScroll: true });
    }
  }

  // ---------- puntero: arrastrar desplaza el plano, la rueda también; click en el vacío cierra ----------
  const onDown = (ev: PointerEvent) => {
    if (intro !== null) skipIntro();
    down = { x: ev.clientX, y: ev.clientY, px: pan.x, py: pan.y, moved: false };
    try {
      canvas.setPointerCapture(ev.pointerId);
    } catch {
      /* sin captura */
    }
  };
  const onMove = (ev: PointerEvent) => {
    if (FINE) {
      parallax.tx = (ev.clientX / Math.max(1, vp.width)) * 2 - 1;
      parallax.ty = (ev.clientY / Math.max(1, vp.height)) * 2 - 1;
    }
    if (!down || !L) return;
    const dx = ev.clientX - down.x, dy = ev.clientY - down.y;
    if (!down.moved && Math.abs(dx) + Math.abs(dy) > 4) {
      down.moved = true;
      canvas.style.cursor = 'grabbing';
    }
    if (!down.moved) return;
    const { w, h } = safeSize(vp, safe);
    // cerca de una tarea abierta, 1 px de arrastre mueve menos plano
    const s = mode === 'focus' ? cam.r / restDistance(vp) : 1;
    pan = clampPan({ x: down.px - dx * s, y: down.py - dy * s }, L.width, contentH, w, h);
    if (mode === 'focus') {
      cam.tx = (pan.x + w / 2) * K;
      cam.ty = -(pan.y + h / 2) * K;
    } else Object.assign(cam, restCam(), { theta: cam.theta, phi: cam.phi });
    tween = null;
  };
  const onUp = () => {
    canvas.style.cursor = '';
    if (down && !down.moved) {
      setGroupOpen(false);
      handlers.onPick(null);
    }
    down = null;
  };
  const onLeave = () => {
    parallax.tx = parallax.ty = 0;
  };
  const onWheel = (ev: WheelEvent) => {
    if (!L) return;
    ev.preventDefault();
    if (intro !== null) skipIntro();
    const { w, h } = safeSize(vp, safe);
    pan = clampPan({ x: pan.x + (ev.shiftKey ? ev.deltaY : ev.deltaX), y: pan.y + (ev.shiftKey ? 0 : ev.deltaY) }, L.width, contentH, w, h);
    if (mode !== 'focus') {
      tween = null;
      Object.assign(cam, restCam(), { theta: cam.theta, phi: cam.phi });
    }
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.style.touchAction = 'none';
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape' && intro !== null) skipIntro();
    else if (ev.key === 'Escape' && groupOpen) {
      setGroupOpen(false);
      moreBtn.focus({ preventScroll: true });
    }
  };
  win.addEventListener('keydown', onKey);

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => (dirtySize = true)) : null;
  ro?.observe(canvas);
  const onResize = () => (dirtySize = true);
  win.addEventListener('resize', onResize);
  void doc.fonts?.ready.then(() => (dirtyLabels = true));

  // ---------- relevos de luz ----------
  function relay(edge: EdgeView, onArrive?: () => void) {
    const r = relays.find((x) => !x.edge);
    if (!r) {
      onArrive?.();
      return;
    }
    r.edge = edge;
    r.t = 0;
    r.onArrive = onArrive;
    r.sprite.visible = true;
  }

  // ---------- la columna de la brújula (#109) ----------
  // En escritorio la brújula reserva su columna a la izquierda (`safe.left`): la vista general encuadra a su derecha,
  // pero el cielo se desplaza y lo viejo pasa por detrás. Ahí todo se apaga a un 10 % en una rampa de 90 px antes del
  // borde (estrellas, líneas, hilos y eje, de una vez, con una máscara del lienzo: no es una caja), y no hay etiquetas
  // ni blancos táctiles. En celular la brújula va arriba y no hay columna.
  const hasColumn = () => safe.left > 40;
  const underBrief = (x: number) => hasColumn() && x < safe.left - 8;
  function veilBrief() {
    const mask = hasColumn() ? `linear-gradient(90deg, rgba(0,0,0,.1) ${safe.left - 24}px, #000 ${safe.left + 66}px)` : '';
    canvas.style.maskImage = mask;
    canvas.style.setProperty('-webkit-mask-image', mask);
  }

  // ---------- loop ----------
  let last = performance.now();
  let elapsed = 0;
  let raf = 0;
  const shown = { ...cam };
  const proj = new Vector3();
  const toScreen = (x: number, y: number) => {
    proj.set(x * K, -y * K, 0).project(camera);
    return { x: (proj.x * 0.5 + 0.5) * vp.width, y: (-proj.y * 0.5 + 0.5) * vp.height, ok: proj.z < 1 };
  };

  function frame(now: number) {
    raf = win.requestAnimationFrame(frame);
    const raw = Math.max(0, (now - last) / 1000);
    const dt = Math.min(raw, 0.05);
    // la entrada sigue al reloj aunque el dispositivo dibuje pocos cuadros (#108): con dt tope 0,05 s, a 4 fps
    // los 5 s del travelling duraban más de 30
    const dtIntro = intro !== null ? Math.min(raw, 0.25) : dt;
    const slow = raw > 0.1;
    last = now;
    elapsed += dt;
    const tt = elapsed;

    if (dirtySize && measureViewport()) dirtyLayout = true;
    dirtySize = false;
    if (dirtyLayout) {
      relayout(false);
      if (mode === 'overview' && !tween) Object.assign(cam, restCam());
      if (mode === 'focus' && focusId && !tween) {
        const v = nodes.get(focusId);
        if (v) Object.assign(cam, focusCam(vp, safe, card, { x: v.tx, y: v.ty }, sideOf(v)));
      }
    }
    if (introPending && L && graph.nodes.length) {
      mark('dagyard:graph');
      startIntro();
    }

    // cámara
    if (intro !== null) {
      intro += dtIntro;
      clip = L ? growFront(intro, growX0, L.nowX, growDur, growDur === GROW_DUR_NEAR) : Infinity;
    }
    if (tween) {
      tween.t += dtIntro;
      lerpCam(tween.from, tween.to, tween.ease(Math.min(1, tween.t / tween.dur)), cam);
      if (tween.t >= tween.dur) {
        const end = tween.onEnd;
        tween = null;
        end?.();
      }
    }
    // órbita lenta en reposo (sin travelling ni vuelo en curso), más el paralaje del puntero
    restK += ((intro === null && !tween && !down && !REDUCED ? 1 : 0) - restK) * Math.min(1, dt * 0.8);
    parallax.x += (parallax.tx - parallax.x) * Math.min(1, dt * 2);
    parallax.y += (parallax.ty - parallax.y) * Math.min(1, dt * 2);
    const orbit = restOrbit(tt);
    const scale = mode === 'focus' ? 0.6 : 1;
    Object.assign(shown, cam);
    shown.theta += restK * scale * (orbit.theta + parallax.x * 0.022);
    shown.phi += restK * scale * (orbit.phi + parallax.y * 0.014);
    if (camera.fov !== FOV) {
      camera.fov = FOV;
      camera.updateProjectionMatrix();
    }
    placeCamera(camera, shown);
    camera.setViewOffset(vp.width, vp.height, shown.ox, shown.oy, vp.width, vp.height);
    fog.density = Math.min(0.006, 0.25 / Math.max(cam.r, 20));
    if (!REDUCED) backdrop.rotation.y += dt * 0.0016;
    // el cielo se mueve menos que el grafo: profundidad
    backdrop.position.set(cam.tx * 0.65, cam.ty * 0.65, 0);

    if (dirtyLabels) placeLabels();
    const rel = lit();
    const sel = focusId;

    // nodos
    let moved = false;
    const K_SPRING = 170, C_SPRING = 24;
    for (const v of [...nodes.values()]) {
      const n = v.data;
      if (v.dying >= 0) {
        v.dying = Math.max(0, v.dying - dt * 1.6);
        if (v.dying === 0) {
          disposeNode(v);
          nodes.delete(v.id);
          continue;
        }
      }
      for (const [p, vel, tg] of [['x', 'vx', 'tx'], ['y', 'vy', 'ty'], ['e', 've', 'te']] as const) {
        const d = v[tg] - v[p];
        if (Math.abs(d) < 0.05 && Math.abs(v[vel]) < 0.05) {
          v[p] = v[tg];
          v[vel] = 0;
          continue;
        }
        v[vel] += (K_SPRING * d - C_SPRING * v[vel]) * dt;
        v[p] += v[vel] * dt;
        moved = true;
      }
      // nacimiento: en la entrada, cuando el frente de crecimiento pasa por su x; en vivo, al llegar
      if (!v.lit && v.tx <= clip) {
        v.lit = true;
        if (intro !== null) v.flash = Math.max(v.flash, 0.5);
      }
      const target = v.lit && v.dying < 0 ? 1 : v.dying >= 0 ? v.dying : 0;
      // cuadros lentos: la estrella aparece entera en vez de crecer de a poco
      if (REDUCED || (slow && target === 1)) v.sc = target;
      const ds = target - v.sc;
      if (Math.abs(ds) > 0.002 || Math.abs(v.vsc) > 0.002) {
        v.vsc += (260 * ds - 22 * v.vsc) * dt;
        v.sc += v.vsc * dt;
      } else {
        v.sc = target;
        v.vsc = 0;
      }
      const s = Math.max(0, Math.min(1.08, v.sc));
      const vis = s > 0.01;
      v.group.position.set(v.x * K, -v.y * K, 0);
      v.group.visible = vis;

      v.color.lerp(tc.set(colorOf(n)), Math.min(1, dt * 3));
      const dimT = rel && !rel.has(n.id) && n.status !== 'blocked' ? (sel ? 0.16 : 0.4) : 1;
      v.dim += (dimT - v.dim) * Math.min(1, dt * 5);
      v.flash = Math.max(0, v.flash - dt * 1.2);
      v.spikeBoost = Math.max(0, v.spikeBoost - dt * 1.4);
      let size = 10, spike = 0.1, glowO = 0.7;
      const age = Math.min(1, Math.max(0, (graph.now - n.born) / AGE_SPAN));
      const fresh = alive.get(n.id) || age < 0.25;
      if (isEnded(n)) {
        size = 7;
        glowO = 0.3;
        spike = 0;
      } else if (n.loose) {
        size = 11;
        glowO = 0.55;
        spike = 0;
      } else if (n.kind === 'goal') {
        size = 20;
        spike = 0.7;
        glowO = 0.95;
      } else if (n.status === 'done') {
        const big = n.kind === 'request' || n.kind === 'stream';
        size = (big ? 17 : 12) * (fresh ? 1.12 : 1 - age * 0.3);
        spike = fresh ? (big ? 0.65 : 0.48) : big ? 0.32 : 0.16;
        glowO = fresh ? 0.95 : 0.62 - age * 0.2;
      } else if (n.status === 'working' && !n.tail) {
        // pedido u objetivo abierto, quieto: lo que late es solo el trabajo en curso (#109)
        size = 13;
        spike = 0.18;
        glowO = 0.55;
      } else if (n.status === 'working') {
        const b = REDUCED ? 0.5 : 0.5 + 0.5 * Math.sin(tt * 2.2 + v.seed);
        size = 14 + b * 5;
        spike = 0.2 + b * 0.12;
        glowO = 0.78 + b * 0.2;
      } else if (n.status === 'blocked') {
        size = 17;
        spike = 0.14;
        glowO = 1;
      } else {
        size = n.kind === 'request' ? 13 : 10;
        spike = 0.05;
        glowO = 0.5;
      }
      if (sel === n.id) size *= 1.15;
      size *= (1 + v.flash * 1.2) * s;
      const px = size * K;
      v.glow.material.color.copy(v.color);
      v.glow.material.opacity = glowO * v.dim;
      v.glow.scale.setScalar(Math.max(1e-4, px * 2.1));
      v.spike.material.color.copy(v.color);
      v.spike.material.opacity = Math.min(1, spike + v.spikeBoost * 0.6) * v.dim;
      v.spike.scale.setScalar(Math.max(1e-4, px * (3.6 + v.spikeBoost * 2)));
      // retícula ámbar en lo que te espera: un anillo con marcas que se abre y se apaga, una y otra vez
      if (n.status === 'blocked') {
        const k = REDUCED ? 0.35 : (tt * 0.7 + v.seed) % 1;
        v.ring.material.color.set(COL.blocked);
        v.ring.material.opacity = (1 - k) * 0.9 * v.dim * s;
        v.ring.scale.setScalar(Math.max(1e-4, px * (1.6 + k * 2.4)));
        v.ring.material.rotation = REDUCED ? 0 : tt * 0.25;
      } else if (n.kind === 'goal') {
        v.ring.material.color.set(COL.done);
        v.ring.material.opacity = 0.38 * v.dim * s;
        v.ring.scale.setScalar(Math.max(1e-4, px * 2.3));
        v.ring.material.rotation = REDUCED ? 0 : tt * 0.05;
      } else v.ring.material.opacity = 0;
      v.dash.material.opacity = (n.loose || isEnded(n) ? (n.loose ? 0.9 : 0.45) : 0) * v.dim * s;
      v.dash.material.color.set(n.loose ? 0xd9e1ec : COL.ended);
      v.dash.scale.setScalar(34 * K * s);
      const isSel = sel === n.id, isMark = markId === n.id;
      v.selr.material.color.set(isMark && !isSel ? COL.working : 0xffffff);
      v.selr.material.opacity = isSel || isMark ? 0.85 : 0;
      v.selr.scale.setScalar(44 * K);
      if (v.shockT >= 0) {
        v.shockT += dt;
        const k = Math.min(1, v.shockT / 1.4);
        v.shock.scale.setScalar((10 + easeInOut(k) * 100) * K);
        v.shock.material.opacity = (1 - k) * 0.85;
        if (k >= 1) {
          v.shockT = -1;
          v.shock.material.opacity = 0;
        }
      }
      // hilo de continuación: lo vivo se extiende hasta «ahora» y ahí se nombra
      const liveNode = named.has(n.id);
      const end = Math.min(v.e, clip);
      if (vis && liveNode && end > v.x + 4) {
        v.thread.visible = true;
        const g = v.thread.geometry;
        g.setFromPoints([tv.set((v.x + 8) * K, -v.y * K, 0).clone(), new Vector3(end * K, -v.y * K, 0)]);
        v.thread.computeLineDistances();
        v.threadMat.opacity = 0.4 * v.dim;
        v.tip.visible = true;
        v.tip.position.set(end * K, -v.y * K, 0);
        v.tip.scale.setScalar(12 * K);
        v.tip.material.opacity = 0.9 * v.dim;
      } else {
        v.thread.visible = false;
        v.tip.visible = false;
      }
    }

    // líneas
    for (const ed of [...edges.values()]) {
      const A = nodes.get(ed.from), B = nodes.get(ed.to);
      if (!A || !B) {
        disposeEdge(ed);
        edges.delete(ed.key);
        continue;
      }
      if (ed.dying >= 0) {
        ed.dying = Math.max(0, ed.dying - dt * 1.6);
        if (ed.dying === 0) {
          disposeEdge(ed);
          edges.delete(ed.key);
          continue;
        }
      }
      const vis = A.sc > 0.5 && B.sc > 0.5;
      if (vis && ed.draw < SEG + 1) ed.draw = Math.min(SEG + 1, ed.draw + dtIntro * (REDUCED ? 999 : 48));
      if (!vis && intro !== null) ed.draw = 0;
      if (moved) shapeEdge(ed);
      ed.geo.setDrawRange(0, Math.floor(ed.draw));
      ed.line.visible = vis || ed.dying >= 0;
      const on = rel ? rel.has(ed.from) && rel.has(ed.to) && (ed.from === (sel ?? hoverId) || ed.to === (sel ?? hoverId)) : true;
      let o = rel ? (on ? Math.min(1, ed.baseO * 1.8 + 0.15) : ed.baseO * (sel ? 0.12 : 0.35)) : ed.baseO;
      if (ed.flashT >= 0) {
        ed.flashT += dt;
        o = Math.max(o, 1 - ed.flashT / 4);
        if (ed.flashT > 4) ed.flashT = -1;
      }
      ed.solid.opacity = ed.dashed.opacity = o * (ed.dying >= 0 ? ed.dying : 1);
    }

    // partículas: el trabajo fluye hacia lo que está en curso o te espera
    const flowing = [...edges.values()].filter((ed) => ed.line.visible && ed.dying < 0 && ed.draw > SEG && ['working', 'blocked'].includes(byId.get(ed.to)?.status ?? ''));
    for (let k = 0; k < PCOUNT; k++) {
      // ~8 partículas por línea viva: un flujo, no una cadena de cuentas
      const ed = k < flowing.length * 8 ? flowing[k % Math.max(1, flowing.length)] : undefined;
      if (!ed || REDUCED) {
        pPos[k * 3 + 1] = 1e6;
        continue;
      }
      const u = (tt * (ed.kind === 'origin' ? 0.12 : 0.2) + k * 0.6180339) % 1;
      ed.curve.getPoint(u, tv);
      pPos[k * 3] = tv.x;
      pPos[k * 3 + 1] = tv.y;
      pPos[k * 3 + 2] = tv.z;
    }
    (pGeo.getAttribute('position') as BufferAttribute).needsUpdate = true;
    pMat.opacity = (sel ? 0.35 : 0.85) * (intro !== null ? Math.max(0, (intro - GROW_FADE) / 1.5) : 1);
    // con atenuación, el punto mide 3,2 px en la vista general y crece al acercarse
    pMat.size = (3.2 * K) / Math.tan(((FOV / 2) * Math.PI) / 180);

    // relevos
    for (const r of relays) {
      if (!r.edge) continue;
      r.t += dt / RELAY_DUR;
      if (r.t >= 1 || !edges.has(r.edge.key)) {
        r.sprite.visible = false;
        r.sprite.material.opacity = 0;
        const done = r.onArrive;
        r.edge = null;
        done?.();
        continue;
      }
      const k = easeInOut(r.t);
      r.edge.curve.getPoint(k, tv);
      r.sprite.position.copy(tv);
      r.sprite.material.color.set(0xffffff);
      r.sprite.material.opacity = Math.sin(Math.PI * r.t) * 0.95;
      r.sprite.scale.setScalar(18 * K);
    }

    // eje, «ahora» y etiquetas: proyección con la cámara real
    // en celular, con un grupo de la brújula desplegado, al cielo casi no le queda alto: sus rótulos se callan en vez de
    // caer sobre el pie (vuelven al plegarlo)
    const cramped = vp.height - safe.top - safe.bottom < 120;
    const axisO = cramped ? 0 : intro !== null ? Math.max(0, Math.min(1, (intro - 2.2) / 1.2)) : 1;
    moreBtn.style.pointerEvents = cramped ? 'none' : '';
    for (const a of axisLabels) {
      const q = toScreen(a.x, a.y);
      a.el.style.transform = `translate(${q.x.toFixed(1)}px, ${q.y.toFixed(1)}px) translateX(-50%)`;
      a.el.style.opacity = q.ok && !underBrief(q.x) ? String(axisO * (sel ? 0.4 : 1)) : '0';
    }
    if (L) {
      const q = toScreen(L.nowX, 4);
      nowEl.style.transform = `translate(${q.x.toFixed(1)}px, ${q.y.toFixed(1)}px) translateX(-50%)`;
      nowEl.style.opacity = q.ok ? String(axisO) : '0';
      // el grupo cuelga bajo «ahora»; la lista se abre hacia el lado de los nombres sin salirse de la pantalla
      moreBtn.style.transform = `translate(${q.x.toFixed(1)}px, ${(q.y + 20).toFixed(1)}px) translateX(-50%)`;
      moreBtn.style.opacity = q.ok ? String(axisO * (sel ? 0.4 : 1)) : '0';
      if (groupOpen) {
        const lw = moreList.offsetWidth || 260;
        const lx = Math.max(12, Math.min(q.x - 24, vp.width - lw - 12));
        moreList.style.transform = `translate(${lx.toFixed(1)}px, ${(q.y + 50).toFixed(1)}px)`;
      }
      nowMat.opacity = 0.32 * axisO;
      tickMat.opacity = 0.9 * axisO;
    }
    const top = safe.top - 6, bottom = vp.height - safe.bottom + 6;
    // cerca de una tarea las estrellas crecen: las etiquetas se apartan en proporción (y la elegida, fuera de su anillo)
    const zoom = Math.max(1, restDistance(vp) / Math.max(1e-3, cam.r));
    const ringPx = 22 * zoom;
    for (const v of nodes.values()) {
      const n = v.data;
      const vis = v.sc > 0.05 && v.dying < 0;
      const q = toScreen(v.x, v.y);
      const inView = q.ok && q.y > top && q.y < bottom && !underBrief(q.x) && q.x > -40 && q.x < vp.width + 40;
      let lx = q.x + v.lblDx + Math.sign(v.lblDx) * 11 * (zoom - 1), ly = q.y + v.lblDy - 14 * (zoom - 1);
      if (n.id === sel) {
        lx = q.x + ringPx + 8;
        ly = q.y - 8;
      }
      if (v.lblTip) {
        const qe = toScreen(Math.min(v.e, clip), v.y);
        lx = qe.x + 14;
        ly = qe.y - 8;
      }
      const want = v.lblOn && vis && inView ? (rel && !rel.has(n.id) ? 0.15 : 1) : 0;
      v.lblO += (want - v.lblO) * Math.min(1, dt * 6);
      v.lbl.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px)`;
      v.lbl.style.opacity = v.lblO < 0.01 ? '0' : v.lblO.toFixed(3);
      v.hit.style.transform = `translate(${q.x.toFixed(1)}px, ${q.y.toFixed(1)}px)`;
      v.hit.style.display = vis && inView ? 'block' : 'none';
    }
    if (!roving && graph.nodes.length) {
      const w = graph.nodes.find((n) => n.status === 'blocked') ?? graph.nodes.reduce((a, b) => (b.born > a.born ? b : a));
      setRoving(w.id);
    }

    composer.render();
    // #108: marcas para medir en un teléfono el tiempo del primer cuadro a la primera estrella a la vista
    if (!firstFrame) {
      firstFrame = true;
      mark('dagyard:sky');
    }
    if (!firstStar && graph.nodes.length) {
      for (const v of nodes.values()) {
        if (v.sc < 0.3 || v.dying >= 0) continue;
        const q = toScreen(v.x, v.y);
        if (q.ok && q.x > 0 && q.x < vp.width && q.y > top && q.y < bottom) {
          firstStar = true;
          mark('dagyard:first-star');
          break;
        }
      }
    }
  }
  raf = win.requestAnimationFrame(frame);

  // ---------- API ----------
  return {
    setGraph,
    pulse(nodeId, kind) {
      const v = nodes.get(nodeId);
      if (!v) return;
      if (kind === 'message') {
        v.spikeBoost = 1;
        v.flash = Math.max(v.flash, 0.35);
      } else v.flash = 1;
      if (REDUCED) return;
      const fire = () => {
        v.shock.material.color.set(PULSE_COL[kind]);
        v.shockT = kind === 'message' ? 0.55 : 0;
      };
      if (kind === 'done' || kind === 'working') {
        const legs = relayLegs(graph.edges, nodeId, kind, (id) => byId.get(id)?.status);
        const list = legs.map((l) => edges.get(`needs:${l.from}>${l.to}`)).filter((e): e is EdgeView => !!e).slice(0, 8);
        if (kind === 'done') {
          fire();
          for (const ed of list) relay(ed, () => {
            const to = nodes.get(ed.to);
            if (to) to.flash = Math.max(to.flash, 0.6);
          });
        } else if (list.length) {
          // la luz llega desde lo que ya estaba listo y recién entonces se enciende
          let fired = false;
          for (const ed of list) relay(ed, () => {
            if (!fired) (fired = true), fire();
          });
        } else fire();
      } else fire();
    },
    overview() {
      focusId = null;
      dirtyLabels = true;
      if (panBeforeFocus) pan = panBeforeFocus;
      panBeforeFocus = null;
      if (L) {
        const { w, h } = safeSize(vp, safe);
        pan = clampPan(pan, L.width, contentH, w, h);
      }
      if (intro !== null) return;
      setMode('overview', false);
      flyTo(restCam(), FLY_DUR);
    },
    focus(id) {
      const v = nodes.get(id);
      if (!v) return;
      if (!focusId) panBeforeFocus = { ...pan };
      focusId = id;
      setRoving(id);
      dirtyLabels = true;
      if (intro !== null) return; // el travelling termina en la tarea
      setMode('focus', false);
      flyTo(focusCam(vp, safe, card, { x: v.tx, y: v.ty }, sideOf(v)), FLY_DUR);
    },
    mark(id) {
      markId = id;
      if (id) reveal(id);
      dirtyLabels = true;
    },
    replay() {
      if (!graph.nodes.length) return;
      focusId = null;
      panBeforeFocus = null;
      dirtyLabels = true;
      startIntro();
    },
    setSafeArea(area) {
      if (area.top === safe.top && area.right === safe.right && area.bottom === safe.bottom && area.left === safe.left) return;
      safe = { ...area };
      veilBrief();
      dirtyLayout = true;
    },
    setCardArea(area) {
      if (area.right === card.right && area.bottom === card.bottom) return;
      card = { ...area };
      if (focusId && mode === 'focus' && intro === null) {
        const v = nodes.get(focusId);
        if (v) flyTo(focusCam(vp, safe, card, { x: v.tx, y: v.ty }, sideOf(v)), 0.6);
      }
    },
    dispose() {
      win.cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      win.removeEventListener('keydown', onKey);
      win.removeEventListener('resize', onResize);
      ro?.disconnect();
      for (const v of nodes.values()) disposeNode(v);
      for (const e of edges.values()) disposeEdge(e);
      nodes.clear();
      edges.clear();
      clearAxis();
      for (const r of relays) r.sprite.material.dispose();
      backdrop.traverse((o) => {
        const m = o as unknown as { geometry?: BufferGeometry; material?: { dispose(): void } };
        m.geometry?.dispose();
        m.material?.dispose();
      });
      nowLine.geometry.dispose();
      nowMat.dispose();
      tickMat.dispose();
      foldMat.dispose();
      pGeo.dispose();
      pMat.dispose();
      T.dispose();
      dashTex.dispose();
      composer.dispose();
      renderer.dispose();
      root.remove();
      removeStyles();
    },
  };
}

/** Anillo punteado de un cabo suelto (o de algo que se cerró sin terminar). */
function makeDashRing() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  if (g) {
    g.strokeStyle = '#fff';
    g.lineWidth = 256 * 0.03;
    g.setLineDash([256 * 0.07, 256 * 0.06]);
    g.beginPath();
    g.arc(128, 128, 256 * 0.4, 0, Math.PI * 2);
    g.stroke();
  }
  return new CanvasTexture(c);
}


function mark(name: string) {
  try {
    performance.mark(name);
  } catch {
    /* sin User Timing */
  }
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
