import fs from 'node:fs'
import { spawn } from 'node:child_process'

const mode = process.argv[2]
if (!['dev', 'start'].includes(mode)) throw new Error('用法：node scripts/with-cloud-env.js dev|start')
const vars = Object.fromEntries(fs.readFileSync('.env.cloud', 'utf8').split('\n').filter(Boolean).map((line) => {
  const index = line.indexOf('=')
  return [line.slice(0, index), line.slice(index + 1)]
}))
const child = spawn('npm', ['run', mode], { stdio: 'inherit', env: { ...process.env, ...vars } })
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code || 0 })
