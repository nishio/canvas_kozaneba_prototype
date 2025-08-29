import { useEffect, useRef, useState } from 'react'
import type { Note, HierarchicalResult, ClusterSummary } from './types'
import { summarizeTextsLLM } from './summarizer'

// グリッド連結（4近傍）で N 枚以上のクラスターを抽出し、矩形+要約を作成するビュー
export default function StickyNotesClustersView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [clusters, setClusters] = useState<ClusterSummary[]>([])
  const [minClusterSize, setMinClusterSize] = useState(10)
  const [busy, setBusy] = useState(false)
  const [jsonOpen, setJsonOpen] = useState(false)
  const [precomputedLoaded, setPrecomputedLoaded] = useState(false)
  const [clusterRender, setClusterRender] = useState<'outline' | 'sticky'>('outline')

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = (containerRef.current ?? canvas.parentElement) as HTMLElement | null
    if (!parent) return
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true })
    if (!ctx) return
    const dpr = Math.max(1, Math.min(globalThis.devicePixelRatio || 1, 2))

    const NOTE_SIZE = 120
    const notes: Note[] = []
    let WORLD_W = 800
    let WORLD_H = 600

    const POSITION_SCALE = 4000

    // 1) まず事前計算済みの clusters_summary.json を読み込み
    fetch('/clusters_summary.json')
      .then(r => r.ok ? r.json() : Promise.reject(new Error('not found')))
      .then((data: { world?: { width:number;height:number }, clusters: ClusterSummary[] }) => {
        if (Array.isArray(data?.clusters)) {
          setClusters(data.clusters)
          setPrecomputedLoaded(true)
        }
      })
      .catch(() => { /* 事前計算がない場合は動的抽出の準備へ */ })

    // 2) 元データを読み込み（キャンバス描画と動的抽出に使用）
    fetch('/hierarchical_result.json')
      .then(r => r.json())
      .then((data: HierarchicalResult) => {
        notes.length = 0
        const minX = Math.min(...data.arguments.map(a => a.x))
        const maxX = Math.max(...data.arguments.map(a => a.x))
        const minY = Math.min(...data.arguments.map(a => a.y))
        const maxY = Math.max(...data.arguments.map(a => a.y))

        const tempNotes = data.arguments.map((arg, index) => {
          const rawX = (arg.x - minX) * POSITION_SCALE
          const rawY = (arg.y - minY) * POSITION_SCALE
          const gridX = Math.floor(rawX / NOTE_SIZE)
          const gridY = Math.floor(rawY / NOTE_SIZE)
          const hue = (index * 137.5) % 360
          const color = `hsl(${hue} 70% 80%)`
          return { id: arg.arg_id, originalGridX: gridX, originalGridY: gridY, gridX, gridY, w: NOTE_SIZE, h: NOTE_SIZE, color, text: arg.argument } as any
        })

        const occupied = new Set<string>()
        const distributed: Note[] = []
        for (const note of tempNotes) {
          let finalGX = note.gridX, finalGY = note.gridY
          let found = false
          for (let radius = 0; radius < 20 && !found; radius++) {
            for (let dx = -radius; dx <= radius && !found; dx++) {
              for (let dy = -radius; dy <= radius && !found; dy++) {
                if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue
                const tgx = (note as any).originalGridX + dx
                const tgy = (note as any).originalGridY + dy
                const key = `${tgx},${tgy}`
                if (!occupied.has(key)) { finalGX = tgx; finalGY = tgy; occupied.add(key); found = true }
              }
            }
          }
          if (!found) occupied.add(`${note.gridX},${note.gridY}`)

          const x = finalGX * NOTE_SIZE
          const y = finalGY * NOTE_SIZE
          distributed.push({ id: note.id, x, y, w: NOTE_SIZE, h: NOTE_SIZE, color: (note as any).color, text: note.text, gridX: finalGX, gridY: finalGY })
        }

        notes.push(...distributed)
        WORLD_W = (maxX - minX) * POSITION_SCALE + NOTE_SIZE * 2
        WORLD_H = (maxY - minY) * POSITION_SCALE + NOTE_SIZE * 2

        fitToView()
        needRedraw = true

        // クラスタ抽出を関数化（UIから呼ぶ／事前計算が無い時用）
        ;(globalThis as any).__extractClusters__ = async (minSize: number) => {
          const clusters = extractConnectedClusters(notes, minSize)
          // 要約は非同期で順次付与
          setBusy(true)
          try {
            const withSummary: ClusterSummary[] = []
            for (const c of clusters) {
              const summary = await summarizeTextsLLM(c.texts)
              withSummary.push({ ...c, summary })
            }
            setClusters(withSummary)
            setJsonOpen(true)
          } finally {
            setBusy(false)
          }
          needRedraw = true
        }
      })
      .catch(err => { console.error('load failed', err) })

    // ビュートランスフォーム
    let scale = 1, targetScale = 1
    let tx = 0, ty = 0
    let targetTx = 0, targetTy = 0
    let dragging = false
    let lastX = 0, lastY = 0
    let rafId = 0
    let needRedraw = true

    function fitToView() {
      fitContainer()
      const rect = parent!.getBoundingClientRect()
      const cssW = Math.max(1, Math.round(rect.width))
      const cssH = Math.max(1, Math.round(rect.height))
      const s = Math.min(cssW / WORLD_W, cssH / WORLD_H) * 0.92
      targetScale = scale = s
      tx = (cssW - WORLD_W * scale) / 2
      ty = (cssH - WORLD_H * scale) / 2
      targetTx = tx; targetTy = ty
      needRedraw = true
    }
    function fitContainer() {
      const vv = globalThis.visualViewport
      const cssW = Math.max(1, Math.round(vv?.width ?? globalThis.innerWidth))
      const cssH = Math.max(1, Math.round(vv?.height ?? globalThis.innerHeight))
      parent!.style.width = `${cssW}px`
      parent!.style.height = `${cssH}px`
    }
    function resize() {
      fitContainer()
      const rect = parent!.getBoundingClientRect()
      const cssW = Math.max(1, Math.round(rect.width))
      const cssH = Math.max(1, Math.round(rect.height))
      canvas.width = Math.max(1, Math.round(cssW * dpr))
      canvas.height = Math.max(1, Math.round(cssH * dpr))
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`
      needRedraw = true
    }
    resize(); fitToView()

    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const rect = canvas!.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const worldX = (mouseX - tx) / scale
      const worldY = (mouseY - ty) / scale
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      const newScale = clamp(scale * delta, 0.001, 1.5)
      scale = targetScale = newScale
      tx = targetTx = mouseX - worldX * newScale
      ty = targetTy = mouseY - worldY * newScale
      needRedraw = true
    }
    function onPointerDown(e: PointerEvent) { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas!.setPointerCapture(e.pointerId) }
    function onPointerMove(e: PointerEvent) {
      if (!dragging) return
      const dx = e.clientX - lastX, dy = e.clientY - lastY
      tx += dx; ty += dy; targetTx += dx; targetTy += dy
      lastX = e.clientX; lastY = e.clientY; needRedraw = true
    }
    function onPointerUp(e: PointerEvent) { dragging = false; canvas!.releasePointerCapture(e.pointerId) }
    function onDblClick() { fitToView() }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('pointerdown', onPointerDown)
    globalThis.addEventListener('pointermove', onPointerMove)
    globalThis.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('dblclick', onDblClick)
    globalThis.addEventListener('resize', () => { resize(); needRedraw = true })

    function draw() {
      const rect = parent!.getBoundingClientRect()
      const cssW = Math.max(1, Math.round(rect.width))
      const cssH = Math.max(1, Math.round(rect.height))
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx!.clearRect(0, 0, cssW, cssH)
      ctx!.fillStyle = '#fafafa'
      ctx!.fillRect(0, 0, cssW, cssH)

      // ease towards target
      const sDiff = targetScale - scale
      const xDiff = targetTx - tx
      const yDiff = targetTy - ty
      if (Math.abs(sDiff) > 1e-4 || Math.abs(xDiff) > 0.5 || Math.abs(yDiff) > 0.5) {
        const k = 0.25; scale += sDiff * k; tx += xDiff * k; ty += yDiff * k; needRedraw = true
      } else { scale = targetScale; tx = targetTx; ty = targetTy }

      const viewL = (0 - tx) / scale
      const viewT = (0 - ty) / scale
      const viewR = (cssW - tx) / scale
      const viewB = (cssH - ty) / scale

      ctx!.setTransform(scale * dpr, 0, 0, scale * dpr, tx * dpr, ty * dpr)

      // notes
      const NOTE_SIZE = 120
      const screenNoteW = NOTE_SIZE * scale
      const showText = screenNoteW >= 80
      let visible = 0
      for (const n of notes) {
        if (n.x > viewR || n.x + n.w < viewL || n.y > viewB || n.y + n.h < viewT) continue
        visible++
        ctx!.fillStyle = n.color
        ctx!.fillRect(n.x, n.y, n.w, n.h)
        if (showText) {
          const pad = 8
          ctx!.fillStyle = '#3a3a3a'
          const fontPx = 12
          const lineHeight = fontPx * 1.2
          ctx!.font = `${fontPx}px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto`
          ctx!.textBaseline = 'top'
          const maxW = n.w - pad * 2
          const maxH = n.h - pad * 2
          const maxLines = Math.floor(maxH / lineHeight)
          if (maxLines > 0) {
            const words = n.text.split(/\s+/)
            const lines: string[] = []
            let current = ''
            for (const w of words) {
              const test = current ? current + ' ' + w : w
              if (ctx!.measureText(test).width <= maxW) current = test
              else {
                if (current) { lines.push(current); current = w }
                else {
                  let charLine = ''
                  for (const ch of w) {
                    const t2 = charLine + ch
                    if (ctx!.measureText(t2).width <= maxW) charLine = t2
                    else { if (charLine) { lines.push(charLine); charLine = ch } else { lines.push(ch); break } }
                  }
                  current = charLine
                }
              }
              if (lines.length >= maxLines) break
            }
            if (current && lines.length < maxLines) lines.push(current)
            if (lines.length === maxLines && (lines.join(' ').length < n.text.length)) {
              let last = lines[lines.length - 1]
              while (ctx!.measureText(last + '…').width > maxW && last.length > 0) last = last.slice(0, -1)
              lines[lines.length - 1] = last + '…'
            }
            for (let i = 0; i < lines.length; i++) ctx!.fillText(lines[i], n.x + pad, n.y + pad + i * lineHeight)
          }
        }
      }

      // draw clusters overlay (outline or big sticky with title) in screen space
      ctx!.save()
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (clusterRender === 'outline') {
        ctx!.strokeStyle = 'rgba(255,0,0,0.9)'
        ctx!.lineWidth = 2
        for (const c of clusters) {
          const x = c.rect.x * scale + tx
          const y = c.rect.y * scale + ty
          const w = c.rect.w * scale
          const h = c.rect.h * scale
          ctx!.strokeRect(x, y, w, h)
        }
      } else {
        for (const c of clusters) {
          const x = c.rect.x * scale + tx
          const y = c.rect.y * scale + ty
          const w = c.rect.w * scale
          const h = c.rect.h * scale
          ctx!.fillStyle = 'rgba(255, 247, 153, 0.85)'
          ctx!.fillRect(x, y, w, h)
          ctx!.strokeStyle = 'rgba(0,0,0,0.15)'
          ctx!.lineWidth = 1
          ctx!.strokeRect(x, y, w, h)

          const title = extractTitleFromSummary(c.summary)
          if (title) {
            const pad = Math.max(8, Math.min(24, w * 0.03))
            const maxW = Math.max(10, w - pad * 2)
            ctx!.fillStyle = '#1f2937'
            const fontPx = Math.max(12, Math.min(28, 18))
            ctx!.font = `bold ${fontPx}px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto`
            ctx!.textBaseline = 'top'
            const lines = wrapByMeasure(ctx!, title, maxW, 2)
            for (let i = 0; i < lines.length; i++) {
              const ty = y + pad + i * Math.round(fontPx * 1.2)
              if (ty > y + h - pad) break
              ctx!.fillText(lines[i], x + pad, ty)
            }
          }
        }
      }
      ctx!.restore()

      // HUD
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      const hud = `clusters ${clusters.length} | visible ${visible}`
      ctx!.font = `12px ui-monospace, Menlo, Consolas, monospace`
      ctx!.textBaseline = 'middle'
      const tw = ctx!.measureText(hud).width + 16
      const th = 24
      ctx!.fillStyle = 'rgba(0,0,0,0.5)'
      const rectX = Math.max(8, canvas.width / dpr - tw - 12)
      const rectY = Math.max(8, canvas.height / dpr - th - 12)
      ctx!.fillRect(rectX, rectY, tw, th)
      ctx!.fillStyle = 'white'
      ctx!.fillText(hud, rectX + 8, rectY + th / 2)
    }

    function loop() { if (needRedraw) { needRedraw = false; draw() } rafId = requestAnimationFrame(loop) }
    loop()

    return () => {
      cancelAnimationFrame(rafId)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onPointerDown)
      globalThis.removeEventListener('pointermove', onPointerMove)
      globalThis.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('dblclick', onDblClick)
    }
  }, [clusters.length, clusterRender])

  async function runExtraction() {
    setJsonOpen(false)
    setBusy(true)
    try {
      await (globalThis as any).__extractClusters__?.(minClusterSize)
    } finally {
      setBusy(false)
      setJsonOpen(true)
    }
  }

  function downloadJSON() {
    const blob = new Blob([JSON.stringify({ clusters }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'clusters_summary.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div ref={containerRef} className="fixed inset-0 bg-white overflow-hidden touch-none">
      <canvas ref={canvasRef} className="block w-full h-full" />
      <div className="absolute left-3 top-3 z-10 pointer-events-auto bg-white/90 backdrop-blur rounded-lg shadow p-2 flex items-center gap-2">
        <div className="text-sm">N 枚以上の連結クラスタ:</div>
        <input type="number" min={2} className="w-20 border rounded px-2 py-1 text-sm" value={minClusterSize}
               onChange={e=>setMinClusterSize(Math.max(1, parseInt(e.target.value||'1',10)))} />
        <button type="button" disabled={busy} onClick={runExtraction} className="text-sm px-2 py-1 border rounded hover:bg-gray-100 disabled:opacity-50">
          {busy ? '処理中…' : precomputedLoaded ? '再抽出+要約' : '抽出+要約'}
        </button>
        <button type="button" onClick={()=>setJsonOpen(v=>!v)} className="text-sm px-2 py-1 border rounded hover:bg-gray-100">JSON表示</button>
        <button type="button" onClick={downloadJSON} className="text-sm px-2 py-1 border rounded hover:bg-gray-100">JSON保存</button>
        {precomputedLoaded && <span className="text-xs text-gray-600">事前計算済みを読み込みました</span>}
        <div className="mx-2 w-px self-stretch bg-gray-300" />
        <div className="text-sm">表示:</div>
        <button type="button" onClick={()=>setClusterRender('outline')} className={`text-sm px-2 py-1 border rounded hover:bg-gray-100 ${clusterRender==='outline'?'bg-gray-100':''}`}>赤枠</button>
        <button type="button" onClick={()=>setClusterRender('sticky')} className={`text-sm px-2 py-1 border rounded hover:bg-gray-100 ${clusterRender==='sticky'?'bg-gray-100':''}`}>大きな付箋</button>
      </div>

      {jsonOpen && (
        <div className="absolute left-3 bottom-3 z-10 pointer-events-auto bg-white/90 backdrop-blur rounded-xl shadow p-3 w-[min(640px,calc(100vw-24px))] max-h-[45vh] overflow-auto">
          <div className="flex items-center gap-2 mb-2">
            <div className="font-medium">クラスター要約 JSON</div>
            <div className="text-xs text-gray-600">{clusters.length}件</div>
            <div className="flex-1" />
            <button className="text-xs px-2 py-1 border rounded hover:bg-gray-100" onClick={()=>setJsonOpen(false)}>閉じる</button>
          </div>
          <pre className="text-xs whitespace-pre-wrap break-words">{JSON.stringify({ clusters }, null, 2)}</pre>
        </div>
      )}
    </div>
  )
}

function clamp(v:number,lo:number,hi:number){return Math.max(lo,Math.min(hi,v))}

// summary(JSON文字列)から title を取り出す
function extractTitleFromSummary(summary?: string): string | null {
  if (!summary) return null
  try {
    const obj = JSON.parse(summary)
    const title = typeof obj?.title === 'string' ? obj.title : null
    if (title && title.trim()) return title.trim()
    // フォールバック: keywords からタイトルを合成
    const kws = Array.isArray(obj?.keywords) ? obj.keywords.filter((x: any)=> typeof x === 'string').slice(0,4) : []
    if (kws.length) return kws.join('・')
  } catch { /* no-op */ }
  return null
}

// 日本語向けに文字単位で計測し、maxLines まで折り返す。最終行は省略記号。
function wrapByMeasure(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const out: string[] = []
  let line = ''
  for (const ch of text) {
    const test = line + ch
    if (ctx.measureText(test).width <= maxW) {
      line = test
    } else {
      if (line) out.push(line)
      else out.push(ch)
      line = ''
      if (out.length >= maxLines) break
      line = ch
    }
    if (out.length >= maxLines) break
  }
  if (out.length < maxLines && line) out.push(line)
  if (out.length > maxLines) out.length = maxLines
  if (out.length === maxLines) {
    // 省略記号
    let last = out[out.length - 1]
    while (ctx.measureText(last + '…').width > maxW && last.length > 0) last = last.slice(0, -1)
    out[out.length - 1] = last + '…'
  }
  return out
}

// 4近傍で連結成分抽出し、各成分の外接矩形とテキストをまとめる
function extractConnectedClusters(notes: Note[], minSize: number): ClusterSummary[] {
  const byGrid = new Map<string, Note>()
  for (const n of notes) byGrid.set(`${n.gridX},${n.gridY}`, n)
  const seen = new Set<string>()
  const clusters: ClusterSummary[] = []
  let cid = 1
  for (const n of notes) {
    const key = `${n.gridX},${n.gridY}`
    if (seen.has(key)) continue
    // BFS
    const q: Note[] = []
    q.push(n); seen.add(key)
    const comp: Note[] = []
    while (q.length) {
      const cur = q.shift()!
      comp.push(cur)
      const neigh = [ [1,0],[-1,0],[0,1],[0,-1] ]
      for (const [dx,dy] of neigh) {
        const nk = `${cur.gridX+dx},${cur.gridY+dy}`
        if (!seen.has(nk) && byGrid.has(nk)) { seen.add(nk); q.push(byGrid.get(nk)!) }
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
