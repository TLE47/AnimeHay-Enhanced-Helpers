// ==UserScript==
// @name         AnimeHay Poster Enhance
// @version      1.0
// @updateURL    https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_posterEnhance.user.js
// @downloadURL  https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_posterEnhance.user.js
// @description  Sharpens and enhances low-quality anime poster images on AnimeHay
// @author       TLE47
// @include      /.*animehay.*/
// @exclude      *://github.com/*
// @exclude      *://*.github.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ─── Config ───────────────────────────────────────────────────────────────
    // Enable canvas-based sharpening (more CPU, better result).
    // Users who prefer pure-CSS can set this to false in GM storage.
    const USE_CANVAS = GM_getValue('posterEnhance_canvas', true);

    // 3×3 unsharp / sharpen kernel:  [0,-1,0 | -1,5,-1 | 0,-1,0]
    const KERNEL = [0, -1, 0, -1, 5, -1, 0, -1, 0];

    // ─── Phase 1: CSS (zero-latency GPU layer) ────────────────────────────────
    // Applied globally so every poster — even ones not yet in the DOM — gets
    // the GPU-accelerated baseline the moment the browser paints them.
    GM_addStyle(`
        .mc__poster img,
        .mc__poster .lazyload,
        .mc__poster .lazyloaded {
            image-rendering: -webkit-optimize-contrast;
            image-rendering: crisp-edges;
            filter: contrast(1.08) brightness(1.03) saturate(1.06);
            transform: translateZ(0);          /* force GPU compositing layer */
            backface-visibility: hidden;       /* further GPU hint             */
            box-shadow: 0 2px 8px rgba(0,0,0,0.18), 0 0 1px rgba(0,0,0,0.08);
            border-radius: 4px;
            transition: filter 0.2s, transform 0.2s;
        }
        /* Subtle hover lift to make posters feel polished */
        .mc__poster:hover img,
        .mc__poster:hover .lazyloaded {
            filter: contrast(1.12) brightness(1.05) saturate(1.1);
            transform: translateZ(0) scale(1.03);
        }
    `);

    // ─── Phase 2: Canvas sharpening kernel ───────────────────────────────────
    // Draws the image off-screen, runs a 3×3 convolution, then swaps the src.
    // We mark each image with data-pe="1" so we never double-process.

    function applyConvolution(img) {
        if (!USE_CANVAS) return;
        if (img.dataset.pe) return;         // already processed
        if (!img.complete || !img.naturalWidth) return;

        img.dataset.pe = '1';

        const W = img.naturalWidth;
        const H = img.naturalHeight;

        // Skip tiny icons / placeholders
        if (W < 50 || H < 50) return;

        try {
            const canvas = document.createElement('canvas');
            canvas.width = W;
            canvas.height = H;
            const ctx = canvas.getContext('2d');

            ctx.drawImage(img, 0, 0, W, H);

            const src = ctx.getImageData(0, 0, W, H);
            const dst = ctx.createImageData(W, H);
            const s = src.data, d = dst.data;

            // Convolution loop (skip 1-pixel border to keep it simple)
            for (let y = 1; y < H - 1; y++) {
                for (let x = 1; x < W - 1; x++) {
                    const i = (y * W + x) * 4;
                    let r = 0, g = 0, b = 0;

                    for (let ky = -1; ky <= 1; ky++) {
                        for (let kx = -1; kx <= 1; kx++) {
                            const ki = (ky + 1) * 3 + (kx + 1);
                            const pi = ((y + ky) * W + (x + kx)) * 4;
                            const w = KERNEL[ki];
                            r += s[pi]     * w;
                            g += s[pi + 1] * w;
                            b += s[pi + 2] * w;
                        }
                    }

                    d[i]     = Math.max(0, Math.min(255, r));
                    d[i + 1] = Math.max(0, Math.min(255, g));
                    d[i + 2] = Math.max(0, Math.min(255, b));
                    d[i + 3] = s[i + 3]; // preserve alpha
                }
            }

            // Copy border rows/cols directly (no convolution artefact)
            for (let x = 0; x < W; x++) {
                for (const y of [0, H - 1]) {
                    const i = (y * W + x) * 4;
                    d[i] = s[i]; d[i+1] = s[i+1]; d[i+2] = s[i+2]; d[i+3] = s[i+3];
                }
            }
            for (let y = 0; y < H; y++) {
                for (const x of [0, W - 1]) {
                    const i = (y * W + x) * 4;
                    d[i] = s[i]; d[i+1] = s[i+1]; d[i+2] = s[i+2]; d[i+3] = s[i+3];
                }
            }

            ctx.putImageData(dst, 0, 0);

            // Replace src — use WebP if supported for smaller data URIs
            const mime = canvas.toDataURL('image/webp').startsWith('data:image/webp')
                ? 'image/webp' : 'image/jpeg';
            img.src = canvas.toDataURL(mime, 0.92);
        } catch (_) {
            // Cross-origin images will throw on getImageData — silently fall
            // back to the CSS-only enhancement already applied via GM_addStyle.
            img.dataset.pe = 'css-only';
        }
    }

    // ─── Phase 3: Enhance one poster element ──────────────────────────────────
    function enhancePoster(img) {
        if (img.dataset.pe) return;

        // If the image is already loaded, process immediately
        if (img.complete && img.naturalWidth) {
            applyConvolution(img);
        } else {
            // Otherwise wait for it
            img.addEventListener('load', () => applyConvolution(img), { once: true });
        }
    }

    // ─── Phase 4: Scan all current posters ───────────────────────────────────
    function scanAll() {
        document.querySelectorAll('.mc__poster img').forEach(enhancePoster);
    }

    // ─── Phase 5: MutationObserver for lazy-loaded / SPA-injected posters ─────
    // We observe the whole body but filter down to only poster images.
    const obs = new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue; // elements only

                // The added node itself might be an img inside .mc__poster
                if (node.matches?.('.mc__poster img')) {
                    enhancePoster(node);
                } else {
                    // Or a container holding posters (e.g. a card block)
                    node.querySelectorAll?.('.mc__poster img').forEach(enhancePoster);
                }
            }
        }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // ─── Phase 6: IntersectionObserver for lazy-src swaps ────────────────────
    // Some lazy loaders don't mutate the DOM; they just swap `src` when the
    // image scrolls into view.  We watch for `src` attribute changes too.
    const attrObs = new MutationObserver(mutations => {
        for (const m of mutations) {
            if (m.type === 'attributes' && m.attributeName === 'src') {
                const img = m.target;
                if (img.closest('.mc__poster')) {
                    img.dataset.pe = ''; // reset so we re-process new src
                    enhancePoster(img);
                }
            }
        }
    });
    // Attach attrObs only to existing poster images (new ones caught by obs above)
    document.querySelectorAll('.mc__poster img').forEach(img => {
        attrObs.observe(img, { attributes: true, attributeFilter: ['src'] });
    });

    // ─── Boot ─────────────────────────────────────────────────────────────────
    scanAll();

})();
