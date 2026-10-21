// SolidWorks MCP connection helpers — author: e^46 zhaoyi
//
// The live stdio connection is declared in cordis.patch.yml (row id
// "solidworks-mcp", package @deepseek-ai/dsh-mcp-client). This module makes the
// connection tangible and self-checking from plugin code: it resolves the
// Python runtime, verifies that the bundled MCP server module imports, and can
// install the PyPI package (solidworks-mcp) when missing.

import { spawn } from 'node:child_process'

export const DEFAULT_PYTHON =
  'C:\\Users\\Lenovo\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe'
export const SERVER_MODULE = 'solidworks_mcp.server'
export const SERVER_PACKAGE = 'solidworks-mcp'
export const SERVER_NAME = 'solidworks'

export function resolvePython(config = {}) {
  return config.pythonPath || process.env.DSH_SOLIDWORKS_PYTHON || DEFAULT_PYTHON
}

// The exact config the bundle's cordis.patch.yml row uses.
export function mcpRowConfig(python, { serverName = SERVER_NAME, module = SERVER_MODULE } = {}) {
  return {
    id: 'solidworks-mcp',
    name: '@deepseek-ai/dsh-mcp-client',
    serverName,
    transport: 'stdio',
    command: python,
    args: ['-m', module],
    failOnStartupError: true,
  }
}

export function runPython(python, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawn(python, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ code: -1, stdout: '', stderr: String(error?.message ?? error) })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ code: -1, stdout, stderr: `${stderr}${error?.message ?? error}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ code: code ?? -1, stdout, stderr })
    })
  })
}

export async function checkMcpServer(python, { timeoutMs = 60000 } = {}) {
  const probe = await runPython(
    python,
    ['-c', `import ${SERVER_MODULE} as m; print(getattr(m, '__file__', 'ok'))`],
    timeoutMs,
  )
  const detail = (probe.stdout || probe.stderr || '').trim().split(/\r?\n/).slice(-3).join(' | ')
  return { ok: probe.code === 0, python, detail: detail.slice(-600) }
}

export async function installMcpServer(python, { timeoutMs = 300000 } = {}) {
  const run = await runPython(
    python,
    ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', SERVER_PACKAGE],
    timeoutMs,
  )
  const detail = (run.stderr || run.stdout || '').trim().split(/\r?\n/).slice(-4).join(' | ')
  return { ok: run.code === 0, code: run.code, detail: detail.slice(-800) }
}
