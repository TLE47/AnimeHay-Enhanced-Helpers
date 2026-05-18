// ==UserScript==
// @name         AnimeHay - Layout Consistent (Page 2+ Fix)
// @version      1.3
// @updateURL    https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_layoutNormalize.user.js
// @downloadURL  https://raw.githubusercontent.com/TLE47/AnimeHay-Enhanced-Helpers/main/animeHay_layoutNormalize.user.js
// @description  Make page 2, 3, 4 and other listing pages have the same modern layout as page 1 (including sidebar)
// @author       TLE47
// @include      /^https?:\/\/.*animehay.*\..*/
// @match        *://*.animehay.tv/*
// @match        *://*.animehay.uno/*
// @exclude      *://github.com/*
// @exclude      *://*.github.com/*
// @exclude      *://*/thong-tin-phim/*
// @exclude      *://*/xem-phim/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // Cache for sidebar HTML to avoid redundant fetches
    const SIDEBAR_CACHE_KEY = 'ah_sidebar_html_cache';

    async function injectSidebar(sidebarContainer) {
        // Try session cache first
        const cachedHtml = sessionStorage.getItem(SIDEBAR_CACHE_KEY);
        if (cachedHtml) {
            sidebarContainer.innerHTML = cachedHtml;
            return;
        }

        // Fetch home page to extract the sidebar
        try {
            console.log('[AnimeHay Layout] Fetching sidebar from home page...');
            const response = await fetch('/');
            const text = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/html');
            const sidebar = doc.querySelector('.ah-sidebar');
            
            if (sidebar && sidebar.innerHTML.trim()) {
                const html = sidebar.innerHTML;
                sidebarContainer.innerHTML = html;
                sessionStorage.setItem(SIDEBAR_CACHE_KEY, html);
                console.log('[AnimeHay Layout] Sidebar injected and cached.');
            }
        } catch (err) {
            console.error('[AnimeHay Layout] Error fetching sidebar:', err);
        }
    }

    function normalizeLayout() {
        // Target the main content wrapper
        const ahContent = document.querySelector('.ah_content');
        if (!ahContent) return;

        // Find the movies list - if it's already in the modern layout, skip
        const moviesList = ahContent.querySelector('.movies-list');
        if (!moviesList || ahContent.querySelector('.ah-home')) return;

        console.log('[AnimeHay Layout] Normalizing listing page layout...');

        // 1. Identify existing elements
        const topBanner = ahContent.querySelector('#top-banner');
        
        // Find the old header
        const oldHeader = ahContent.querySelector('.margin-10-0.bg-gray-2') || 
                          ahContent.querySelector('.fs-17.fw-700') ||
                          ahContent.querySelector('.heading');
        
        const pagination = ahContent.querySelector('.ah-pagination');

        // Extract title text
        let titleText = 'Danh sách phim';
        if (oldHeader) {
            titleText = oldHeader.textContent.trim().replace(/\s+/g, ' ');
        }

        // 2. Create Wrapper Structure
        const ahHome = document.createElement('div');
        ahHome.className = 'ah-home';

        const ahHomeBody = document.createElement('div');
        ahHomeBody.className = 'ah-home__body';

        const ahMain = document.createElement('main');
        ahMain.className = 'ah-main';

        // 3. Create Modern Header
        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'ah-section-header';
        
        const sectionTitle = document.createElement('div');
        sectionTitle.className = 'ah-section-title';
        sectionTitle.textContent = titleText;

        const genreChips = document.createElement('div');
        genreChips.className = 'ah-genre-chips';
        genreChips.innerHTML = `
            <a href="/the-loai/anime-1.html" class="ah-genre-chip">🎌 Anime</a>
            <a href="/the-loai/cn-animation-34.html" class="ah-genre-chip">🇨🇳 CNA</a>
            <a href="/phim-moi-cap-nhap/tat-ca-1.html" class="ah-genre-chip">Tất cả →</a>
        `;

        sectionHeader.appendChild(sectionTitle);
        sectionHeader.appendChild(genreChips);

        // 4. Update movies-list
        moviesList.classList.add('ah-frame-bg');

        // 5. Assemble Main Column
        ahMain.appendChild(sectionHeader);
        ahMain.appendChild(moviesList);
        if (pagination) ahMain.appendChild(pagination);

        ahHomeBody.appendChild(ahMain);

        // 6. Sidebar (Dynamic Injection)
        const ahSidebar = document.createElement('aside');
        ahSidebar.className = 'ah-sidebar';
        ahHomeBody.appendChild(ahSidebar);
        
        // Start background fetch/injection
        injectSidebar(ahSidebar);

        ahHome.appendChild(ahHomeBody);

        // 7. Replace content
        ahContent.innerHTML = '';
        if (topBanner) ahContent.appendChild(topBanner);
        ahContent.appendChild(ahHome);
        
        console.log('[AnimeHay Layout] Normalization complete.');
    }

    // Run
    normalizeLayout();

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.addedNodes.length) {
                const moviesList = document.querySelector('.movies-list:not(.ah-frame-bg)');
                if (moviesList) normalizeLayout();
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

})();
