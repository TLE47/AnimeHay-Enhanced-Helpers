// ==UserScript==
// @name         Animehay Volume Memory - Final Fix
// @version      1.5
// @updateURL    https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_volumeMemory.user.js
// @downloadURL  https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_volumeMemory.user.js
// @description  Remembers volume across iframes and updates UI
// @author       Gemini
// @include      /.*animehay.*/
// @match        *://*.ahplayer.com/*
// @exclude      *://github.com/*
// @exclude      *://*.github.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function() {
    'use strict';

    const STORAGE_KEY = 'global_player_volume';

    function initVolumeLogic() {
        // We look for the video tag directly
        const video = document.querySelector('video');

        if (video && !video.dataset.volumeHandled) {
            video.dataset.volumeHandled = "true";

            // 1. Load volume from global storage
            const savedVol = GM_getValue(STORAGE_KEY, 0.5);
            video.volume = savedVol;

            // 2. Force the JW Player UI to update (the orange bar)
            // We dispatch a volume change event so the player's JS sees it
            video.dispatchEvent(new Event('volumechange'));

            // 3. Save volume whenever it changes
            video.addEventListener('volumechange', () => {
                // Don't save if muted or 0
                if (!video.muted && video.volume > 0) {
                    GM_setValue(STORAGE_KEY, video.volume);
                }
            });
        }
    }

    // Run often enough to catch the video as it loads in the iframe
    const timer = setInterval(() => {
        if (document.querySelector('video')) {
            initVolumeLogic();
        }
    }, 1000);

    // Stop looking after 15 seconds to save battery/CPU
    setTimeout(() => clearInterval(timer), 15000);
})();