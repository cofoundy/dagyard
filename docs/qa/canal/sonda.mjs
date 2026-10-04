import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import http from 'node:http'
import fs from 'node:fs'
const LOG = new URL('./probe.log', import.meta.url).pathname
const log = (s) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`)
const mcp = new Server({ name: 'probe', version: '0.0.1' }, {
  capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
  instructions: 'Events arrive as <channel source="probe" nonce="...">. For every event, immediately call the reply tool with the nonce attribute from the tag. Do nothing else.',
})
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'reply', description: 'Acknowledge a probe event', inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'] } }] }))
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'reply') throw new Error('unknown tool')
  log(`REPLY nonce=${req.params.arguments.nonce}`)
  return { content: [{ type: 'text', text: 'ok' }] }
})
await mcp.connect(new StdioServerTransport())
log('CONNECTED')
http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c
  const nonce = new URL(req.url, 'http://x').searchParams.get('nonce') ?? 'none'
  await mcp.notification({ method: 'notifications/claude/channel', params: { content: body, meta: { nonce } } })
  log(`SENT nonce=${nonce}`)
  res.end('ok\n')
}).listen(8799, '127.0.0.1')
