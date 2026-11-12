#!/usr/bin/env python3
"""brain-avisos.py — cada pregunta nueva de Dagyard le llega al dueño al teléfono; al responderse, se cierra sola.

Integración de Cofoundy (no la necesita quien instala Dagyard por su cuenta): escucha `dagyard watch --json` de un
proyecto y avisa por los dos canales que el dueño mira:

    blocker.opened   → DM de Buzz al dueño (la app móvil lo notifica; una vez por pregunta)
                       + brain.py tarea add --clave dagyard:<id> (Vikunja → la barra de myturn en el Mac)
    blocker.resolved → brain.py tarea cerrar --clave dagyard:<id>

brain sola no basta: myturn trae Vikunja a la barra del Mac, no al celular (`~/dotfiles/docs/myturn.md`).

Corre para siempre: si `watch` sale (el servidor dejó de responder, la red), espera y vuelve desde su cursor, así
no se pierde ni se repite nada. Stdlib only.

    brain-avisos.py --project el-deily [--para andre] [--once]

La instalación como servicio de usuario (systemd) está en `integrations/README.md`.
"""

import argparse
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

LIMA = dt.timezone(dt.timedelta(hours=-5))
RETRY_S = 30
TITLE_MAX = 120


def brain_script() -> str:
    """El brain.py más nuevo del cache de plugins; `$BRAIN_PY` lo fija a mano."""
    if os.environ.get("BRAIN_PY"):
        return os.environ["BRAIN_PY"]
    cache = Path.home() / ".claude/plugins/cache/cofoundy/cofoundy-toolkit"
    found = sorted(cache.glob("*/skills/brain/scripts/brain.py"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not found:
        sys.exit("brain-avisos: no encuentro brain.py (fija $BRAIN_PY)")
    return str(found[0])


def lima(iso: str | None = None) -> dt.datetime:
    t = dt.datetime.fromisoformat(iso.replace("Z", "+00:00")) if iso else dt.datetime.now(dt.timezone.utc)
    return t.astimezone(LIMA)


def sky_url(project: str, node: str) -> str:
    base = os.environ.get("DAGYARD_URL") or _read(Path.home() / ".config/dagyard/url") or "https://dagyard.cofoundy-dev.workers.dev"
    return f"{base.rstrip('/')}/?p={project}&n={node}"


def _read(p: Path) -> str | None:
    try:
        return p.read_text().strip() or None
    except OSError:
        return None


def buzz_script() -> str | None:
    if os.environ.get("BUZZ_CLI"):
        return os.environ["BUZZ_CLI"]
    cache = Path.home() / ".claude/plugins/cache/cofoundy/cofoundy-toolkit"
    found = sorted(cache.glob("*/skills/buzz/scripts/buzz_cli.py"), key=lambda p: p.stat().st_mtime, reverse=True)
    return str(found[0]) if found else None


def buzz_dm(para: str, text: str) -> int:
    script = buzz_script()
    uv = shutil.which("uv")
    if not script or not uv:
        print("brain-avisos: sin buzz_cli.py o sin uv; el aviso al teléfono no salió", flush=True)
        return 1
    r = subprocess.run([uv, "run", "--quiet", script, "dm", "--to", para, "-m", text], capture_output=True, text=True)
    out = (r.stdout + r.stderr).strip().splitlines()
    print(f"buzz dm → exit {r.returncode}: {out[-1] if out else ''}", flush=True)
    return r.returncode


class Sent:
    """Las preguntas ya avisadas por Buzz (un DM no es idempotente; la tarea de brain sí, por su clave)."""

    def __init__(self, path: Path):
        self.path = path
        self.ids = set(path.read_text().split()) if path.exists() else set()

    def __contains__(self, bid: str) -> bool:
        return bid in self.ids

    def add(self, bid: str) -> None:
        self.ids.add(bid)
        with self.path.open("a") as f:
            f.write(bid + "\n")


def brain(*args: str) -> int:
    r = subprocess.run([sys.executable, brain_script(), *args], capture_output=True, text=True)
    out = (r.stdout + r.stderr).strip().splitlines()
    print(f"brain {' '.join(args[:2])} → exit {r.returncode}: {out[-1] if out else ''}", flush=True)
    return r.returncode


def opened(line: dict, project: str, para: str, sent: "Sent") -> int:
    q = " ".join(line["question"].split())
    title = f"Dagyard · {project}: {q}"
    if len(title) > TITLE_MAX:
        title = title[: TITLE_MAX - 1] + "…"
    now = lima()
    detail = [f"Responde aquí: {sky_url(project, line['node'])}"]
    if line.get("options"):
        detail.append("Opciones: " + " · ".join(line["options"]))
    caduca = now + dt.timedelta(days=3)
    if line.get("dueAt") and line.get("defaultChoice"):
        due = lima(line["dueAt"])
        detail.append(f"Si no respondes antes del {due:%d/%m %H:%M} (Lima), rige «{line['defaultChoice']}».")
        # pasado el plazo ya no hay nada que responder: la tarea no debe seguir viva
        caduca = due
    args = ["tarea", "add", title, "--para", para, "--cuando", f"{now:%Y-%m-%dT%H:%M}", "--caduca", f"{caduca:%Y-%m-%dT%H:%M}",
            "--clave", f"dagyard:{line['blocker']}", "--origen", "dagyard"]
    for d in detail:
        args += ["--detalle", d]
    rc = brain(*args)
    if line["blocker"] not in sent:
        lines = [f"Dagyard · {project} te pregunta: «{q}»", *detail[1:], detail[0]]
        if buzz_dm(para, "\n".join(lines)) == 0:
            sent.add(line["blocker"])
    return rc


def resolved(line: dict) -> int:
    choice = line.get("choice") or ("acceso entregado" if line.get("kind") == "access" else "respondida")
    how = "Rigió la opción por defecto" if line.get("byDefault") else "Respondida en Dagyard"
    return brain("tarea", "cerrar", "--clave", f"dagyard:{line['blocker']}", "--comentario", f"{how}: {choice}")


def handle(raw: str, project: str, para: str, sent: "Sent") -> None:
    try:
        line = json.loads(raw)
    except ValueError:
        return
    if line.get("type") == "blocker.opened":
        opened(line, project, para, sent)
    elif line.get("type") == "blocker.resolved":
        resolved(line)


def backfill(cli: str, project: str, para: str, sent: "Sent") -> None:
    """Reenvía el aviso de cada pregunta abierta que aún no lo tiene (un DM que falló, un servicio que estuvo caído).

    `watch --once` sin cursor lista lo que ya espera; la tarea de brain no se duplica porque va por su clave.
    """
    r = subprocess.run([cli, "watch", "--json", "--once", "--project", project], capture_output=True, text=True,
                       env={**os.environ, "LANG": "es_PE.UTF-8"}, timeout=60)
    for raw in r.stdout.splitlines():
        try:
            line = json.loads(raw)
        except ValueError:
            continue
        if line.get("type") == "blocker.opened" and line["blocker"] not in sent:
            opened(line, project, para, sent)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--project", required=True)
    ap.add_argument("--para", default="andre", help="persona de team.md que recibe el aviso")
    ap.add_argument("--once", action="store_true", help="una pasada y sale (prueba)")
    a = ap.parse_args()
    cli = shutil.which("dagyard") or sys.exit("brain-avisos: no hay `dagyard` en el PATH")
    cursor = Path.home() / f".config/dagyard/watch/avisos-{a.project}.cursor"
    cursor.parent.mkdir(parents=True, exist_ok=True)
    sent = Sent(cursor.with_suffix(".sent"))
    if not os.environ.get("BUZZ_CC_PRIVATE_KEY"):
        print("brain-avisos: falta $BUZZ_CC_PRIVATE_KEY; los avisos al teléfono no saldrán (ver integrations/README.md)", flush=True)
    while True:
        backfill(cli, a.project, a.para, sent)
        argv = [cli, "watch", "--json", "--cursor", str(cursor), "--project", a.project]
        if a.once:
            argv.append("--once")
        # el cursor solo existe tras la primera vuelta: sin él, watch lista primero lo que ya espera (snapshot)
        with subprocess.Popen(argv, stdout=subprocess.PIPE, text=True, env={**os.environ, "LANG": "es_PE.UTF-8"}) as p:
            for raw in p.stdout:  # type: ignore[union-attr]
                handle(raw, a.project, a.para, sent)
            rc = p.wait()
        if a.once:
            return rc
        print(f"brain-avisos: watch salió {rc}; vuelvo en {RETRY_S} s", flush=True)
        time.sleep(RETRY_S)


if __name__ == "__main__":
    sys.exit(main())
