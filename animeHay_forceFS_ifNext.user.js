// ==UserScript==
// @name         Animehay Fullscreen Controller
// @version      2.0
// @updateURL    https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_forceFS_ifNext.user.js
// @downloadURL  https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_forceFS_ifNext.user.js
// @description  Restore fullscreen after clicking Next Episode
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

    const FS_KEY = 'ah_pending_fullscreen';
    const FS_TTL_MS = 15_000; // ignore stale flags older than this
    const isMainPage = window.self === window.top;

    // ── Helpers ────────────────────────────────────────────────────────────────

    function requestFS(el) {
        const fn = el.requestFullscreen
            || el.webkitRequestFullscreen
            || el.mozRequestFullScreen
            || el.msRequestFullscreen;
        if (!fn) return Promise.reject(new Error('No FS API'));
        return fn.call(el);
    }

    function findPlayer() {
        return document.querySelector('.jwplayer, video');
    }

    // Write a timestamped flag so stale values from a previous session are ignored
    function setFlag() { GM_setValue(FS_KEY, Date.now()); }
    function clearFlag() { GM_setValue(FS_KEY, 0); }
    function getFlag() {
        const t = GM_getValue(FS_KEY, 0);
        return t && (Date.now() - t) < FS_TTL_MS;
    }

    // ── Cross-frame messaging ──────────────────────────────────────────────────
    // Main page detects the "next episode" click and broadcasts to iframes.
    // Iframe (where the player lives) receives and attempts fullscreen directly,
    // which works because the iframe is the document that owns the video element.

    function toIframes(msg) {
        document.querySelectorAll('iframe').forEach(f => {
            try { f.contentWindow.postMessage(msg, '*'); } catch (_) { }
        });
    }

    // ── Main page logic ────────────────────────────────────────────────────────
    if (isMainPage) {
        // Detect "Next Episode" button click.
        // Strategy 1: background-image filename (current markup)
        // Strategy 2: aria-label / title attribute fallbacks
        // Strategy 3: any JW control icon adjacent to a "next" text node
        function isNextEpisodeTarget(el) {
            if (!el) return false;
            const icon = el.closest('.jw-icon, [class*="next"], [aria-label*="next" i], [title*="next" i]');
            if (!icon) return false;
            const bg = icon.style.backgroundImage || '';
            // Match by image name OR by semantic attribute alone
            return bg.includes('next_episode') || bg.includes('next-episode')
                || /next/i.test(icon.getAttribute('aria-label') || '')
                || /next/i.test(icon.getAttribute('title') || '')
                || icon.className.toLowerCase().includes('next');
        }

        window.addEventListener('click', e => {
            if (isNextEpisodeTarget(e.target)) {
                setFlag();
                // Also tell any already-loaded iframes immediately
                toIframes({ type: 'AH_FS_REQUEST' });
            }
        }, true);

        // When a new iframe loads, check if there's a pending flag and tell it
        const iframeObs = new MutationObserver(() => {
            if (!getFlag()) return;
            toIframes({ type: 'AH_FS_REQUEST' });
        });
        iframeObs.observe(document.body, { childList: true, subtree: true });

        // Receive acknowledgement from iframe so we can clear the flag
        window.addEventListener('message', e => {
            if (e.data?.type === 'AH_FS_DONE') clearFlag();
        });

        return; // main page done — player lives in iframe
    }

    // ── Iframe / player-page logic ─────────────────────────────────────────────

    async function attemptFullscreen() {
        const player = findPlayer();
        if (!player) return false;
        try {
            await requestFS(player);
            window.parent.postMessage({ type: 'AH_FS_DONE' }, '*');
            return true;
        } catch (_) {
            // Browser blocked the programmatic request — arm a one-shot click gate
            return false;
        }
    }

    // Gate: if the browser blocked the silent attempt, the next user interaction
    // inside the iframe (which satisfies the user-gesture requirement) will retry.
    function armClickGate() {
        window.addEventListener('click', async () => {
            await attemptFullscreen();
        }, { once: true });
    }

    // Entry point for iframe: triggered by postMessage OR by checking the flag
    // (covers the case where the iframe was already loaded before the click)
    async function handleFSRequest() {
        const ok = await attemptFullscreen();
        if (!ok) armClickGate();
    }

    // Listen for messages from the main page
    window.addEventListener('message', e => {
        if (e.data?.type === 'AH_FS_REQUEST') handleFSRequest();
    });

    // On iframe load, check if the flag was set before this frame existed
    // (e.g. slow-loading player after next-episode navigation)
    if (getFlag()) {
        // Wait for the player element to appear
        const obs = new MutationObserver(async () => {
            if (!findPlayer()) return;
            obs.disconnect();
            const ok = await attemptFullscreen();
            if (!ok) armClickGate();
        });
        obs.observe(document.body, { childList: true, subtree: true });

        // Also try immediately in case player is already in the DOM
        attemptFullscreen().then(ok => { if (!ok) armClickGate(); });
    }

})();