import { useEffect, useRef, useState } from "react";

// 単一ファイル・依存ライブラリなしのデモ
// ・Canvas2Dで1万枚の付箋を仮想スクロール/ズーム
// ・LOD（レベル・オブ・ディテール）で遠景は点/矩形、近景で角丸+影+テキスト
// ・可視領域だけを描画（カリング）
// ・ホイールでズーム（カーソル中心）、ドラッグでパン、ダブルクリック/キーRでリセット
// ※さらに大規模にしたい場合はWebGL(PixiJS)やタイル化/オフスクリーンなどを検討

export default function StickyNotesZoomDemo() {
    const canvasRef = useRef(null);
    const overlayRef = useRef(null);
    const controlsRef = useRef({ 
        setZoomCenter: (_z: number) => { }, 
        zoomIn: () => { }, 
        zoomOut: () => { } 
    });
    const MIN_ZOOM = 0.05;
    const MAX_ZOOM = 6;
    // スライダー↔スケールの指数マッピング
    const scaleToSlider = (s: number) => {
        const t = Math.log(s / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM);
        return Math.round(Math.min(1, Math.max(0, t)) * 100);
    };
    const sliderToScale = (v: string) => {
        const t = Math.min(100, Math.max(0, Number(v))) / 100;
        return MIN_ZOOM * Math.pow(MAX_ZOOM / MIN_ZOOM, t);
    };
    const [info, setInfo] = useState({ zoom: 1, visible: 0 });

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const parent = canvas.parentElement;
        const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
        const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));

        // ======= データ生成（1万枚） =======
        const NOTES_X = 100;
        const NOTES_Y = 100;
        const NOTE_W = 180;
        const NOTE_H = 120;
        const GAP_X = 60;
        const GAP_Y = 40;
        const WORLD_W = NOTES_X * (NOTE_W + GAP_X);
        const WORLD_H = NOTES_Y * (NOTE_H + GAP_Y);

        interface Note {
            x: number;
            y: number;
            w: number;
            h: number;
            color: string;
            text: string;
        }
        const notes: Note[] = [];
        let id = 0;
        for (let gy = 0; gy < NOTES_Y; gy++) {
            for (let gx = 0; gx < NOTES_X; gx++) {
                const x = gx * (NOTE_W + GAP_X);
                const y = gy * (NOTE_H + GAP_Y);
                const hue = ((gx * 7 + gy * 11) % 360);
                const color = `hsl(${hue} 90% 85%)`;
                const text = `付箋 #${id} — ここに長文のメモ本文が入る想定。` +
                    " 課題・仮説・TODO・引用など。Zoomすると先頭行のみ表示。";
                notes.push({ x, y, w: NOTE_W, h: NOTE_H, color, text });
                id++;
            }
        }

        // ======= ビュートランスフォーム =======
        let scale = 1, targetScale = 1; // world→screen 拡大率
        let tx = 0, ty = 0;             // world→screen 平行移動
        let dragging = false;
        let lastX = 0, lastY = 0;
        let rafId = 0;
        let needRedraw = true;

        function fitToView() {
            const cssW = parent.clientWidth;
            const cssH = parent.clientHeight;
            const s = Math.min(cssW / WORLD_W, cssH / WORLD_H) * 0.92; // 少し余白
            targetScale = scale = s;
            tx = (cssW - WORLD_W * scale) / 2;
            ty = (cssH - WORLD_H * scale) / 2;
            needRedraw = true;
        }

        function resize() {
            const cssW = parent.clientWidth | 0;
            const cssH = parent.clientHeight | 0;
            canvas.width = Math.max(1, cssW * dpr);
            canvas.height = Math.max(1, cssH * dpr);
            canvas.style.width = cssW + "px";
            canvas.style.height = cssH + "px";
            needRedraw = true;
        }

        // 初期リサイズ & フィット
        resize();
        fitToView();

        // ======= 入力イベント =======
        function screenToWorld(sx: number, sy: number, s = scale, ox = tx, oy = ty) {
            return { x: (sx - ox) / s, y: (sy - oy) / s };
        }

        // スライダー/ボタンからのズーム適用（Google Maps風：中心基準）
        function setZoomAt(newScale: number, mx: number, my: number) {
            const before = screenToWorld(mx, my);
            targetScale = clamp(newScale, MIN_ZOOM, MAX_ZOOM);
            tx = mx - before.x * targetScale;
            ty = my - before.y * targetScale;
            needRedraw = true;
        }
        controlsRef.current.setZoomCenter = (newScale: number) => {
            const cssW = canvas.width / dpr;
            const cssH = canvas.height / dpr;
            setZoomAt(newScale, cssW * 0.5, cssH * 0.5);
        };
        controlsRef.current.zoomIn = () => {
            controlsRef.current.setZoomCenter(targetScale * Math.pow(2, 0.2));
        };
        controlsRef.current.zoomOut = () => {
            controlsRef.current.setZoomCenter(targetScale / Math.pow(2, 0.2));
        };

        function onWheel(e: WheelEvent) {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            
            // ズーム前のワールド座標
            const worldX = (mouseX - tx) / scale;
            const worldY = (mouseY - ty) / scale;
            
            // 新しいスケール
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            const newScale = clamp(scale * delta, MIN_ZOOM, MAX_ZOOM);
            
            // マウス位置を固定点として平行移動を調整
            tx = mouseX - worldX * newScale;
            ty = mouseY - worldY * newScale;
            
            scale = targetScale = newScale;
            needRedraw = true;
        }

        function onPointerDown(e: PointerEvent) {
            dragging = true;
            lastX = e.clientX; lastY = e.clientY;
            canvas.setPointerCapture(e.pointerId);
        }
        function onPointerMove(e: PointerEvent) {
            if (!dragging) return;
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            tx += dx; ty += dy;
            lastX = e.clientX; lastY = e.clientY;
            needRedraw = true;
        }
        function onPointerUp(e: PointerEvent) {
            dragging = false;
            canvas.releasePointerCapture(e.pointerId);
        }
        function onDblClick() {
            fitToView();
        }
        function onKey(e: KeyboardEvent) {
            if (e.key === "r" || e.key === "R") fitToView();
        }

        canvas.addEventListener("wheel", onWheel, { passive: false });
        canvas.addEventListener("pointerdown", onPointerDown);
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        canvas.addEventListener("dblclick", onDblClick);
        window.addEventListener("resize", () => { resize(); needRedraw = true; });
        window.addEventListener("keydown", onKey);

        // ======= 描画 =======
        function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

        function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
            const rr = Math.min(r, w * 0.5, h * 0.5);
            ctx.beginPath();
            ctx.moveTo(x + rr, y);
            ctx.lineTo(x + w - rr, y);
            ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
            ctx.lineTo(x + w, y + h - rr);
            ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
            ctx.lineTo(x + rr, y + h);
            ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
            ctx.lineTo(x, y + rr);
            ctx.quadraticCurveTo(x, y, x + rr, y);
            ctx.closePath();
        }

        function draw() {
            const cssW = canvas.width / dpr;
            const cssH = canvas.height / dpr;
            // 背景
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, cssW, cssH);
            // グリッド風の微妙な背景
            ctx.fillStyle = "#fafafa";
            ctx.fillRect(0, 0, cssW, cssH);

            // スムーズにtargetScaleへ補間
            const diff = targetScale - scale;
            if (Math.abs(diff) > 1e-4) {
                scale += diff * 0.15; // easing
                needRedraw = true;
            } else {
                scale = targetScale;
            }

            // 可視ワールド矩形（カリング用）
            const viewL = (0 - tx) / scale;
            const viewT = (0 - ty) / scale;
            const viewR = (cssW - tx) / scale;
            const viewB = (cssH - ty) / scale;

            // World変換
            ctx.setTransform(scale * dpr, 0, 0, scale * dpr, tx * dpr, ty * dpr);

            // LOD判定（付箋のスクリーン上幅で目安）
            const screenNoteW = NOTE_W * scale;
            // LOD0: とても遠い（点）  LOD1: 小矩形  LOD2: 角丸  LOD3: 角丸+影+テキスト
            let lod = 0;
            if (screenNoteW < 6) lod = 0; else if (screenNoteW < 24) lod = 1; else if (screenNoteW < 110) lod = 2; else lod = 3;

            let visibleCount = 0;

            if (lod === 0) {
                // 点描画（超遠景・速い）
                ctx.fillStyle = "#cfcfcf";
                ctx.beginPath();
                for (const n of notes) {
                    if (n.x > viewR || n.x + NOTE_W < viewL || n.y > viewB || n.y + NOTE_H < viewT) continue;
                    visibleCount++;
                    ctx.rect(n.x + NOTE_W * 0.5, n.y + NOTE_H * 0.5, 1 / scale, 1 / scale);
                }
                ctx.fill();
            } else if (lod === 1) {
                // 小さな塗り矩形（影なし・高速）
                for (const n of notes) {
                    if (n.x > viewR || n.x + NOTE_W < viewL || n.y > viewB || n.y + NOTE_H < viewT) continue;
                    visibleCount++;
                    ctx.fillStyle = n.color;
                    ctx.fillRect(n.x, n.y, NOTE_W, NOTE_H);
                }
            } else {
                // 角丸（LOD2/3）
                const radius = 12;
                for (const n of notes) {
                    if (n.x > viewR || n.x + NOTE_W < viewL || n.y > viewB || n.y + NOTE_H < viewT) continue;
                    visibleCount++;
                    if (lod === 3) {
                        ctx.shadowColor = "rgba(0,0,0,0.15)";
                        ctx.shadowBlur = 8;
                        ctx.shadowOffsetY = 4;
                    } else {
                        ctx.shadowColor = "transparent";
                        ctx.shadowBlur = 0;
                        ctx.shadowOffsetY = 0;
                    }
                    roundedRectPath(ctx, n.x, n.y, NOTE_W, NOTE_H, radius);
                    ctx.fillStyle = n.color;
                    ctx.fill();

                    // 折り返し（付箋っぽい角）
                    if (lod >= 2) {
                        const fold = Math.min(18, NOTE_W * 0.12);
                        ctx.beginPath();
                        ctx.moveTo(n.x + NOTE_W - fold, n.y);
                        ctx.lineTo(n.x + NOTE_W, n.y);
                        ctx.lineTo(n.x + NOTE_W, n.y + fold);
                        ctx.closePath();
                        ctx.fillStyle = "rgba(255,255,255,0.75)";
                        ctx.fill();
                    }

                    if (lod === 3) {
                        // テキスト（先頭行のみ）
                        const pad = 14;
                        ctx.shadowColor = "transparent";
                        ctx.fillStyle = "#3a3a3a";
                        const fontPx = 14;
                        ctx.font = `${fontPx}px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto`;
                        ctx.textBaseline = "top";
                        const maxW = NOTE_W - pad * 2;
                        // 先頭行を切り詰め
                        let line = n.text;
                        while (ctx.measureText(line).width > maxW) {
                            line = line.slice(0, Math.max(0, line.length - 4));
                            if (line.length <= 4) break;
                        }
                        if (line !== n.text) line = line.slice(0, Math.max(0, line.length - 1)) + "…";
                        ctx.fillText(line, n.x + pad, n.y + pad);
                    }
                }
            }

            // HUD（スクリーン座標に戻す）
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            // 右下にスケールと可視枚数
            const hudPad = 12;
            const hudText = `zoom ${(scale).toFixed(2)}  |  visible ${visibleCount}`;
            ctx.font = `12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace`;
            const tw = ctx.measureText(hudText).width + 16;
            const th = 24;
            ctx.fillStyle = "rgba(0,0,0,0.5)";
            ctx.fillRect(cssW - tw - hudPad, cssH - th - hudPad, tw, th);
            ctx.fillStyle = "white";
            ctx.fillText(hudText, cssW - tw - hudPad + 8, cssH - th - hudPad + 6);

            setInfo((prev) => (prev.zoom !== scale || prev.visible !== visibleCount) ? { zoom: scale, visible: visibleCount } : prev);
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
            canvas.removeEventListener("wheel", onWheel);
            canvas.removeEventListener("pointerdown", onPointerDown);
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
            canvas.removeEventListener("dblclick", onDblClick);
            window.removeEventListener("keydown", onKey);
        };
    }, []);

    return (
        <div className="w-full h-[80vh] relative bg-white">
            <canvas ref={canvasRef} className="block w-full h-full" />
            {/* Google Map的ズームコントローラ */}
            <div className="absolute right-3 top-3 z-10 pointer-events-auto">
                <div className="flex flex-col items-center gap-2 bg-white/80 backdrop-blur rounded-xl shadow p-2">
                    <button type="button" aria-label="ズームイン" onClick={() => controlsRef.current.zoomIn()} className="w-8 h-8 rounded-lg border border-gray-300 hover:bg-gray-100 active:scale-95">+</button>
                    <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={scaleToSlider(info.zoom)}
                        onChange={(e) => controlsRef.current.setZoomCenter(sliderToScale(e.target.value))}
                        className="w-40 h-4 -rotate-90 origin-center"
                    />
                    <button type="button" aria-label="ズームアウト" onClick={() => controlsRef.current.zoomOut()} className="w-8 h-8 rounded-lg border border-gray-300 hover:bg-gray-100 active:scale-95">-</button>
                </div>
            </div>
            <div ref={overlayRef} className="pointer-events-none absolute left-3 top-3 text-sm text-gray-700 bg-white/80 backdrop-blur rounded-xl shadow p-3">
                <div className="font-medium">操作</div>
                <ul className="list-disc pl-5">
                    <li>右上のスライダー：ズーム（＋／−）</li>
                    <li>ホイール：ズーム（カーソル中心）</li>
                    <li>ドラッグ：パン</li>
                    <li>ダブルクリック / R：全体表示にリセット</li>
                </ul>
            </div>
        </div>
    );
}
