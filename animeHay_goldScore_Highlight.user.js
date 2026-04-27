// ==UserScript==
// @name         AnimeHay Enhanced: Gold Scores & AniList Progress
// @version      2.0
// @updateURL    https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_goldScore_Highlight.user.js
// @downloadURL  https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_goldScore_Highlight.user.js
// @description  Gradient score highlights >= 8.9 and colors watched episodes based on AniList
// @author       Gemini (refactored)
// @include      /.*animehay.*/
// @exclude      *://github.com/*
// @exclude      *://*.github.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      graphql.anilist.co
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ─── Auth setup ───────────────────────────────────────────────────────────
    let TOKEN = GM_getValue('anilist_token', '');
    let USERNAME = GM_getValue('anilist_username', '');

    if (!TOKEN || !USERNAME) {
        const t = prompt('GoldScore: Enter your AniList JWT Token (one-time setup):', TOKEN);
        if (!t?.trim()) { console.warn('[GoldScore] No token — AniList sync disabled.'); }
        else {
            const u = prompt('GoldScore: Enter your AniList Username:', USERNAME);
            if (u?.trim()) {
                GM_setValue('anilist_token', t.trim());
                GM_setValue('anilist_username', u.trim());
                alert('Saved! Refreshing…');
                location.reload();
                return;
            }
        }
    }

    const TOKEN_OK = TOKEN.length > 10;

    // ─── Score colour scale ───────────────────────────────────────────────────
    // Maps a score in [8.9, 10] to a vivid colour.
    // We interpolate through three waypoints:
    //   8.9  → deep blue-violet  (#6B3FA0)
    //   9.4  → rich gold         (#F5A623)
    //   10.0 → radiant crimson   (#FF2D55)
    // This gives a "rare → legendary → mythic" feel that scales visually.

    const WAYPOINTS = [
        { t: 0.0, r: 107, g: 63, b: 160 }, // 8.9  — deep violet
        { t: 0.45, r: 245, g: 166, b: 35 }, // 9.35 — gold
        { t: 0.75, r: 255, g: 80, b: 0 }, // 9.65 — ember orange
        { t: 1.0, r: 255, g: 20, b: 80 }, // 10.0 — crimson
    ];

    function lerpChannel(a, b, f) { return Math.round(a + (b - a) * f); }

    function scoreToColor(score) {
        const MIN = 8.9, MAX = 10.0;
        const t = Math.max(0, Math.min(1, (score - MIN) / (MAX - MIN)));

        // Find which segment t falls in
        let lo = WAYPOINTS[0], hi = WAYPOINTS[1];
        for (let i = 1; i < WAYPOINTS.length - 1; i++) {
            if (t >= WAYPOINTS[i].t) { lo = WAYPOINTS[i]; hi = WAYPOINTS[i + 1]; }
        }

        const segT = lo.t === hi.t ? 0 : (t - lo.t) / (hi.t - lo.t);
        const r = lerpChannel(lo.r, hi.r, segT);
        const g = lerpChannel(lo.g, hi.g, segT);
        const b = lerpChannel(lo.b, hi.b, segT);

        // Glow intensity scales with score
        const glowAlpha = (0.35 + t * 0.45).toFixed(2);
        const glowSpread = Math.round(4 + t * 10);
        return {
            bg: `rgb(${r},${g},${b})`,
            text: t > 0.35 ? '#fff' : '#f0e6ff',
            glow: `0 0 ${glowSpread}px rgba(${r},${g},${b},${glowAlpha})`,
            score: t, // 0-1 for badge sizing
        };
    }

    // Parse score from text that may include an emoji prefix, e.g. "⭐ 9.9"
    function parseScore(text) {
        const m = text.match(/[\d]+\.[\d]+|[\d]+/);
        return m ? parseFloat(m[0]) : NaN;
    }

    // ─── Score highlighter ────────────────────────────────────────────────────
    // Supports both old `.score` and new `.mc__score` selectors.
    const SCORE_SEL = '.mc__score, div.score';
    const PROCESSED = new WeakSet();

    function highlightScores() {
        document.querySelectorAll(SCORE_SEL).forEach(el => {
            if (PROCESSED.has(el)) return;
            const score = parseScore(el.textContent);
            if (isNaN(score) || score < 8.9) return;

            PROCESSED.add(el);
            const c = scoreToColor(score);

            // Scale font/padding slightly for higher scores
            const boost = Math.round(c.score * 2);

            el.style.cssText += [
                `background:${c.bg}`,
                `color:${c.text}`,
                `font-weight:bold`,
                `box-shadow:${c.glow}`,
                `border-radius:6px`,
                `padding:${1 + boost}px ${4 + boost}px`,
                `font-size:${11 + boost}px`,
                `transition:transform .15s`,
                `display:inline-block`,
                `cursor:default`,
            ].join(';');

            el.title = `Score ${score} — ${score >= 9.8 ? 'Mythic' : score >= 9.4 ? 'Legendary' : score >= 9.1 ? 'Epic' : 'Great'}`;

            el.addEventListener('mouseenter', () => el.style.transform = 'scale(1.1)');
            el.addEventListener('mouseleave', () => el.style.transform = '');
        });
    }

    // ─── AniList progress sync ────────────────────────────────────────────────
    // Uses a direct title search (one query per title candidate) instead of
    // downloading the entire watchlist, which is faster and less wasteful.

    function cleanTitle(s) {
        return s
            .replace(/Tập\s*\d+|Tap\s*\d+/gi, '')
            .replace(/vietsub|thuyết minh|lồng tiếng|trọn bộ/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function gatherTitles() {
        const titles = new Set();

        const h1 = document.querySelector('h1')?.innerText;
        if (h1) titles.add(cleanTitle(h1));

        // ".name_other" block — second child div holds the comma/semicolon list
        const nameOther = document.querySelector('.name_other');
        if (nameOther) {
            const raw = nameOther.querySelectorAll('div')[1]?.innerText || '';
            raw.split(/[,;]/).map(n => n.trim()).filter(Boolean).forEach(n => titles.add(n));
        }

        return [...titles].filter(t => t.length > 2);
    }

    // Search AniList for a single title; returns {progress, title} or null
    function queryAniList(title) {
        return new Promise(resolve => {
            const query = `
            query($s: String) {
              Page(page: 1, perPage: 1) {
                mediaList(userName: "${USERNAME}", type: ANIME, search: $s, status: CURRENT) {
                  progress
                  media { title { romaji } }
                }
              }
            }`;
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://graphql.anilist.co',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TOKEN}`,
                },
                data: JSON.stringify({ query, variables: { s: title } }),
                onload(res) {
                    try {
                        const list = JSON.parse(res.responseText)?.data?.Page?.mediaList;
                        if (list?.length) resolve({ progress: list[0].progress, title: list[0].media.title.romaji });
                        else resolve(null);
                    } catch (_) { resolve(null); }
                },
                onerror() { resolve(null); },
            });
        });
    }

    async function syncAniListProgress() {
        if (!TOKEN_OK || !USERNAME) return;
        if (!document.querySelector('.list-item-episode')) return;

        const titles = gatherTitles();
        if (!titles.length) return;

        // Search all titles in parallel; take the first hit
        const results = await Promise.all(titles.map(queryAniList));
        const match = results.find(r => r !== null);

        if (match) {
            console.log(`[GoldScore] AniList match: "${match.title}" — progress ep ${match.progress}`);
            applyWatchedStyles(match.progress);
        } else {
            console.log('[GoldScore] No AniList match for:', titles);
        }
    }

    function applyWatchedStyles(progress) {
        document.querySelectorAll('.list-item-episode a').forEach(link => {
            const text = link.querySelector('span')?.innerText ?? link.innerText;
            const epNum = parseInt(text.trim());
            if (isNaN(epNum) || epNum > progress) return;

            // Colour intensity fades slightly for older episodes
            const recency = Math.min(1, (progress - epNum) / 12); // 0 = most recent
            const alpha = (1 - recency * 0.4).toFixed(2);

            link.style.setProperty('background-color', `rgba(2, 43, 74, ${alpha})`, 'important');
            link.style.setProperty('color', '#a8d8f0', 'important');
            link.style.setProperty('border', '1px solid rgba(100,180,255,0.15)', 'important');
        });
    }

    // ─── Boot ─────────────────────────────────────────────────────────────────
    highlightScores();
    syncAniListProgress();

    // Re-run score highlights when new cards are injected (infinite scroll / SPA nav)
    const obs = new MutationObserver(highlightScores);
    obs.observe(document.body, { childList: true, subtree: true });

})();