// ==UserScript==
// @name         AnimeHay Poster Enhance
// @version      1.2
// @updateURL    https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_posterEnhance.user.js
// @downloadURL  https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_posterEnhance.user.js
// @description  Sharpens and enhances low-quality anime poster images on AnimeHay
// @author       TLE47
// @include      /.*animehay.*/
// @exclude      *://github.com/*
// @exclude      *://*.github.com/*
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ─── CSS Enhancement (GPU-accelerated, zero latency) ─────────────────────
    // CSS filters run on the browser's compositor thread — no pixel-level JS
    // manipulation needed. This is both faster and colour-accurate.
    //
    // Why not canvas + sharpen kernel?
    // The 3×3 kernel amplifies per-channel deltas so aggressively that RGB
    // values clip to 0 or 255, producing a grey edge-detection nightmare.
    // CSS `filter` delegates to the GPU's colour pipeline which preserves
    // the full colour gamut correctly.
    GM_addStyle(`
        /* ── Baseline: sharp pixel look, minimal brightness ── */
        .mc__poster img {
            /* Pixelated rendering kills bilinear smoothing → hard crisp edges */
            image-rendering: pixelated;
            image-rendering: -webkit-optimize-contrast; /* Chromium fallback */

            /* High contrast to make outlines/edges pop;
               brightness stays at 1.01 — barely-there lift, not washed out */
            filter:
                contrast(1.22)
                brightness(1.01)
                saturate(1.08)
                drop-shadow(0 2px 5px rgba(0,0,0,0.4));

            /* GPU layer */
            transform: translateZ(0);
            backface-visibility: hidden;
            will-change: filter, transform;

            border-radius: 4px;
            transition: filter 0.2s ease, transform 0.2s ease;
        }

        /* ── Hover: sharper pop, subtle scale ── */
        .mc__poster:hover img {
            filter:
                contrast(1.28)
                brightness(1.03)
                saturate(1.12)
                drop-shadow(0 5px 12px rgba(0,0,0,0.55));
            transform: translateZ(0) scale(1.04);
            z-index: 2;
            position: relative;
        }

        /* ── Allow scale without clipping ── */
        .mc__poster {
            overflow: visible !important;
        }
    `);

    // ─── MutationObserver: handle lazy-loaded / SPA-injected images ──────────
    // CSS above already covers any <img> matching .mc__poster img regardless
    // of when it was added, so the observer only needs to attach the
    // src-change watcher to new poster images (for lazy-loader src swaps).

    const attrObs = new MutationObserver(mutations => {
        for (const m of mutations) {
            // Watch for new img nodes appearing inside .mc__poster
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                const imgs = node.matches?.('.mc__poster img')
                    ? [node]
                    : [...(node.querySelectorAll?.('.mc__poster img') ?? [])];
                imgs.forEach(img => attrObs.observe(img, { attributes: true, attributeFilter: ['src'] }));
            }
        }
    });
    attrObs.observe(document.body, { childList: true, subtree: true });

})();
