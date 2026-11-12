# Integraciones de Cofoundy

Lo que conecta Dagyard con las herramientas internas de Cofoundy. Quien instala Dagyard por su cuenta no lo necesita.

## Avisos al dueño (`brain-avisos.py`)

Cada pregunta nueva de un proyecto (`dagyard block`) le llega al dueño por dos vías: un DM de Buzz, que la app
móvil notifica, y una tarea en Vikunja (`brain tarea add`), que myturn muestra en la barra del Mac. Cuando se
responde (o rige su default, #131), la tarea se cierra sola. Un DM sale una sola vez por pregunta, aunque el
servicio se reinicie.

Necesita: `dagyard` en el PATH con su llave en `~/.config/dagyard/agent-key`, `uv`, y el plugin
`cofoundy-toolkit` (sus `brain.py` y `buzz_cli.py`).

```bash
python3 integrations/brain-avisos.py --project el-deily --once          # una pasada, para probar
mkdir -p ~/.config/systemd/user && cp integrations/dagyard-avisos@.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now dagyard-avisos@el-deily
journalctl --user -u dagyard-avisos@el-deily -f                       # qué avisó
```

El cursor y la lista de preguntas ya avisadas viven en `~/.config/dagyard/watch/avisos-<proyecto>.{cursor,sent}`.
