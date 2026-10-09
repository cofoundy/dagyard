// La ficha de una tarea en el DAG (#75): lo que te pide (decisión, revisión o acceso), para qué existe, por qué existe
// (la cita de quien la pidió y de qué nació, con su porqué), cómo se cerró, qué necesita, qué nació de ella, cómo
// llegamos aquí, quién la lleva, lo que te escribieron y los enlaces. A la derecha en escritorio, hoja inferior en móvil.

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { buildDag, chain, goalOf, type DagModel, type DagTask } from '../data/dag';
import type { Blocker, CloseAs, DagNode, Resolution, Snapshot } from '../data/types';
import { messagesOf, openBlockerOf, resolvedBlockersOf } from '../data/view';
import { isResolvedByYou, RESOLVED_BY_AGENT } from '../data/adapter';
import { t, useLang } from '../i18n';
import { endOf, needsInOrder, stateKey } from '../data/orient';
import {
  ago,
  answeredBy,
  ANSWER_VERB,
  askedBy,
  BLOCK_TEXT,
  bornLine,
  builtBy,
  chainMore,
  clock,
  CLOSE_TEXT,
  COPY,
  KIND_TEXT,
  reportLabel,
  reviewLabels,
  STATUS_CLASS,
  teamName,
} from './copy';

export interface CardProps {
  snapshot: Snapshot;
  /** En curso sin noticias hace más de un día (lo calcula la brújula): el chip lo dice igual que ella. */
  quiet?: boolean;
  node: DagNode | undefined;
  /** El DAG ya calculado (si no viene, se calcula del snapshot). */
  model?: DagModel;
  /** Sin conexión: no se puede responder y se dice por qué. */
  offline?: boolean;
  onClose: () => void;
  onFocus: (nodeId: string) => void;
  onResolve: (blocker: Blocker, resolution: Resolution) => Promise<void>;
  /** «Enlazarlo» (#90): la tarea suelta nació de esta meta. */
  onLink?: (from: string, to: string) => Promise<void>;
  /** «Dejarla ir» (#90): se cierra como descartada y queda en la historia. */
  onDrop?: (nodeId: string, why: string) => Promise<void>;
}

/** Lo que se hace con una tarea suelta: atarla a una meta o dejarla ir. El cambio vuelve por el tiempo real. */
function LooseActions({ task, goals, offline, onLink, onDrop }: { task: DagTask; goals: DagTask[]; offline?: boolean; onLink?: CardProps['onLink']; onDrop?: CardProps['onDrop'] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [task.id]);
  if (!onLink && !onDrop) return null;
  const run = (p: Promise<void>) => {
    setBusy(true);
    setError(null);
    p.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
  };
  const locked = busy || !!offline;
  return (
    <div className="loose-actions">
      {onLink && goals.length > 0 && (
        <div className="kids">
          <span className="fine">{COPY.linkTo} </span>
          {goals.map((g) => (
            <button key={g.id} type="button" disabled={locked} title={g.title} onClick={() => run(onLink(g.id, task.id))}>
              <span>{g.title}</span>
            </button>
          ))}
        </div>
      )}
      {onDrop && (
        <button type="button" className="ghost" disabled={locked} onClick={() => run(onDrop(task.id, COPY.letGoWhy))}>
          {busy ? COPY.loosePending : COPY.letGo}
        </button>
      )}
      {error && <p className="err" role="alert">{error}</p>}
    </div>
  );
}

