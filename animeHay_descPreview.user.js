// ==UserScript==
// @name         AnimeHay Description Preview
// @version      1.0
// @updateURL    https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_descPreview.user.js
// @downloadURL  https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_descPreview.user.js
// @description  Hover a poster to preview the anime description without opening its page
// @author       TLE47
// @include      /.*animehay.*/
// @exclude      *://github.com/*
// @exclude      *://*.github.com/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      animehay01.site
// @connect      animehay.tv
// @connect      animehay.uno
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ─── In-memory cache (url → description text) ────────────────────────────
    const cache = new Map();

    // ─── CSS ─────────────────────────────────────────────────────────────────
    GM_addStyle(`
        /* Tooltip container */
        #ah-desc-popup {
            position: fixed;
            z-index: 2147483647;
            max-width: 320px;
            min-width: 220px;
            max-height: 260px;
            pointer-events: none;       /* never intercepts card hover */
            opacity: 0;
            transform: translateY(6px) scale(0.97);
            transition: opacity 0.18s ease, transform 0.18s ease;
            font-family: system-ui, -apple-system, sans-serif;
        }
        #ah-desc-popup.visible {
            opacity: 1;
            transform: translateY(0) scale(1);
        }

        /* Glass card */
        #ah-desc-inner {
            background: rgba(12, 12, 18, 0.92);
            backdrop-filter: blur(14px) saturate(1.4);
            -webkit-backdrop-filter: blur(14px) saturate(1.4);
            border: 1px solid rgba(255,255,255,0.10);
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.4);
            overflow: hidden;
            display: flex;
            flex-direction: column;
            max-height: 260px;
        }

        /* Header bar */
        #ah-desc-header {
            padding: 10px 14px 6px;
            background: rgba(255,255,255,0.04);
            border-bottom: 1px solid rgba(255,255,255,0.07);
            flex-shrink: 0;
        }
        #ah-desc-title {
            font-size: 12px;
            font-weight: 700;
            color: #e94560;
            letter-spacing: 0.02em;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        #ah-desc-label {
            font-size: 9px;
            color: rgba(255,255,255,0.35);
            margin-top: 1px;
            text-transform: uppercase;
            letter-spacing: 0.06em;
        }

        /* Scrollable body */
        #ah-desc-body {
            padding: 10px 14px 12px;
            overflow-y: auto;
            font-size: 12px;
            line-height: 1.65;
            color: rgba(230,230,240,0.88);
            scrollbar-width: thin;
            scrollbar-color: rgba(255,255,255,0.15) transparent;
            word-break: break-word;
        }
        #ah-desc-body::-webkit-scrollbar { width: 4px; }
        #ah-desc-body::-webkit-scrollbar-thumb {
            background: rgba(255,255,255,0.18);
            border-radius: 2px;
        }

        /* Loading shimmer */
        .ah-shimmer {
            height: 10px;
            border-radius: 4px;
            background: linear-gradient(90deg,
                rgba(255,255,255,0.05) 25%,
                rgba(255,255,255,0.12) 50%,
                rgba(255,255,255,0.05) 75%);
            background-size: 200% 100%;
            animation: ah-shimmer-anim 1.2s ease-in-out infinite;
            margin-bottom: 7px;
        }
        .ah-shimmer:last-child { width: 65%; }
        @keyframes ah-shimmer-anim {
            0%   { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }
    `);

    // ─── Build popup DOM ──────────────────────────────────────────────────────
    const popup = document.createElement('div');
    popup.id = 'ah-desc-popup';
    popup.innerHTML = `
        <div id="ah-desc-inner">
            <div id="ah-desc-header">
                <div id="ah-desc-title"></div>
                <div id="ah-desc-label">Mô tả · Synopsis</div>
            </div>
            <div id="ah-desc-body"></div>
        </div>`;
    document.body.appendChild(popup);

    const titleEl = popup.querySelector('#ah-desc-title');
    const bodyEl  = popup.querySelector('#ah-desc-body');

    // ─── Positioning ──────────────────────────────────────────────────────────
    const MARGIN = 14; // px gap from card edge

    function positionPopup(cardEl) {
        const rect  = cardEl.getBoundingClientRect();
        const pw    = popup.offsetWidth  || 320;
        const ph    = popup.offsetHeight || 260;
        const vw    = window.innerWidth;
        const vh    = window.innerHeight;

        // Prefer right side; fall back to left
        let left = rect.right + MARGIN;
        if (left + pw > vw - 8) left = rect.left - pw - MARGIN;
        left = Math.max(8, Math.min(left, vw - pw - 8));

        // Vertically center on card, clamp to viewport
        let top = rect.top + (rect.height - ph) / 2;
        top = Math.max(8, Math.min(top, vh - ph - 8));

        popup.style.left = left + 'px';
        popup.style.top  = top  + 'px';
    }

    // ─── Fetch description via GM (bypasses CORS) ─────────────────────────────
    function fetchDesc(url) {
        return new Promise((resolve) => {
            if (cache.has(url)) { resolve(cache.get(url)); return; }
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                onload(res) {
                    try {
                        const doc  = new DOMParser().parseFromString(res.responseText, 'text/html');
                        const desc = doc.getElementById('aim-desc-content');
                        const text = desc ? desc.innerText.trim() : null;
                        cache.set(url, text);
                        resolve(text);
                    } catch (_) { resolve(null); }
                },
                onerror() { resolve(null); },
            });
        });
    }

    // ─── Show / hide helpers ──────────────────────────────────────────────────
    function showLoading(title) {
        titleEl.textContent = title || '…';
        bodyEl.innerHTML = `
            <div class="ah-shimmer" style="width:100%"></div>
            <div class="ah-shimmer" style="width:85%"></div>
            <div class="ah-shimmer"></div>`;
        popup.classList.add('visible');
    }

    function showContent(title, text) {
        titleEl.textContent = title || '';
        bodyEl.textContent  = text  || '(Không có mô tả)';
        bodyEl.scrollTop    = 0;
        popup.classList.add('visible');
    }

    function hidePopup() {
        popup.classList.remove('visible');
    }

    // ─── State ────────────────────────────────────────────────────────────────
    let currentUrl  = null;   // URL being shown / loading
    let hideTimeout = null;   // debounce hide

    // ─── Event delegation on document ─────────────────────────────────────────
    // Listening at the document level means we catch posters inside any
    // dynamically injected container (infinite scroll, SPA navigation, etc.)

    document.addEventListener('mouseover', async (e) => {
        const overlay = e.target.closest('.mc__overlay');
        if (!overlay) return;

        // Find the outer movie-id-XXXX wrapper
        const card = overlay.closest('[class*="movie-id-"]');
        if (!card) return;

        // Grab the anime name and the info-page link
        const nameEl = card.querySelector('.mc_name, .mc__name');
        const linkEl = card.querySelector('a.mc__link, a[href*="thong-tin-phim"]');
        if (!linkEl) return;

        const animeName = nameEl?.textContent?.trim() || '?';
        const infoUrl   = linkEl.href;

        // Don't re-trigger if we're already showing this card
        if (infoUrl === currentUrl) return;
        currentUrl = infoUrl;

        clearTimeout(hideTimeout);

        showLoading(animeName);
        positionPopup(card);

        const desc = await fetchDesc(infoUrl);
        // Guard: user may have moved away while fetching
        if (currentUrl !== infoUrl) return;

        showContent(animeName, desc);
        positionPopup(card); // re-position after content makes popup grow
    }, { passive: true });

    document.addEventListener('mouseout', (e) => {
        const overlay = e.target.closest('.mc__overlay');
        if (!overlay) return;

        // Short delay so moving into the popup area or an adjacent card
        // doesn't cause flicker (popup is pointer-events:none so this is
        // purely cosmetic debounce)
        hideTimeout = setTimeout(() => {
            currentUrl = null;
            hidePopup();
        }, 120);
    }, { passive: true });

    // Hide if user moves back over the same card before timeout fires
    document.addEventListener('mouseover', (e) => {
        if (e.target.closest('.mc__overlay')) clearTimeout(hideTimeout);
    }, { passive: true });

})();
