import { useEffect, useRef } from "react";
import type { Note, HierarchicalResult } from './types';

// StickyNotesZoomDemo をベースに、Shift+ドラッグで範囲選択できる派生版
// - 選択範囲（world座標）と、その範囲に含まれる付箋テキストを取得して表示
// - 既存のパン/ズーム操作は維持（通常ドラッグでパン、ホイールでズーム、ダブルクリック/Rでリセット）
export default function StickyNotesSelectDemo() {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const overlayRef = useRef<HTMLDivElement>(null);
    const selectionInfoRef = useRef<HTMLDivElement>(null);
    const controlsRef = useRef({
        setZoomCenter: (_z: number) => { },
        zoomIn: () => { },
        zoomOut: () => { }
    });

    // 選択結果を保持（コピー用）
    const selectionStateRef = useRef<{ worldRect: null | { x: number; y: number; w: number; h: number }, texts: string[] }>({ worldRect: null, texts: [] });
    // 外部（ボタン）から再描画を要求するための関数を保持
    const redrawRef = useRef<() => void>(() => { /* noop */ });

    // 選択情報のオーバーレイ更新（コンポーネント外からも呼べるようにエフェクト外に定義）
    function updateSelectionInfo() {
        const el = selectionInfoRef.current;
        if (!el) return;
        const data = selectionStateRef.current;
        const json = JSON.stringify({ range: data.worldRect, texts: data.texts }, null, 2);
        // range が null の場合はダイアログ自体を非表示
        const hasRange = !!data.worldRect;
        (el as HTMLElement).style.display = hasRange ? '' : 'none';
        const pre = el.querySelector('pre[data-role="json"]');
        if (pre) pre.textContent = json;
        const summary = el.querySelector('[data-role="summary"]') as HTMLElement | null;
        if (summary) {
            const r = data.worldRect;
            summary.textContent = r ? `範囲 x:${r.x.toFixed(1)} y:${r.y.toFixed(1)} w:${r.w.toFixed(1)} h:${r.h.toFixed(1)} / 件数 ${data.texts.length}` : '範囲未選択';
        }
    }

    let MIN_ZOOM = 0.01; // 初期化後に実際の値に更新される
    const MAX_ZOOM = 1.5;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const parent = (containerRef.current ?? canvas.parentElement) as HTMLElement | null;
        if (!parent) return;
        const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
        if (!ctx) return;
        const dpr = Math.max(1, Math.min(globalThis.devicePixelRatio || 1, 2));

        // ======= データ読み込み =======
        const NOTE_SIZE = 120; // 正方形サイズ
        const notes: Note[] = [];
        let WORLD_W = 800;
        let WORLD_H = 600;

        // スケール調整パラメータ（重なりを調整）
        const POSITION_SCALE = 4000; // この値を大きくすると付箋が離れる

        // JSONファイルからデータを読み込み
        fetch('/hierarchical_result.json')
            .then(response => response.json())
            .then((data: HierarchicalResult) => {
                notes.length = 0; // 配列をクリア

                // 座標の範囲を計算してワールドサイズを決定
                const minX = Math.min(...data.arguments.map(arg => arg.x));
                const maxX = Math.max(...data.arguments.map(arg => arg.x));
                const minY = Math.min(...data.arguments.map(arg => arg.y));
                const maxY = Math.max(...data.arguments.map(arg => arg.y));

                // まず全ての付箋の初期格子位置を計算
                const tempNotes = data.arguments.map((arg, index) => {
                    const rawX = (arg.x - minX) * POSITION_SCALE;
                    const rawY = (arg.y - minY) * POSITION_SCALE;

                    // 格子点にスナップ
                    const gridX = Math.floor(rawX / NOTE_SIZE);
                    const gridY = Math.floor(rawY / NOTE_SIZE);

                    const hue = (index * 137.5) % 360; // ゴールデンアングルで色分散
                    const color = `hsl(${hue} 70% 80%)`;

                    return {
                        id: arg.arg_id,
                        originalGridX: gridX,
                        originalGridY: gridY,
                        gridX,
                        gridY,
                        w: NOTE_SIZE,
                        h: NOTE_SIZE,
                        color,
                        text: arg.argument
                    } as any;
                });

                // 格子点の重複を解決
                const occupiedGrids = new Set<string>();
                const distributedNotes: Note[] = [];

                for (const note of tempNotes) {
                    let finalGridX = note.gridX;
                    let finalGridY = note.gridY;

                    // 螺旋状に近い空きグリッドを探す
                    let found = false;
                    for (let radius = 0; radius < 20 && !found; radius++) {
                        for (let dx = -radius; dx <= radius && !found; dx++) {
                            for (let dy = -radius; dy <= radius && !found; dy++) {
                                if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;

                                const testX = (note as any).originalGridX + dx;
                                const testY = (note as any).originalGridY + dy;
                                const key = `${testX},${testY}`;

                                if (!occupiedGrids.has(key)) {
                                    finalGridX = testX;
                                    finalGridY = testY;
                                    occupiedGrids.add(key);
                                    found = true;
                                }
                            }
                        }
                    }

                    if (!found) {
                        // 空きが見つからない場合は元の位置を使用
                        const key = `${note.gridX},${note.gridY}`;
                        occupiedGrids.add(key);
                    }

                    const x = finalGridX * NOTE_SIZE;
                    const y = finalGridY * NOTE_SIZE;

                    distributedNotes.push({
                        id: note.id,
                        x,
                        y,
                        w: NOTE_SIZE,
                        h: NOTE_SIZE,
                        color: (note as any).color,
                        text: note.text,
                        gridX: finalGridX,
                        gridY: finalGridY
                    });
                }

                notes.push(...distributedNotes);

                WORLD_W = (maxX - minX) * POSITION_SCALE + NOTE_SIZE * 2;
                WORLD_H = (maxY - minY) * POSITION_SCALE + NOTE_SIZE * 2;

                // 初期表示を更新
                fitToView();
                needRedraw = true;
            })
            .catch(error => {
                console.error('Failed to load hierarchical_result.json:', error);
            });

        // ======= ビュートランスフォーム =======
        let scale = 1, targetScale = 1; // world→screen 拡大率
        let tx = 0, ty = 0;             // world→screen 平行移動
        let targetTx = 0, targetTy = 0; // 目標平行移動
        let dragging = false;           // パン中フラグ
        let lastX = 0, lastY = 0;       // パン用
        let rafId = 0;
        let needRedraw = true;
        redrawRef.current = () => { needRedraw = true; };

        // 選択ドラッグ状態（スクリーン座標）
        let selecting = false;
        let selStartSX = 0, selStartSY = 0;
        let selCurSX = 0, selCurSY = 0;

        function fitToView() {
            fitContainerToViewport();
            const rect = parent!.getBoundingClientRect();
            const cssW = Math.max(1, Math.round(rect.width));
            const cssH = Math.max(1, Math.round(rect.height));
            const s = Math.min(cssW / WORLD_W, cssH / WORLD_H) * 0.92; // 少し余白
            MIN_ZOOM = s; // MIN_ZOOMを初期表示に合わせる
            targetScale = scale = s;
            tx = (cssW - WORLD_W * scale) / 2;
            ty = (cssH - WORLD_H * scale) / 2;
            targetTx = tx;
            targetTy = ty;
            needRedraw = true;
        }

        function fitContainerToViewport() {
            const vv = globalThis.visualViewport;
            const cssW = Math.max(1, Math.round(vv?.width ?? globalThis.innerWidth));
            const cssH = Math.max(1, Math.round(vv?.height ?? globalThis.innerHeight));
            // 親そのものを実表示サイズに合わせる（Safari対策）
            parent!.style.width = `${cssW}px`;
            parent!.style.height = `${cssH}px`;
        }

        function resize() {
            fitContainerToViewport();
            const rect = parent!.getBoundingClientRect(); // 親の実サイズ
            const cssW = Math.max(1, Math.round(rect.width));
            const cssH = Math.max(1, Math.round(rect.height));
            canvas!.width = Math.max(1, Math.round(cssW * dpr));
            canvas!.height = Math.max(1, Math.round(cssH * dpr));
            canvas!.style.width = `${cssW}px`;
            canvas!.style.height = `${cssH}px`;
            needRedraw = true;
        }

        // 初期リサイズ & フィット
        resize();
        fitToView();

        // ======= 入力イベント =======
        function screenToWorld(sx: number, sy: number, s = scale, ox = tx, oy = ty) {
            return { x: (sx - ox) / s, y: (sy - oy) / s };
        }

        controlsRef.current.setZoomCenter = (newScale: number) => {
            const cssW = parent!.clientWidth;
            const cssH = parent!.clientHeight;
            // 現在の表示領域の中心点を維持
            const currentCenterX = cssW * 0.5;
            const currentCenterY = cssH * 0.5;
            const worldCenter = screenToWorld(currentCenterX, currentCenterY, scale, tx, ty);

            const clampedScale = clamp(newScale, MIN_ZOOM, MAX_ZOOM);
            targetScale = clampedScale;
            // 同じワールド座標が画面中央に来るように調整（目標値を更新）
            targetTx = currentCenterX - worldCenter.x * clampedScale;
            targetTy = currentCenterY - worldCenter.y * clampedScale;
            needRedraw = true;
        };
        controlsRef.current.zoomIn = () => {
            controlsRef.current.setZoomCenter(targetScale * 2);
        };
        controlsRef.current.zoomOut = () => {
            controlsRef.current.setZoomCenter(targetScale / 2);
        };

        function onWheel(e: WheelEvent) {
            e.preventDefault();
            const rect = canvas!.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            // ズーム前のワールド座標
            const worldX = (mouseX - tx) / scale;
            const worldY = (mouseY - ty) / scale;

            // 新しいスケール
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            const newScale = clamp(scale * delta, MIN_ZOOM, MAX_ZOOM);

            // マウス位置を固定点として平行移動を調整
            const newTx = mouseX - worldX * newScale;
            const newTy = mouseY - worldY * newScale;

            // ホイールは即座に反映（アニメーションなし）
            scale = targetScale = newScale;
            tx = targetTx = newTx;
            ty = targetTy = newTy;
            needRedraw = true;
        }

        function onPointerDown(e: PointerEvent) {
            const rect = canvas!.getBoundingClientRect();
            if (e.shiftKey) {
                // 範囲選択モード（Shift押下）
                selecting = true;
                selStartSX = e.clientX - rect.left;
                selStartSY = e.clientY - rect.top;
                selCurSX = selStartSX;
                selCurSY = selStartSY;
                canvas!.setPointerCapture(e.pointerId);
                needRedraw = true;
                return;
            }

            // 通常はパン
            dragging = true;
            lastX = e.clientX; lastY = e.clientY;
            canvas!.setPointerCapture(e.pointerId);
        }
        function onPointerMove(e: PointerEvent) {
            if (selecting) {
                const rect = canvas!.getBoundingClientRect();
                selCurSX = e.clientX - rect.left;
                selCurSY = e.clientY - rect.top;
                needRedraw = true;
                return;
            }
            if (!dragging) return;
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            tx += dx; ty += dy;
            targetTx += dx; targetTy += dy; // 目標値も一緒に移動
            lastX = e.clientX; lastY = e.clientY;
            needRedraw = true;
        }
        function onPointerUp(e: PointerEvent) {
            if (selecting) {
                // 選択確定：スクリーン→ワールドに変換して矩形算出
                const { x: x1, y: y1 } = screenToWorld(selStartSX, selStartSY);
                const { x: x2, y: y2 } = screenToWorld(selCurSX, selCurSY);
                const rx = Math.min(x1, x2);
                const ry = Math.min(y1, y2);
                const rw = Math.abs(x1 - x2);
                const rh = Math.abs(y1 - y2);

                const inRect = (n: Note) => (n.x >= rx && n.y >= ry && (n.x + n.w) <= (rx + rw) && (n.y + n.h) <= (ry + rh));
                const texts = notes.filter(inRect).map(n => n.text);

                selectionStateRef.current.worldRect = { x: rx, y: ry, w: rw, h: rh };
                selectionStateRef.current.texts = texts;
                updateSelectionInfo();

                // ログ出力（必要に応じて）
                try {
                    // eslint-disable-next-line no-console
                    console.log({ range: selectionStateRef.current.worldRect, texts });
                } catch { /* noop */ }

                selecting = false;
                canvas!.releasePointerCapture(e.pointerId);
                needRedraw = true;
                return;
            }

            dragging = false;
            canvas!.releasePointerCapture(e.pointerId);
        }
        function onDblClick() {
            fitToView();
        }
        function onKey(e: KeyboardEvent) {
            if (e.key === "r" || e.key === "R") fitToView();
        }

        canvas!.addEventListener("wheel", onWheel, { passive: false });
        canvas!.addEventListener("pointerdown", onPointerDown);
        globalThis.addEventListener("pointermove", onPointerMove);
        globalThis.addEventListener("pointerup", onPointerUp);
        canvas!.addEventListener("dblclick", onDblClick);
        globalThis.addEventListener("resize", () => { resize(); needRedraw = true; });
        const onVvResize = () => { resize(); };
        const onVvScroll = () => { resize(); };
        globalThis.visualViewport?.addEventListener("resize", onVvResize);
        globalThis.visualViewport?.addEventListener("scroll", onVvScroll);
        globalThis.addEventListener("keydown", onKey);

        // ======= 描画 =======
        function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

        function draw() {
            const rect = parent!.getBoundingClientRect();
            const cssW = Math.max(1, Math.round(rect.width));
            const cssH = Math.max(1, Math.round(rect.height));
            // 背景
            ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx!.clearRect(0, 0, cssW, cssH);
            // グリッド風の微妙な背景
            ctx!.fillStyle = "#fafafa";
            ctx!.fillRect(0, 0, cssW, cssH);

            // スムーズに target* へ補間
            const sDiff = targetScale - scale;
            const xDiff = targetTx - tx;
            const yDiff = targetTy - ty;

            if (Math.abs(sDiff) > 1e-4 || Math.abs(xDiff) > 0.5 || Math.abs(yDiff) > 0.5) {
                const k = 0.25; // easing 係数
                scale += sDiff * k;
                tx += xDiff * k;
                ty += yDiff * k;
                needRedraw = true;
            } else {
                scale = targetScale;
                tx = targetTx;
                ty = targetTy;
            }

            // 可視ワールド矩形（カリング用）
            const viewL = (0 - tx) / scale;
            const viewT = (0 - ty) / scale;
            const viewR = (cssW - tx) / scale;
            const viewB = (cssH - ty) / scale;

            // World変換
            ctx!.setTransform(scale * dpr, 0, 0, scale * dpr, tx * dpr, ty * dpr);

            // テキスト表示判定（付箋のスクリーン上幅で判定）
            const screenNoteW = NOTE_SIZE * scale;
            const showText = screenNoteW >= 80;

            let visibleCount = 0;

            // 元デモと同じ描画（角丸・影なし、矩形+複数行テキスト）
            for (const n of notes) {
                if (n.x > viewR || n.x + n.w < viewL || n.y > viewB || n.y + n.h < viewT) continue;
                visibleCount++;

                // 背景矩形
                ctx!.fillStyle = n.color;
                ctx!.fillRect(n.x, n.y, n.w, n.h);

                if (showText) {
                    const pad = 8;
                    ctx!.fillStyle = "#3a3a3a";
                    const fontPx = 12;
                    const lineHeight = fontPx * 1.2;
                    ctx!.font = `${fontPx}px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto`;
                    ctx!.textBaseline = "top";
                    const maxW = n.w - pad * 2;
                    const maxH = n.h - pad * 2;
                    const maxLines = Math.floor(maxH / lineHeight);

                    if (maxLines > 0) {
                        const words = n.text.split(/\s+/);
                        const lines: string[] = [];
                        let currentLine = "";

                        for (const word of words) {
                            const testLine = currentLine ? currentLine + " " + word : word;
                            const testWidth = ctx!.measureText(testLine).width;

                            if (testWidth <= maxW) {
                                currentLine = testLine;
                            } else {
                                if (currentLine) {
                                    lines.push(currentLine);
                                    currentLine = word;
                                } else {
                                    // 単語が1行に入らない場合は文字単位で分割
                                    let charLine = "";
                                    for (const char of word) {
                                        const testChar = charLine + char;
                                        if (ctx!.measureText(testChar).width <= maxW) {
                                            charLine = testChar;
                                        } else {
                                            if (charLine) {
                                                lines.push(charLine);
                                                charLine = char;
                                            } else {
                                                lines.push(char);
                                                break;
                                            }
                                        }
                                    }
                                    currentLine = charLine;
                                }
                            }

                            if (lines.length >= maxLines) break;
                        }

                        if (currentLine && lines.length < maxLines) {
                            lines.push(currentLine);
                        }

                        // 最後の行が省略される場合は「…」を追加
                        if (lines.length === maxLines && (lines.join(" ").length < n.text.length)) {
                            let lastLine = lines[lines.length - 1];
                            while (ctx!.measureText(lastLine + "…").width > maxW && lastLine.length > 0) {
                                lastLine = lastLine.slice(0, -1);
                            }
                            lines[lines.length - 1] = lastLine + "…";
                        }

                        for (let i = 0; i < lines.length; i++) {
                            ctx!.fillText(lines[i], n.x + pad, n.y + pad + i * lineHeight);
                        }
                    }
                }
            }

        // スクリーン座標に戻して HUD・選択枠描画
        ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

        // 選択中の矩形（スクリーン座標）
        if (selecting) {
            const x = Math.min(selStartSX, selCurSX);
            const y = Math.min(selStartSY, selCurSY);
            const w = Math.abs(selStartSX - selCurSX);
            const h = Math.abs(selStartSY - selCurSY);
            ctx!.save();
            ctx!.strokeStyle = "rgba(0,128,255,0.9)";
            ctx!.lineWidth = 1.5;
            ctx!.setLineDash([4, 3]);
            ctx!.strokeRect(x, y, w, h);
            ctx!.fillStyle = "rgba(0,128,255,0.15)";
            ctx!.fillRect(x, y, w, h);
            ctx!.restore();
        } else if (selectionStateRef.current.worldRect) {
            // 選択確定済みの矩形（閉じるまで表示）
            const r = selectionStateRef.current.worldRect;
            const x = r!.x * scale + tx;
            const y = r!.y * scale + ty;
            const w = r!.w * scale;
            const h = r!.h * scale;
            ctx!.save();
            ctx!.strokeStyle = "rgba(0,128,255,0.9)";
            ctx!.lineWidth = 1.5;
            ctx!.setLineDash([4, 3]);
            ctx!.strokeRect(x, y, w, h);
            ctx!.fillStyle = "rgba(0,128,255,0.15)";
            ctx!.fillRect(x, y, w, h);
            ctx!.restore();
        }

            // HUD（右下）
            const hudPad = 12;
            const hudText = `zoom ${(scale).toFixed(2)}  |  visible ${visibleCount}`;
            ctx!.font = `12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace`;
            ctx!.textBaseline = "middle";
            const tw = ctx!.measureText(hudText).width + 16;
            const th = 24;
            ctx!.fillStyle = "rgba(0,0,0,0.5)";
            ctx!.fillRect(cssW - tw - hudPad, cssH - th - hudPad, tw, th);
            ctx!.fillStyle = "white";
            ctx!.fillText(hudText, cssW - tw - hudPad + 8, cssH - th - hudPad + th/2);
        }

        function loop() {
            if (needRedraw) {
                needRedraw = false;
                draw();
            }
            rafId = requestAnimationFrame(loop);
        }
        loop();

        // 初期オーバーレイ更新
        updateSelectionInfo();

        // クリーンアップ
        return () => {
            cancelAnimationFrame(rafId);
            canvas!.removeEventListener("wheel", onWheel);
            canvas!.removeEventListener("pointerdown", onPointerDown);
            globalThis.removeEventListener("pointermove", onPointerMove);
            globalThis.removeEventListener("pointerup", onPointerUp);
            canvas!.removeEventListener("dblclick", onDblClick);
            globalThis.removeEventListener("keydown", onKey);
            globalThis.visualViewport?.removeEventListener("resize", onVvResize);
            globalThis.visualViewport?.removeEventListener("scroll", onVvScroll);
        };
    }, []);

    function copySelectionToClipboard() {
        const data = selectionStateRef.current;
        const json = JSON.stringify({ range: data.worldRect, texts: data.texts }, null, 2);
        if (typeof navigator !== 'undefined' && (navigator as any).clipboard?.writeText) {
            (navigator as any).clipboard.writeText(json).catch(() => { /* noop */ });
        }
    }

    function clearSelection() {
        selectionStateRef.current.worldRect = null;
        selectionStateRef.current.texts = [];
        updateSelectionInfo();
        // キャンバス再描画（選択枠を消す）
        redrawRef.current?.();
    }

    return (
        <div ref={containerRef} className="fixed inset-0 bg-white overflow-hidden touch-none">
            <canvas ref={canvasRef} className="block w-full h-full" />
            {/* ズームコントローラ */}
            <div className="absolute right-3 top-3 z-10 pointer-events-auto">
                <div className="flex flex-col items-center gap-1 bg-white/90 backdrop-blur rounded-lg shadow-lg p-1">
                    <button
                        type="button"
                        aria-label="ズームイン"
                        onClick={() => controlsRef.current.zoomIn()}
                        className="w-10 h-10 rounded-md border border-gray-300 hover:bg-gray-100 active:scale-95 flex items-center justify-center text-lg font-bold text-gray-700"
                    >
                        +
                    </button>
                    <button
                        type="button"
                        aria-label="ズームアウト"
                        onClick={() => controlsRef.current.zoomOut()}
                        className="w-10 h-10 rounded-md border border-gray-300 hover:bg-gray-100 active:scale-95 flex items-center justify-center text-lg font-bold text-gray-700"
                    >
                        −
                    </button>
                </div>
            </div>
            {/* 操作ヘルプ */}
            <div ref={overlayRef} className="pointer-events-none absolute left-3 top-3 text-sm text-gray-700 bg-white/80 backdrop-blur rounded-xl shadow p-3">
                <div className="font-medium">操作</div>
                <ul className="list-disc pl-5">
                    <li>右上のボタン：ズーム（＋／−）</li>
                    <li>ホイール：ズーム（カーソル中心）</li>
                    <li>ドラッグ：パン</li>
                    <li>Shift+ドラッグ：範囲選択</li>
                    <li>ダブルクリック / R：全体表示にリセット</li>
                </ul>
            </div>
            {/* 選択情報の表示とコピー */}
            <div ref={selectionInfoRef} className="absolute left-3 bottom-3 z-10 pointer-events-auto bg-white/90 backdrop-blur rounded-xl shadow p-3 w-[min(560px,calc(100vw-24px))] max-h-[40vh] overflow-auto">
                <div className="flex items-center gap-2">
                    <div className="font-medium">選択情報</div>
                    <div data-role="summary" className="text-xs text-gray-600">範囲未選択</div>
                    <div className="flex-1" />
                    <button type="button" onClick={copySelectionToClipboard} className="text-xs px-2 py-1 border rounded hover:bg-gray-100">JSONをコピー</button>
                    <button type="button" onClick={clearSelection} className="text-xs px-2 py-1 border rounded hover:bg-gray-100">閉じる</button>
                </div>
                <pre data-role="json" className="mt-2 text-xs whitespace-pre-wrap break-words" />
            </div>
        </div>
    );
}