export function Card(props: CardProps) {
  useLang();
  const { node } = props;
  // La ficha conserva la última tarea mientras se desvanece al cerrarse.
  const [shown, setShown] = useState<DagNode | undefined>(node);
  useEffect(() => {
    if (node) setShown(node);
  }, [node]);
  const n = node ?? shown;
  const open = !!node;
  const fresh = n ? props.snapshot.nodes.find((x) => x.id === n.id) : undefined;

  // #116: al abrirse, el foco entra en la ficha (a su título), así quien va con teclado o lector de pantalla se entera;
  // al cerrarse vuelve a lo que la abrió (la fila de la brújula, la estrella). Si entretanto el PM se fue a otra parte,
  // no se le roba el foco.
  const ref = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const openId = node?.id;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const doc = el.ownerDocument;
    const active = doc.activeElement instanceof HTMLElement && doc.activeElement !== doc.body ? doc.activeElement : null;
    if (openId) {
      // una tarea abierta desde la propia ficha (sus chips) conserva el origen de la primera, y se lee desde arriba
      if (active && !el.contains(active)) opener.current = active;
      el.scrollTop = 0;
      el.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
      return;
    }
    const back = opener.current;
    opener.current = null;
    if (back?.isConnected && (!active || el.contains(active))) back.focus({ preventScroll: true });
  }, [openId]);

  return (
    <aside ref={ref} className={`card${open ? ' open' : ''}`} aria-live="polite" aria-hidden={!open} inert={!open}>
      {n && fresh && <CardBody {...props} node={fresh} />}
    </aside>
  );
}

/**
 * Una tarea como botón con su punto de estado: lleva a su ficha (y la cámara vuela a ella). `end`: una necesidad que
 * ya no frena (#115) va tenue, con ✓ si se terminó y – si se dejó de lado, y el lector de pantalla dice cuál.
 */
function Chip({ t: task, onFocus, end }: { t: DagTask; onFocus: (id: string) => void; end?: CloseAs | null }) {
  return (
    <button type="button" className={end ? 'met' : undefined} title={task.title} onClick={() => onFocus(task.id)}>
      {end ? <b aria-hidden="true">{end === 'done' ? '✓' : '–'}</b> : <i className={STATUS_CLASS[task.status]} aria-hidden="true" />}
      <span>{task.title}</span>
      {end && <span className="sr"> · {CLOSE_TEXT[end]}</span>}
    </button>
  );
}

function Sec({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <div className="sec">{title}</div>
      {children}
    </section>
  );
}

