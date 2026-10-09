// Qué se ve cuando llega un evento del servidor: un pulso en la escena y, si vale la pena, un aviso.

import type { Pulse } from '../scene/contract';
import type { DagEvent, Snapshot } from '../data/types';
import { BLOCK_TOAST, COPY, teamName, truncate } from './copy';

export type ToastKind = 'done' | 'work' | 'amber';

export interface ToastSpec {
  kind: ToastKind;
  /** En negrita: la tarea o quién escribe. */
  title: string;
  text: string;
  /** Click en el aviso → foco en esta tarea. */
  nodeId?: string;
}

export interface Feedback {
  pulse?: { nodeId: string; kind: Pulse };
  toast?: ToastSpec;
}

export function feedbackFor(prev: Snapshot, next: Snapshot, e: DagEvent): Feedback {
  switch (e.type) {
    case 'node.added': {
      const n = next.nodes.find((x) => x.id === e.node.id);
      if (!n) return {};
      return { pulse: { nodeId: n.id, kind: 'born' }, toast: { kind: 'work', title: n.title, text: COPY.added, nodeId: n.id } };
    }
    case 'node.updated': {
      const before = prev.nodes.find((x) => x.id === e.node.id);
      const after = next.nodes.find((x) => x.id === e.node.id);
      if (!after || !before || before.status === after.status) return {};
      if (after.status === 'done')
        return { pulse: { nodeId: after.id, kind: 'done' }, toast: { kind: 'done', title: after.title, text: COPY.isDone, nodeId: after.id } };
      if (after.status === 'working') {
        // Salir de «te espera» ya lo cuenta el aviso de la respuesta; solo se pulsa.
        if (before.status === 'blocked') return { pulse: { nodeId: after.id, kind: 'working' } };
        const team = teamName(after.team);
        return {
          pulse: { nodeId: after.id, kind: 'working' },
          toast: { kind: 'work', title: after.title, text: team ? `${COPY.started} · ${team}` : COPY.started, nodeId: after.id },
        };
      }
      return {};
    }
    case 'node.removed': {
      const n = prev.nodes.find((x) => x.id === e.nodeId);
      return n ? { toast: { kind: 'work', title: n.title, text: COPY.removed } } : {};
    }
    case 'blocker.opened': {
      const n = next.nodes.find((x) => x.id === e.blocker.nodeId);
      if (!n) return {};
      return {
        pulse: { nodeId: n.id, kind: 'blocked' },
        toast: { kind: 'amber', title: n.title, text: BLOCK_TOAST[e.blocker.kind], nodeId: n.id },
      };
    }
    case 'blocker.resolved': {
      const before = prev.blockers.find((b) => b.id === e.blocker.id);
      // Si ya estaba resuelto aquí, fuiste tú desde esta pantalla y ya lo avisamos.
      if (before?.resolvedAt) return {};
      const n = next.nodes.find((x) => x.id === e.blocker.nodeId);
      if (!n) return {};
      return { pulse: { nodeId: n.id, kind: 'working' }, toast: resolvedToast(n.title, e.blocker.resolution, n.id) };
    }
    case 'message.posted': {
      const n = next.nodes.find((x) => x.id === e.message.nodeId);
      // la estrella destella (una transmisión, menor que un cambio de estado)
      return {
        ...(n ? { pulse: { nodeId: n.id, kind: 'message' as const } } : {}),
        toast: { kind: 'work', title: e.message.from, text: truncate(e.message.text, 96), nodeId: n?.id },
      };
    }
    default:
      return {};
  }
}

export function resolvedToast(title: string, resolution: string | undefined, nodeId?: string): ToastSpec {
  return { kind: 'work', title, text: `${resolution ? `${resolution} · ` : ''}${COPY.teamContinues}`, nodeId };
}
