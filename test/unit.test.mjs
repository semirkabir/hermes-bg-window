// Run: node test/unit.test.mjs  (stubs the SDK import)
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '../desktop/plugin.js'), 'utf8')
  .replace("import { host } from '@hermes/plugin-sdk'", 'const host = {}')
const tmp = join(process.env.TMPDIR || '/tmp', 'bgw-test'); mkdirSync(tmp, { recursive: true })
const f = join(tmp, 'plugin.mjs'); writeFileSync(f, src)
const { parseBg, md, followUpPrompt, summaryText } = (await import(pathToFileURL(f))).__test

assert.equal(parseBg('/bg do a thing'), 'do a thing')
assert.equal(parseBg('  /background  multi\nline '), 'multi\nline')
assert.equal(parseBg('/bg'), '')
assert.equal(parseBg('/btw hi'), null)
assert.equal(parseBg('/bgx hi'), null)
assert.equal(parseBg('hello /bg'), null)

assert.ok(!md('<img src=x onerror=alert(1)>').includes('<img'))
assert.ok(!md('[x](javascript:alert(1))').includes('href'))
assert.ok(md('[x](https://a.b/"onmouseover=1)').includes('&quot;'))
assert.equal(md('- a\n- b'), '<ul><li>a</li><li>b</li></ul>')
assert.equal(md('```\n<b>\n```'), '<pre><code>&lt;b&gt;</code></pre>')
assert.ok(md('use `x` **y**').includes('<code>x</code>'))

assert.equal(followUpPrompt(null, 'q'), 'q')
assert.ok(followUpPrompt({ prompt: 'p', result: 'r' }, 'q').includes('Task: p'))
assert.deepEqual(summaryText([]), { dot: false, text: 'No tasks' })
assert.deepEqual(summaryText([{ status: 'running', shown: 'x' }]), { dot: true, text: 'x' })
assert.equal(summaryText([{ status: 'done', result: '## Title\nmore' }]).text, 'Title')
assert.equal(summaryText([{ status: 'error', result: 'boom' }]).text, 'Error: boom')
console.log('ok — all unit checks passed')
