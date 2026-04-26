// ==UserScript==
// @name         AnimeHay Enhanced: Gold Scores & AniList Progress
// @version      1.3
// @updateURL    https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_goldScore_Highlight.user.js
// @downloadURL  https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_goldScore_Highlight.user.js
// @description  Highlights scores >= 9.0 and colors watched episodes based on AniList
// @author       Gemini
// @include      /.*animehay.*/
// @exclude      *://github.com/*
// @exclude      *://*.github.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      graphql.anilist.co
// ==/UserScript==

(function() {
    'use strict';

    let TOKEN = GM_getValue("anilist_token", "");
    let USERNAME = GM_getValue("anilist_username", "");

    if (!TOKEN || !USERNAME) {
        const userToken = prompt("GoldScore: Please enter your AniList JWT Token (one-time setup):", TOKEN);
        if (userToken) {
            const userName = prompt("GoldScore: Please enter your AniList Username:", USERNAME);
            if (userName) {
                GM_setValue("anilist_token", userToken.trim());
                GM_setValue("anilist_username", userName.trim());
                TOKEN = userToken.trim();
                USERNAME = userName.trim();
                alert("Token and Username saved! Refreshing page...");
                location.reload();
                return;
            }
        }
        console.error("No token/username provided. AniList sync will not function.");
    }

    const CONFIG = {
        anilistToken: TOKEN,
        userName: USERNAME,
        watchedBgColor: '#022b4a',
        watchedTextColor: '#ffffff'
    };

    // --- 1. GOLD SCORE HIGHLIGHTER ---
    function highlightScores() {
        document.querySelectorAll('div.score').forEach(div => {
            const score = parseFloat(div.textContent.trim());
            if (!isNaN(score) && score >= 9.0) {
                div.style.backgroundColor = '#FFD700';
                div.style.color = '#000';
                div.style.fontWeight = 'bold';
            }
        });
    }

    function syncAniListProgress() {
        const episodeContainer = document.querySelector('.list-item-episode');
        if (!episodeContainer) return;

        // 1. Get Main Title
        let mainTitle = document.querySelector('h1')?.innerText
            .split(/Tập|Tap/i)[0]
            .replace(/Vietsub|Thuyết Minh|Lồng Tiếng/gi, '')
            .trim();

        // 2. Get "Other Names" from the specific div provided
        let otherNames = [];
        const otherNameDiv = document.querySelector('.name_other');
        if (otherNameDiv) {
            // Get the text from the second child div (where the titles are)
            const namesText = otherNameDiv.querySelectorAll('div')[1]?.innerText || "";
            // Split by comma or semicolon and clean up
            otherNames = namesText.split(/[,;]/).map(n => n.trim()).filter(n => n.length > 0);
        }

        // Combine all possible titles to check
        const allPotentialTitles = [mainTitle, ...otherNames].filter(Boolean);

        if (allPotentialTitles.length === 0 || CONFIG.anilistToken.length < 50) return;

        const query = `
        query ($userName: String) {
          MediaListCollection(userName: $userName, type: ANIME, status: CURRENT) {
            lists {
              entries {
                progress
                media {
                  title { romaji english native }
                }
              }
            }
          }
        }`;

        GM_xmlhttpRequest({
            method: "POST",
            url: "https://graphql.anilist.co",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + CONFIG.anilistToken.trim(),
            },
            data: JSON.stringify({
                query: query,
                variables: { userName: CONFIG.userName }
            }),
            onload: function(response) {
                try {
                    const result = JSON.parse(response.responseText);
                    if (result.errors) return;

                    const entries = result.data.MediaListCollection.lists.flatMap(l => l.entries);

                    // Match logic: Check every title from AnimeHay against every title from AniList
                    const match = entries.find(e => {
                        const aniTitles = [
                            e.media.title.romaji?.toLowerCase(),
                            e.media.title.english?.toLowerCase(),
                            e.media.title.native?.toLowerCase()
                        ].filter(Boolean);

                        return allPotentialTitles.some(localTitle => {
                            const lt = localTitle.toLowerCase();
                            return aniTitles.some(at => at.includes(lt) || lt.includes(at));
                        });
                    });

                    if (match) {
                        console.log(`%cAniList Match Found!`, "color: #00ff00", match.media.title.romaji);
                        applyWatchedStyles(match.progress);
                    } else {
                        console.log("No match found for titles:", allPotentialTitles);
                    }
                } catch (e) { console.error(e); }
            }
        });
    }

    function applyWatchedStyles(progress) {
        document.querySelectorAll('.list-item-episode a').forEach(link => {
            const epNumStr = link.querySelector('span')?.innerText || link.innerText;
            const epNum = parseInt(epNumStr.trim());

            if (!isNaN(epNum) && epNum <= progress) {
                link.style.setProperty('background-color', CONFIG.watchedBgColor, 'important');
                link.style.setProperty('color', CONFIG.watchedTextColor, 'important');
                link.style.setProperty('border', '1px solid rgba(255,255,255,0.1)', 'important');
            }
        });
    }

    highlightScores();
    syncAniListProgress();

    const observer = new MutationObserver(highlightScores);
    observer.observe(document.body, { childList: true, subtree: true });

})();