function CardBody({ snapshot, node, quiet, model: given, offline, onClose, onFocus, onResolve, onLink, onDrop }: CardProps & { node: DagNode }) {
  const model = useMemo(() => given ?? buildDag(snapshot), [given, snapshot]);
  const [chainOpen, setChainOpen] = useState(false);
  useEffect(() => setChainOpen(false), [node.id]);
  const task = model.byId.get(node.id);
  if (!task) return null;
  const get = (id: string) => model.byId.get(id);
  const list = (ids: readonly string[]) => ids.map(get).filter((x): x is DagTask => !!x);

  const blocker = openBlockerOf(snapshot, node.id);
  const answers = resolvedBlockersOf(snapshot, node.id);
  const messages = messagesOf(snapshot, node.id).slice(0, 3);
  const team = teamName(node.team);
  const cls = STATUS_CLASS[node.status];
  const state = stateKey({ status: node.status, kind: task.kind }, quiet);
  const neededBy = list(task.neededBy);
  const needs = needsInOrder(model, task);
  const children = list(task.children);
  const goal = task.kind === 'goal' ? undefined : goalOf(model, task.id);
  const anc = chain(model, task.id).slice(0, -1);
  const showAnc = chainOpen || anc.length <= 4 ? anc : anc.slice(-3);
  const hidden = anc.length - showAnc.length;
  const ended = task.closedAs && task.closedAs !== 'done';
  const replacedBy = task.replacedBy ? get(task.replacedBy) : undefined;
  const kindLabel = task.kind === 'goal' || task.kind === 'request' || task.kind === 'stream' ? KIND_TEXT[task.kind] : null;

  // para qué existe: la meta, lo que la necesita y hacia qué meta va; si no lleva a ninguna, se dice
  let purpose: ReactNode;
  if (task.kind === 'goal') purpose = <p>{COPY.forGoal}</p>;
  else if (neededBy.length || goal)
    purpose = (
      <>
        {neededBy.length > 0 && (
          <div className="kids">
            {neededBy.map((t) => (
              <Chip key={t.id} t={t} onFocus={onFocus} />
            ))}
          </div>
        )}
        {goal && (
          <p className="toward">
            <span className="fine">{COPY.toward} </span>
            <button type="button" className="ref" onClick={() => onFocus(goal.id)}>
              {goal.title}
            </button>
          </p>
        )}
      </>
    );
  else if (task.loose)
    purpose = (
      <>
        <p className="loose-why">{model.hasGoals ? COPY.forLoose : COPY.forLooseLegacy}</p>
        {!task.closedAs && (
          <LooseActions
            task={task}
            goals={model.hasGoals ? model.tasks.filter((t) => t.kind === 'goal' && !t.closedAs) : []}
            offline={offline}
            onLink={onLink}
            onDrop={onDrop}
          />
        )}
      </>
    );
  else purpose = <p className="fine">{task.closedAs ? COPY.forClosed : COPY.forUnset}</p>;

  // por qué existe: la cita de quien la pidió y de qué nació (con el porqué que dejaron)
  const origins = task.origins.map((o) => ({ ...o, t: get(o.from) })).filter((o) => o.t);
  let why: ReactNode;
  if (!origins.length && !task.quote) why = <p className="fine">{task.kind === 'goal' ? COPY.root : COPY.noOrigin}</p>;
  else
    why = (
      <>
        {task.quote && (
          <>
            <p className="asked">{askedBy(task.quoteBy)}</p>
            <blockquote className="quote">«{task.quote}»</blockquote>
          </>
        )}
        {origins.length > 0 && (
          <ul className="origins">
            {origins.map((o) => (
              <li key={o.from}>
                <span className="lab">{COPY.bornFrom}</span>
                <button type="button" className="ref" onClick={() => onFocus(o.from)}>
                  {o.t!.title}
                </button>
                {o.why && <p className="because">{o.why}</p>}
                {o.derived && <p className="fine">{COPY.inferred}</p>}
              </li>
            ))}
          </ul>
        )}
      </>
    );

  return (
    <>
      <div className="top">
        {/* una rama que murió (descartada, reemplazada, «aprendimos») nunca se ve como lista (#102) */}
        {/* la palabra de la brújula (#109): «Sin noticias» si está quieta; un pedido o una meta abiertos los nombra su tipo */}
        {(ended || state.startsWith('status.')) && (
          <span className={`chip ${ended ? 'ended' : cls}${quiet ? ' quiet' : ''}`}>{ended ? CLOSE_TEXT[task.closedAs!] : t(state)}</span>
        )}
        {kindLabel && <span className="chip kind">{kindLabel}</span>}
        <span className="born">{bornLine(task.born, model.now)}</span>
        <button className="x" type="button" aria-label={COPY.close} onClick={onClose}>
          ×
        </button>
      </div>
      <h2 tabIndex={-1}>{node.title}</h2>

      {blocker && <BlockerPanel key={blocker.id} blocker={blocker} offline={offline} onResolve={onResolve} />}

      {ended && (
        <Sec title={COPY.closedSec} className="closed">
          <p>
            <b>{CLOSE_TEXT[task.closedAs!]}</b>
            {task.closedReason ? ` · ${task.closedReason}` : ''}
          </p>
          {replacedBy && (
            <p className="toward">
              <span className="fine">{COPY.replacedBy} </span>
              <button type="button" className="ref" onClick={() => onFocus(replacedBy.id)}>
                {replacedBy.title}
              </button>
            </p>
          )}
        </Sec>
      )}

      <Sec title={COPY.forSec} className="purpose">
        {purpose}
      </Sec>

      <Sec title={COPY.whySec} className={`why${task.quote ? ' k-asked' : ''}`}>
        {why}
      </Sec>

      {task.closedAs === 'done' && task.closedReason && (
        <Sec title={COPY.closedSec} className="closed">
          <p>
            <b>{CLOSE_TEXT.done}</b> · {task.closedReason}
          </p>
        </Sec>
      )}

      {/* primero lo que todavía la frena (el primero es el «después de …» de la brújula); lo cerrado, tenue y con ✓ */}
      {needs.open.length + needs.done.length > 0 && (
        <Sec title={COPY.needs} className="needs">
          <div className="kids">
            {needs.open.map((t) => (
              <Chip key={t.id} t={t} onFocus={onFocus} />
            ))}
            {needs.done.map((t) => (
              <Chip key={t.id} t={t} onFocus={onFocus} end={endOf(model, t.id) ?? 'done'} />
            ))}
          </div>
        </Sec>
      )}

      {children.length > 0 && (
        <Sec title={COPY.bornHere}>
          <div className="kids">
            {children.map((t) => (
              <Chip key={t.id} t={t} onFocus={onFocus} />
            ))}
          </div>
        </Sec>
      )}

      {anc.length > 0 && (
        <Sec title={COPY.chain}>
          <ol className="chain">
            {hidden > 0 && (
              <li>
                <span />
                <button type="button" className="more" onClick={() => setChainOpen(true)}>
                  {chainMore(hidden)}
                </button>
                <time />
              </li>
            )}
            {showAnc.map((a) => (
              <li key={a.id}>
                <i className={STATUS_CLASS[a.status]} aria-hidden="true" />
                <button type="button" onClick={() => onFocus(a.id)}>
                  {a.title}
                </button>
                <time>{clock(a.born, model.now)}</time>
              </li>
            ))}
            <li className="me">
              <i className={cls} aria-hidden="true" />
              <button type="button" aria-current="true">
                {node.title}
              </button>
              <time>{clock(task.born, model.now)}</time>
            </li>
          </ol>
        </Sec>
      )}

      {team && <p className="team">{builtBy(team)}</p>}

      {messages.length > 0 && (
        <div className="msgs">
          {messages.map((m) => (
            <div className="msg" key={m.id}>
              <span className="who">
                {m.from}
                {m.at ? ` · ${ago(m.at)}` : ''}
              </span>
              <p>{m.text}</p>
              {m.reportUrl && (
                <a className="inline-report" href={m.reportUrl} target="_blank" rel="noopener noreferrer">
                  {reportLabel(m.reportUrl)} ↗
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {answers.length > 0 && (
        <>
          <div className="sec">{COPY.yourAnswers}</div>
          {answers.map((b) => (
            <Answer key={b.id} blocker={b} />
          ))}
        </>
      )}

      {node.reportUrl && (
        <a className="report" href={node.reportUrl} target="_blank" rel="noopener noreferrer">
          <span>{reportLabel(node.reportUrl)}</span>
          <span>{COPY.open} ↗</span>
        </a>
      )}
      {node.link && (
        <a className="report" href={node.link} target="_blank" rel="noopener noreferrer">
          <span>{COPY.technical}</span>
          <span>{COPY.open} ↗</span>
        </a>
      )}
    </>
  );
}

function Answer({ blocker }: { blocker: Blocker }) {
  const by = blocker.resolvedBy;
  // `resolvedBy` es un centinela (tú, un agente) o un nombre que se muestra tal cual.
  const who = !by || isResolvedByYou(by) ? null : by === RESOLVED_BY_AGENT ? COPY.agent : by;
  return (
    <div className="answer">
      <span className="lab">
        {who ? answeredBy(who) : ANSWER_VERB[blocker.kind]}
        {blocker.resolvedAt ? ` · ${ago(blocker.resolvedAt)}` : ''}
      </span>
      <p className="q">{blocker.kind === 'access' && blocker.label ? blocker.label : blocker.question}</p>
      {/* En un acceso, el verbo ya lo dice todo: el valor nunca se muestra. */}
      {blocker.resolution && blocker.kind !== 'access' && <p className="a">{blocker.resolution}</p>}
    </div>
  );
}

type Phase = { k: 'idle' } | { k: 'sending'; what: string } | { k: 'error'; text: string };

function BlockerPanel({ blocker, offline, onResolve }: { blocker: Blocker; offline?: boolean; onResolve: CardProps['onResolve'] }) {
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [changes, setChanges] = useState(false);
  const [comment, setComment] = useState('');
  const [value, setValue] = useState('');
  const [missing, setMissing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const sending = phase.k === 'sending';
  // sin conexión no se puede responder: los botones quedan quietos y se dice por qué
  const locked = sending || !!offline;

  useEffect(() => {
    if (changes) areaRef.current?.focus();
  }, [changes]);

  async function send(r: Resolution, what: string) {
    setPhase({ k: 'sending', what });
    try {
      await onResolve(blocker, r);
      // Si la ficha sigue montada (otro pedido abierto), vuelve a quedar lista.
      setPhase({ k: 'idle' });
    } catch (e) {
      setPhase({ k: 'error', text: e instanceof Error && e.message ? e.message : COPY.sendError });
    }
  }

  function submitAccess(ev: FormEvent) {
    ev.preventDefault();
    if (!value.trim()) {
      setMissing(true);
      inputRef.current?.focus();
      return;
    }
    void send({ kind: 'access', value: value.trim() }, 'access');
  }

  function submitChanges(ev: FormEvent) {
    ev.preventDefault();
    void send({ kind: 'review', verdict: 'changes', comment: comment.trim() || undefined }, 'changes');
  }

  const [approveLabel, changesLabel] = reviewLabels(blocker.options);
  const fieldId = `acc-${blocker.id}`;
  const areaId = `chg-${blocker.id}`;

  return (
    <div className="block">
      <label className="kind">{BLOCK_TEXT[blocker.kind]}</label>
      <p>{blocker.question}</p>

      {blocker.kind === 'decision' && (
        <div className="opts">
          {blocker.options.map((o, i) => (
            <button
              key={o}
              type="button"
              className={`go${i ? ' ghost' : ''}`}
              disabled={locked}
              onClick={() => void send({ kind: 'decision', option: o }, o)}
            >
              {sending && phase.what === o ? COPY.sending : o}
            </button>
          ))}
        </div>
      )}

      {blocker.kind === 'review' &&
        (!changes ? (
          <div className="opts">
            <button type="button" className="go" disabled={locked} onClick={() => void send({ kind: 'review', verdict: 'approve' }, 'approve')}>
              {sending && phase.what === 'approve' ? COPY.sending : approveLabel}
            </button>
            <button type="button" className="go ghost" disabled={locked} onClick={() => setChanges(true)}>
              {changesLabel}
            </button>
          </div>
        ) : (
          <form className="opts" onSubmit={submitChanges}>
            <label htmlFor={areaId}>{COPY.changesLabel}</label>
            <textarea
              id={areaId}
              ref={areaRef}
              rows={3}
              maxLength={1000}
              value={comment}
              placeholder={COPY.changesPlaceholder}
              onChange={(e) => setComment(e.target.value)}
            />
            <button type="submit" className="go" disabled={locked}>
              {sending ? COPY.sending : COPY.sendChanges}
            </button>
            <button type="button" className="go ghost" disabled={locked} onClick={() => setChanges(false)}>
              {COPY.cancel}
            </button>
          </form>
        ))}

      {blocker.kind === 'access' && (
        <form className="opts" onSubmit={submitAccess}>
          <label htmlFor={fieldId}>{blocker.label ?? COPY.access}</label>
          <input
            id={fieldId}
            ref={inputRef}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            placeholder={missing ? COPY.accessMissing : COPY.accessPlaceholder}
            aria-invalid={missing || undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setMissing(false);
            }}
          />
          <button type="submit" className="go" disabled={locked}>
            {sending ? COPY.sending : COPY.unlock}
          </button>
          <p className="fine">{COPY.accessFine}</p>
        </form>
      )}

      {offline && <p className="fine">{COPY.offline}</p>}

      {phase.k === 'error' && (
        <p className="err" role="alert">
          {phase.text}
        </p>
      )}
    </div>
  );
}
