import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'sw-bridge.vbs')

const ACTION_PARAMS = {
  connect: [],
  new_part: [],
  draw_sketch: ['plane', 'shape', 'width', 'height', 'diameter', 'minor', 'sides', 'center_x', 'center_y', 'append', 'points', 'start_angle', 'end_angle'],
  extrude: ['depth', 'direction', 'draft', 'start', 'merge'],
  cut: ['depth', 'through_all', 'direction'],
  fillet: ['radius'],
  chamfer: ['distance', 'angle'],
  boolean: ['operation'],
  revolve_cut: ['angle'],
  new_assembly: [],
  add_component: ['path', 'x', 'y', 'z', 'angle'],
  add_mate: ['type', 'x1', 'y1', 'z1', 'x2', 'y2', 'z2'],
  save: ['path'],
  check: [],
}

/** Decode console bytes robustly: the marker and JSON are ASCII/UTF-8, but the
 *  console codepage may hand us ANSI (GBK on Chinese Windows) instead. */
function pickText(raw) {
  const decode = (fn) => {
    try {
      return fn().replace(/^\uFEFF/, '')
    } catch {
      return ''
    }
  }
  const candidates = [
    () => decode(() => raw.toString('utf8')),
    () => decode(() => { try { return new TextDecoder('gbk').decode(raw) } catch { return '' } }),
    () => decode(() => raw.toString('utf16le')),
  ]
  for (const fn of candidates) {
    const t = fn()
    if (t && (t.includes('RESULT:') || t.includes('"ok"'))) return t
  }
  return raw.toString('utf8').replace(/^\uFEFF/, '')
}

function parseJsonLine(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(lines[i])
      if (value && typeof value === 'object') return value
    } catch {}
  }
  return null
}

/**
 * Run one SolidWorks bridge action in a fresh cscript (Windows Script Host)
 * process. The VBS bridge writes its JSON result to a UTF-8 file and prints
 * only an ASCII `RESULT:<path>` marker line, so no console encoding can
 * corrupt the payload. Resolves with the parsed bridge result; rejects only on
 * infrastructure failure (spawn error, timeout, abort, unreadable result).
 */
export function runSw(action, args, config, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(os.tmpdir(), `dsh-sw-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`)
    const named = [
      '//nologo',
      BRIDGE,
      '/A:' + action,
      '/OutFile:' + outFile,
      '/AutoLaunch:' + (config.autoLaunch === false ? '0' : '1'),
      '/ShowWindow:' + (config.showWindow === false ? '0' : '1'),
      '/SetUnits:' + (config.setUnits === false ? '0' : '1'),
      '/AutoRebuildCheck:' + (config.autoRebuildCheck === false ? '0' : '1'),
    ]
    for (const key of ACTION_PARAMS[action] ?? []) {
      if (args[key] === undefined || args[key] === null) continue
      const value = typeof args[key] === 'boolean' ? (args[key] ? '1' : '0') : String(args[key])
      named.push('/' + key + ':' + value)
    }
    let child
    try {
      child = spawn('cscript.exe', named, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      reject(new Error(`无法启动 cscript（Windows 脚本宿主）：${error?.message ?? error}`))
      return
    }
    const cleanup = () => {
      try { fs.unlinkSync(outFile) } catch {}
    }
    let stdoutChunks = []
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      fn(value)
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch {}
    }, timeoutMs)
    const onAbort = () => { try { child.kill() } catch {} }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d) => { stdoutChunks.push(d) })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (error) => {
      finish(reject, new Error(`无法启动 cscript（Windows 脚本宿主）：${error.message}`))
    })
    child.on('close', (code) => {
      if (timedOut) {
        return finish(reject, new Error(`SolidWorks 操作超时（${Math.round(timeoutMs / 1000)} 秒）。首次启动 SolidWorks 可能需要 1–2 分钟，请重试一次；若持续超时，请检查 SolidWorks 是否卡在启动画面或许可对话框。`))
      }
      if (signal?.aborted) return finish(reject, new Error('工具调用已取消'))
      const text = pickText(Buffer.concat(stdoutChunks))
      const marker = /RESULT:\s*(\S+)/.exec(text)
      if (marker) {
        try {
          const rawJson = fs.readFileSync(marker[1].trim(), 'utf8').replace(/^\uFEFF/, '')
          const value = JSON.parse(rawJson)
          if (value && typeof value === 'object') {
            cleanup()
            return finish(resolve, value)
          }
        } catch (error) {
          cleanup()
          return finish(reject, new Error(`SolidWorks 桥接结果文件无效：${error.message}`))
        }
        cleanup()
      }
      const value = parseJsonLine(text)
      if (value) return finish(resolve, value)
      const detail = stderr.trim() ? stderr.split(/\r?\n/).slice(-30).join('\n') : `(cscript 退出码 ${code ?? '未知'}，无输出)`
      finish(reject, new Error(`SolidWorks 桥接脚本未返回有效结果。\n[详情]\n${detail}`))
    })
  })
}
