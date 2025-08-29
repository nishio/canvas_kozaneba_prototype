#!/usr/bin/env node
// Precompute clusters and summaries for the canvas app.
// - Reads hierarchical_result.json
// - Places clusters_summary.json in public/
// - Optional args: --min-size=10 --input=hierarchical_result.json --output=public/clusters_summary.json

import fs from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const args = {
    minSize: 10,
    input: 'hierarchical_result.json',
    output: 'public/clusters_summary.json',
    useOpenRouter: false,
    orModel: 'openai/gpt-4o-mini',
    orMaxTokens: 600,
  }
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/)
    if (m) {
      const k = m[1], v = m[2]
      if (k === 'min-size') args.minSize = Number(v)
      else if (k === 'input') args.input = v
      else if (k === 'output') args.output = v
      else if (k === 'or-model') args.orModel = v
      else if (k === 'or-max-tokens') args.orMaxTokens = Number(v)
    } else if (a === '--use-openrouter') {
      args.useOpenRouter = true
    }
  }
  return args
}

const NOTE_SIZE = 120
const POSITION_SCALE = 4000

function distributeNotes(argumentsData) {
  // Compute bounds
  const minX = Math.min(...argumentsData.map(a => a.x))
  const maxX = Math.max(...argumentsData.map(a => a.x))
  const minY = Math.min(...argumentsData.map(a => a.y))
  const maxY = Math.max(...argumentsData.map(a => a.y))

  const tempNotes = argumentsData.map((arg, index) => {
    const rawX = (arg.x - minX) * POSITION_SCALE
    const rawY = (arg.y - minY) * POSITION_SCALE
    const gridX = Math.floor(rawX / NOTE_SIZE)
    const gridY = Math.floor(rawY / NOTE_SIZE)
    const hue = (index * 137.5) % 360
    const color = `hsl(${hue} 70% 80%)`
    return { id: arg.arg_id, originalGridX: gridX, originalGridY: gridY, gridX, gridY, w: NOTE_SIZE, h: NOTE_SIZE, color, text: arg.argument }
  })

  const occupied = new Set()
  const notes = []
  for (const note of tempNotes) {
    let finalGX = note.gridX, finalGY = note.gridY
    let found = false
    for (let radius = 0; radius < 20 && !found; radius++) {
      for (let dx = -radius; dx <= radius && !found; dx++) {
        for (let dy = -radius; dy <= radius && !found; dy++) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue
          const tgx = note.originalGridX + dx
          const tgy = note.originalGridY + dy
          const key = `${tgx},${tgy}`
          if (!occupied.has(key)) { finalGX = tgx; finalGY = tgy; occupied.add(key); found = true }
        }
      }
    }
    if (!found) occupied.add(`${note.gridX},${note.gridY}`)
    const x = finalGX * NOTE_SIZE
    const y = finalGY * NOTE_SIZE
    notes.push({ id: note.id, x, y, w: NOTE_SIZE, h: NOTE_SIZE, color: note.color, text: note.text, gridX: finalGX, gridY: finalGY })
  }

  const WORLD_W = (maxX - minX) * POSITION_SCALE + NOTE_SIZE * 2
  const WORLD_H = (maxY - minY) * POSITION_SCALE + NOTE_SIZE * 2
  return { notes, world: { width: WORLD_W, height: WORLD_H } }
}

function extractConnectedClusters(notes, minSize) {
  const byGrid = new Map()
  for (const n of notes) byGrid.set(`${n.gridX},${n.gridY}`, n)
  const seen = new Set()
  const clusters = []
  let cid = 1
  for (const n of notes) {
    const key = `${n.gridX},${n.gridY}`
    if (seen.has(key)) continue
    const q = [n]
    seen.add(key)
    const comp = []
    while (q.length) {
      const cur = q.shift()
      comp.push(cur)
      for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nk = `${cur.gridX+dx},${cur.gridY+dy}`
        if (!seen.has(nk) && byGrid.has(nk)) { seen.add(nk); q.push(byGrid.get(nk)) }
      }
    }
    if (comp.length >= minSize) {
      const minx = Math.min(...comp.map(v=>v.x))
      const miny = Math.min(...comp.map(v=>v.y))
      const maxx = Math.max(...comp.map(v=>v.x+v.w))
      const maxy = Math.max(...comp.map(v=>v.y+v.h))
      const rect = { x: minx, y: miny, w: maxx-minx, h: maxy-miny }
      clusters.push({ id: `C${cid++}`, rect, noteIds: comp.map(v=>v.id), texts: comp.map(v=>v.text) })
    }
  }
  return clusters
}

