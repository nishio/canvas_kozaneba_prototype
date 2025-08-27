import { useEffect, useRef } from "react";
import type { Note, HierarchicalResult } from './types';

// 単一ファイル・依存ライブラリなしのデモ
// ・Canvas2Dで1万枚の付箋を仮想スクロール/ズーム
// ・LOD（レベル・オブ・ディテール）で遠景は点/矩形、近景で角丸+影+テキスト
// ・可視領域だけを描画（カリング）
// ・ホイールでズーム（カーソル中心）、ドラッグでパン、ダブルクリック/キーRでリセット
// ※さらに大規模にしたい場合はWebGL(PixiJS)やタイル化/オフスクリーンなどを検討

export default function StickyNotesZoomDemo() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const overlayRef = useRef<HTMLDivElement>(null);
    const controlsRef = useRef({
        setZoomCenter: (_z: number) => { },
        zoomIn: () => { },
        zoomOut: () => { }
    });
    let MIN_ZOOM = 0.01; // 初期化後に実際の値に更新される
    const MAX_ZOOM = 1.5;


    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const parent = canvas.parentElement;
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
                    };
                });

                // 格子点の重複を解決
                const occupiedGrids = new Set<string>();
                const distributedNotes = [];

                for (const note of tempNotes) {
                    let finalGridX = note.gridX;
                    let finalGridY = note.gridY;

                    // 螺旋状に近い空きグリッドを探す
                    let found = false;
                    for (let radius = 0; radius < 20 && !found; radius++) {
                        for (let dx = -radius; dx <= radius && !found; dx++) {
                            for (let dy = -radius; dy <= radius && !found; dy++) {
                                if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;

                                const testX = note.originalGridX + dx;
                                const testY = note.originalGridY + dy;
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
                        color: note.color,
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
        let dragging = false;
        let lastX = 0, lastY = 0;
        let rafId = 0;
        let needRedraw = true;

        function fitToView() {
            const cssW = parent!.clientWidth;
            const cssH = parent!.clientHeight;
            const s = Math.min(cssW / WORLD_W, cssH / WORLD_H) * 0.92; // 少し余白
            MIN_ZOOM = s; // MIN_ZOOMを初期表示に合わせる
            targetScale = scale = s;
            tx = (cssW - WORLD_W * scale) / 2;
            ty = (cssH - WORLD_H * scale) / 2;
            targetTx = tx;
            targetTy = ty;
            needRedraw = true;
        }

        function resize() {
            const cssW = parent!.clientWidth | 0;
            const cssH = parent!.clientHeight | 0;
            canvas!.width = Math.max(1, cssW * dpr);
            canvas!.height = Math.max(1, cssH * dpr);
            canvas!.style.width = cssW + "px";
            canvas!.style.height = cssH + "px";
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
            dragging = true;
            lastX = e.clientX; lastY = e.clientY;
            canvas!.setPointerCapture(e.pointerId);
        }
        function onPointerMove(e: PointerEvent) {
            if (!dragging) return;
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            tx += dx; ty += dy;
            targetTx += dx; targetTy += dy; // 目標値も一緒に移動
            lastX = e.clientX; lastY = e.clientY;
            needRedraw = true;
        }
        function onPointerUp(e: PointerEvent) {
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
        globalThis.addEventListener("keydown", onKey);

        // ======= 描画 =======
        function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }


        function draw() {
            const cssW = canvas!.width / dpr;
            const cssH = canvas!.height / dpr;
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

            // 矩形 + 条件付きテキスト表示
            for (const n of notes) {
                if (n.x > viewR || n.x + n.w < viewL || n.y > viewB || n.y + n.h < viewT) continue;
                visibleCount++;

                // 背景矩形
                ctx!.fillStyle = n.color;
                ctx!.fillRect(n.x, n.y, n.w, n.h);

                if (showText) {
                    // テキスト表示（複数行対応）
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

                        // 各行を描画
                        for (let i = 0; i < lines.length; i++) {
                            ctx!.fillText(lines[i], n.x + pad, n.y + pad + i * lineHeight);
                        }
                    }
                }
            }

            // HUD（スクリーン座標に戻す）
            ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
            // 右下にスケールと可視枚数
            const hudPad = 12;
            const hudText = `zoom ${(scale).toFixed(2)}  |  visible ${visibleCount}`;
            ctx!.font = `12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace`;
            const tw = ctx!.measureText(hudText).width + 16;
            const th = 24;
            ctx!.fillStyle = "rgba(0,0,0,0.5)";
            ctx!.fillRect(cssW - tw - hudPad, cssH - th - hudPad, tw, th);
            ctx!.fillStyle = "white";
            ctx!.fillText(hudText, cssW - tw - hudPad + 8, cssH - th - hudPad + 6);


        }

        function loop() {
            if (needRedraw) {
                needRedraw = false;
                draw();
            }
            rafId = requestAnimationFrame(loop);
        }
        loop();

        // クリーンアップ
        return () => {
            cancelAnimationFrame(rafId);
            canvas!.removeEventListener("wheel", onWheel);
            canvas!.removeEventListener("pointerdown", onPointerDown);
            globalThis.removeEventListener("pointermove", onPointerMove);
            globalThis.removeEventListener("pointerup", onPointerUp);
            canvas!.removeEventListener("dblclick", onDblClick);
            globalThis.removeEventListener("keydown", onKey);
        };
    }, []);

    return (
        <div className="w-full h-[80vh] relative bg-white">
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
            <div ref={overlayRef} className="pointer-events-none absolute left-3 top-3 text-sm text-gray-700 bg-white/80 backdrop-blur rounded-xl shadow p-3">
                <div className="font-medium">操作</div>
                <ul className="list-disc pl-5">
                    <li>右上のボタン：ズーム（＋／−）</li>
                    <li>ホイール：ズーム（カーソル中心）</li>
                    <li>ドラッグ：パン</li>
                    <li>ダブルクリック / R：全体表示にリセット</li>
                </ul>
            </div>
        </div>
    );
}
