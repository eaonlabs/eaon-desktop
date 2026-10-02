// A minimal stdio MCP server for tests: newline-delimited JSON-RPC on
// stdin/stdout, one tool. Plain Node with no imports so it runs from any
// PATH that can find `node` — which is exactly what the test checks.
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) handle(JSON.parse(line))
  }
})

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

function handle(message) {
  if (message.id === undefined) return
  if (message.method === 'initialize') {
    send({
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'stdio-fixture', version: '1' }
      }
    })
  } else if (message.method === 'tools/list') {
    send({
      id: message.id,
      result: {
        tools: [{ name: 'node_version', description: 'Reports the Node version running this server', inputSchema: { type: 'object', properties: {} } }]
      }
    })
  } else if (message.method === 'tools/call') {
    send({ id: message.id, result: { content: [{ type: 'text', text: process.version }] } })
  } else {
    send({ id: message.id, error: { code: -32601, message: 'no such method' } })
  }
}
