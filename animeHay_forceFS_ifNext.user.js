// ==UserScript==
// @name         Animehay Fullscreen Controller
// @version      1.1
// @updateURL    https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_forceFS_ifNext.user.js
// @downloadURL  https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_forceFS_ifNext.user.js
// @description  Attempts to force fullscreen after clicking "Next Episode"
// @author       Gemini
// @include      /.*animehay.*/
// @match        *://*.ahplayer.com/*
// @exclude      *://github.com/*
// @exclude      *://*.github.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const FS_KEY = 'ah_pending_fullscreen';

    // 1. Listen for the click on the Next button globally
    window.addEventListener('click', (e) => {
        const target = e.target.closest('div.jw-icon');
        if (target && target.style.backgroundImage.includes('next_episode.png')) {
            GM_setValue(FS_KEY, true);
        }
    }, true);

    // 2. Function to request fullscreen
    function activateFullscreen(el) {
        const request = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
        if (request) {
            request.call(el).catch(err => {
                console.log("Browser blocked auto-fullscreen. Waiting for one user click.");
            });
        }
    }

    // 3. Monitor for the new video and trigger FS if the flag is set
    const checkInterval = setInterval(() => {
        if (GM_getValue(FS_KEY, false)) {
            const player = document.querySelector('.jwplayer') || document.querySelector('video');

            if (player) {
                activateFullscreen(player);

                // Once we attempt it, clear the flag
                // If it fails due to security, clicking anywhere on the page
                // will trigger this check again.
                window.addEventListener('click', () => {
                    if (GM_getValue(FS_KEY, false)) {
                        activateFullscreen(player);
                        GM_setValue(FS_KEY, false);
                    }
                }, { once: true });
            }
        }
    }, 500);

    // Stop checking after 10 seconds to save resources
    setTimeout(() => clearInterval(checkInterval), 10000);
})();