// ==UserScript==
// @name         AnimeHay Poster Enhance
// @version      1.1
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
        /* ── Baseline enhancement for every poster image ── */
        .mc__poster img {
            /* Subtle contrast/saturation lift — keeps colours accurate */
            filter:
                contrast(1.1)
                brightness(1.04)
                saturate(1.12)
                drop-shadow(0 2px 6px rgba(0,0,0,0.35));

            /* Force GPU compositing layer for smooth rendering */
            transform: translateZ(0);
            backface-visibility: hidden;
            will-change: filter, transform;

            /* Crisp upscale hint for small source images */
            image-rendering: -webkit-optimize-contrast;

            border-radius: 5px;
            transition: filter 0.25s ease, transform 0.25s ease;
        }

        /* ── Hover: lift + slight colour pop ── */
        .mc__poster:hover img {
            filter:
                contrast(1.14)
                brightness(1.07)
                saturate(1.18)
                drop-shadow(0 6px 14px rgba(0,0,0,0.5));
            transform: translateZ(0) scale(1.04);
            z-index: 2;
            position: relative;
        }

        /* ── Wrapper tweak: clip overflow so scale doesn't spill ── */
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