function simpleSummarize(texts) {
  const joined = texts.join('\n')
  const sentences = joined.split(/[。.!?\n]+/).map(s => s.trim()).filter(Boolean)
  const top = sentences.slice(0, Math.min(3, sentences.length)).join('。') + (sentences.length > 3 ? '。…' : '')
  const keywords = topWords(texts, 8).join(', ')
  return `要旨: ${top}\nキーワード: ${keywords}`
}
function topWords(texts, k) {
  const stop = new Set(['の','に','は','を','が','と','で','も','へ','や','から','まで','より','そして','しかし','また','です','ます','する','いる','ある','こと','ため','よう','これ','それ','あれ'])
  const freq = new Map()
  const body = texts.join(' ').toLowerCase()
  const tokens = body.split(/[^\p{L}\p{N}_]+/u).filter(Boolean)
  for (const t of tokens) {
    if (t.length <= 1) continue
    if (stop.has(t)) continue
    freq.set(t, (freq.get(t) || 0) + 1)
  }
  return [...freq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,k).map(([w])=>w)
}

async function main() {
  const args = parseArgs(process.argv)
  const cwd = process.cwd()
  const inPath = path.isAbsolute(args.input) ? args.input : path.join(cwd, args.input)
  const outPath = path.isAbsolute(args.output) ? args.output : path.join(cwd, args.output)

  const raw = await fs.readFile(inPath, 'utf-8')
  const data = JSON.parse(raw)
  const { notes, world } = distributeNotes(data.arguments)
  const clusters = extractConnectedClusters(notes, args.minSize)

  const useOR = args.useOpenRouter || !!process.env.OPENROUTER_API_KEY
  const apiKey = process.env.OPENROUTER_API_KEY
  for (const c of clusters) {
    if (useOR && apiKey) {
      try {
        const jsonStr = await summarizeWithOpenRouter(c.texts, { model: args.orModel, apiKey, maxTokens: args.orMaxTokens })
        c.summary = jsonStr
        continue
      } catch (e) {
        console.warn('OpenRouter要約に失敗。フォールバックします。', e?.message || e)
      }
    }
    c.summary = simpleSummarize(c.texts)
  }

  // 出力ディレクトリ作成
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  const out = { world, clusters }
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf-8')
  // eslint-disable-next-line no-console
  console.log(`Wrote ${clusters.length} clusters to ${path.relative(cwd, outPath)}`)
}

main().catch(err => { console.error(err); process.exit(1) })

// OpenRouter 経由で LLM 要約を作成。JSON文字列を返す。
async function summarizeWithOpenRouter(texts, { model, apiKey, maxTokens }) {
  const endpoint = 'https://openrouter.ai/api/v1/chat/completions'
  // 入力を冗長にしすぎないよう、長さを制限
  const MAX_INPUT_CHARS = 12000
  let bodyText = texts.join('\n- ')
  if (bodyText.length > MAX_INPUT_CHARS) bodyText = bodyText.slice(0, MAX_INPUT_CHARS) + '\n…'

  const system = 'あなたは日本語で箇条書きの短文群を要約する専門家です。'
  const user = `以下は同一トピックの付箋テキスト群です。内容を日本語で構造化要約し、必ずJSONのみを出力してください。キーは次を含めてください: \n- title: 20~40文字程度の短い要約タイトル\n- summary: 3~5文で簡潔に要約\n- bullet_points: 3~6個の箇条書きポイント（短く）\n- keywords: 8個以内の重要語句（配列）\n注意: JSON以外の文字は出力しないでください。\n\n付箋テキスト:\n- ${bodyText}`

  const payload = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // OpenRouter 推奨ヘッダー（任意）
      'HTTP-Referer': 'https://github.com/openai/codex-cli',
      'X-Title': 'canvas_kozaneba precompute',
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const text = await res.text().catch(()=> '')
    throw new Error(`OpenRouter HTTP ${res.status}: ${text}`)
  }
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('OpenRouter応答が空です')

  // content は JSON のはず（response_format 指定）。そのまま返す。
  // 念のため最小限に検証。
  try { JSON.parse(content) } catch { throw new Error('OpenRouter応答がJSONではありません') }
  return content
}
