# AnimeHay AniList epTracker

![AnimeHay AniList epTracker](https://placehold.co/800x400/222222/FFD700?text=AnimeHay+AniList+epTracker)

## Overview
**AnimeHay AniList epTracker** is a sleek, lightweight background userscript designed to automatically highlight the current or next episode you need to watch on AnimeHay by syncing directly with your [AniList](https://anilist.co) profile. 

It prevents you from losing your place when returning to a show and integrates a convenient minimizeable GUI overlay for debugging and quick refreshing.

## Features
- **AniList Automated Syncing:** Reaches out to AniList using your secure JWT Token to check your watch progress for the current title.
- **Smart DOM Polling:** Runs in the background, reliably adapting to page changes and stopping gracefully to conserve CPU usage if title elements don't load.
- **Advanced Title Parsing:** Scrapes not just the main title but silently pulls alternative (English/Romaji) native names from the website's info routes to maximize AniList query accuracy. 
- **Visual Highlighting:** Draws a highly visibly highlighted border and background (with an automated scroll-into-view behavior) for the button of the exact episode you need to watch.
- **Auto-Fade Minimal GUI:** A built-in terminal GUI widget that can be manually minimized and magically fades out (`opacity: 0`) when overlapped by website elements, preventing playback obstruction.

## Setup
1. Install a userscript manager (e.g. Tampermonkey or Scriptcat).
2. Install the raw file via GitHub.
3. On first run, it will prompt you for your `AniList JWT Token`. Grab this token by creating an API client on the AniList developer dashboard and allowing it access.
4. The token is stored locally using `GM_getValue`, meaning you only need to supply it once!

## Maintenance
If AnimeHay updates its structural HTML classes (`wp-ep`, `aim-hero`, etc.), developers can easily maintain the script by updating the `SELECTORS` mapping object placed neatly at the very top of the script.
