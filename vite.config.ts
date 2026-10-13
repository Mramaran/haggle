import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

// Dev server only: the spike page posts its report here after every game, so results
// land in the project folder without a manual download.
function spikeResults(): Plugin {
  const directory = resolve(import.meta.dirname, '../output/spike')
  return {
    name: 'spike-results',
    configureServer(server) {
      server.middlewares.use('/__spike-result', (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405
          response.end()
          return
        }
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          try {
            const report = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: unknown }
            const name = String(report.model).replace(/[^A-Za-z0-9._-]/g, '_')
            mkdirSync(directory, { recursive: true })
            writeFileSync(resolve(directory, `result-${name}.json`), JSON.stringify(report, null, 2))
            response.statusCode = 204
          } catch {
            response.statusCode = 400
          }
          response.end()
        })
      })
    },
  }
}

export default defineConfig({ plugins: [spikeResults()] })
