// ==UserScript==
// @name         Animehay Volume Memory
// @version      2.0
// @updateURL    https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_volumeMemory.user.js
// @downloadURL  https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_volumeMemory.user.js
// @description  Remembers volume and mute state across episodes
// @author       Gemini (refactored)
// @include      /.*animehay.*/
// @match        *://*.ahplayer.com/*
// @match        *://*.playhydrax.*/*
// @match        *://*.ahay.stream/*
// @exclude      *://github.com/*
// @exclude      *://*.github.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // Volume only lives in iframes — bail out on the main page immediately.
    // Checking window.self === window.top is more reliable than URL matching
    // because the player domain can change without notice.
    if (window.self === window.top) return;

    const VOL_KEY = 'player_volume';
    const MUTE_KEY = 'player_muted';

    // Debounce saves so rapid scrubbing doesn't hammer GM_setValue
    let saveTimer = null;
    function scheduleSave(video) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            GM_setValue(VOL_KEY, video.volume);
            GM_setValue(MUTE_KEY, video.muted);
        }, 300);
    }

    function applyAndTrack(video) {
        if (video.dataset.volInit) return;
        video.dataset.volInit = '1';

        const savedVol = GM_getValue(VOL_KEY, 0.5);
        const savedMute = GM_getValue(MUTE_KEY, false);

        // Apply after metadata is ready so the player doesn't overwrite us
        const apply = () => {
            video.volume = Math.max(0, Math.min(1, savedVol));
            video.muted = savedMute;
        };

        if (video.readyState >= 1) {
            apply();
        } else {
            video.addEventListener('loadedmetadata', apply, { once: true });
        }

        // Save on user-driven changes only — skip the initial programmatic set
        // by waiting one tick before attaching the listener
        setTimeout(() => {
            video.addEventListener('volumechange', () => scheduleSave(video));
        }, 0);
    }

    // Use MutationObserver so we catch the video no matter when it appears,
    // including after slow iframe loads or SPA-style episode changes.
    const obs = new MutationObserver(() => {
        const video = document.querySelector('video');
        if (video) applyAndTrack(video);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    // Also try immediately in case the video is already in the DOM
    const existing = document.querySelector('video');
    if (existing) applyAndTrack(existing);

})();