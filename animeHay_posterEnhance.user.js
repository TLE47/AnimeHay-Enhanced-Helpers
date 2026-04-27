// ==UserScript==
// @name         AnimeHay Poster Enhance
// @version      1.3
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

    // ─── SVG Unsharp Mask Filter ──────────────────────────────────────────────
    // feConvolveMatrix runs inside the browser's SVG rendering pipeline in
    // linearRGB space.  Unlike the canvas pixel approach, it cannot clip colours
    // to grey because the math is done before gamma is re-applied.
    //
    // Kernel (3×3):
    //   0   -0.18   0
    // -0.18  1.72 -0.18
    //   0   -0.18   0
    //
    // Kernel sum = 1.72 - 4×0.18 = 1.0  →  net brightness is preserved exactly.
    // This is a conservative unsharp mask: enough to visually "pop" details
    // without haloing.  preserveAlpha="true" leaves the alpha channel untouched.

    const NS = 'http://www.w3.org/2000/svg';
    const svgEl = document.createElementNS(NS, 'svg');
    svgEl.setAttribute('xmlns', NS);
    svgEl.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;';
    svgEl.innerHTML = `
        <defs>
            <filter id="pe-usm" x="0" y="0" width="100%" height="100%"
                    color-interpolation-filters="linearRGB">
                <feConvolveMatrix
                    order="3"
                    kernelMatrix="0 -0.18 0  -0.18 1.72 -0.18  0 -0.18 0"
                    preserveAlpha="true"/>
            </filter>
        </defs>
    `;
    document.body.appendChild(svgEl);

    // ─── CSS Layer ────────────────────────────────────────────────────────────
    // The SVG filter handles actual edge sharpening.
    // CSS handles tone: darker (brightness 0.96) + wide dynamic range
    // (contrast 1.28) to simulate the look of a properly mastered HD image.
    // saturate(1.12) brings back the vividness that lower brightness slightly
    // reduces, without over-punching colours.
    GM_addStyle(`
        /* ── Full-HD-like: real unsharp mask + tone correction ── */
        .mc__poster img {
            /* SVG unsharp mask — colour-safe edge sharpening */
            filter:
                url(#pe-usm)
                contrast(1.28)
                brightness(0.96)
                saturate(1.12)
                drop-shadow(0 3px 7px rgba(0,0,0,0.45));

            /* Nearest-neighbour hint keeps pixel edges crisp (no blurry upscale) */
            image-rendering: -webkit-optimize-contrast;

            /* GPU compositing */
            transform: translateZ(0);
            backface-visibility: hidden;
            will-change: filter, transform;

            border-radius: 4px;
            transition: filter 0.2s ease, transform 0.2s ease;
        }

        /* ── Hover: tighter sharpness + slight brightness recovery ── */
        .mc__poster:hover img {
            filter:
                url(#pe-usm)
                contrast(1.34)
                brightness(0.98)
                saturate(1.16)
                drop-shadow(0 6px 14px rgba(0,0,0,0.6));
            transform: translateZ(0) scale(1.04);
            z-index: 2;
            position: relative;
        }

        /* ── Let scale not get clipped ── */
        .mc__poster {
            overflow: visible !important;
        }
    `);

    // ─── MutationObserver: handle lazy-loaded / SPA-injected images ──────────
    // The SVG filter is referenced by id so it applies to any image the browser
    // renders with that CSS, including ones added after page load.

    const obs = new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                // Nothing to do per-image; CSS + SVG handle it automatically.
                // Observer here only ensures the SVG node stays first in body
                // (some sites clear/re-render the body on SPA nav).
                if (!document.getElementById('pe-usm')) {
                    document.body.insertBefore(svgEl, document.body.firstChild);
                }
            }
        }
    });
    obs.observe(document.body, { childList: true });

})();
