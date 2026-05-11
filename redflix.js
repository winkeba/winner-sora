// ============================================================
// Redflix Module for Sora
// Site: https://redflix.co
// Mode: Async JS + StreamAsync + Softsubs
// Uses: Redflix for search/details/episodes, vidsrc.me for streams
// ============================================================

function extractTmdbId(url) {
    // URLs like /movie/inception-27205 or /tv/breaking-bad-1396
    const match = url.match(/\/(?:movie|tv)\/[^/?#]+-(\d+)/);
    return match ? match[1] : null;
}

function isMovie(url) {
    return url.includes('/movie/');
}

// ---- SEARCH -------------------------------------------------

async function searchResults(keyword) {
    try {
        const encoded = encodeURIComponent(keyword);
        const response = await fetchv2(
            `https://redflix.co/browse?q=${encoded}`,
            {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': 'https://redflix.co/'
            }
        );
        const html = await response.text();
        const results = [];

        const cardRegex = /<a[^>]+href="(\/(?:movie|tv)\/[^"]+)"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"[^>]*>[\s\S]*?<(?:h2|h3|p|span)[^>]*>([\s\S]*?)<\/(?:h2|h3|p|span)>/gi;
        let match;
        while ((match = cardRegex.exec(html)) !== null) {
            const href = 'https://redflix.co' + match[1].replace(/\/watch\/?$/, '').trim();
            const image = match[2].trim();
            const title = match[3].replace(/<[^>]+>/g, '').trim();
            if (title && href) results.push({ title, image, href });
        }

        // Fallback: grab hrefs and TMDB poster URLs independently
        if (results.length === 0) {
            const hrefRegex = /href="(\/(?:movie|tv)\/[^"/]+)"/g;
            const imgRegex = /src="(https:\/\/image\.tmdb\.org\/[^"]+)"/g;
            const hrefs = [], imgs = [];
            let m;
            while ((m = hrefRegex.exec(html)) !== null) hrefs.push('https://redflix.co' + m[1]);
            while ((m = imgRegex.exec(html)) !== null) imgs.push(m[1]);
            hrefs.forEach((href, i) => {
                const slugMatch = href.match(/\/(?:movie|tv)\/(.+)/);
                if (!slugMatch) return;
                const title = slugMatch[1]
                    .replace(/-\d+$/, '')
                    .replace(/-/g, ' ')
                    .replace(/\b\w/g, c => c.toUpperCase());
                results.push({ title, image: imgs[i] || '', href });
            });
        }

        return JSON.stringify(results);
    } catch (err) {
        console.log('searchResults error:', err);
        return JSON.stringify([{ title: 'Error', image: '', href: '' }]);
    }
}

// ---- DETAILS ------------------------------------------------

async function extractDetails(url) {
    try {
        const cleanUrl = url.replace(/\/watch\/?(\?.*)?$/, '');
        const response = await fetchv2(cleanUrl, {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Referer': 'https://redflix.co/'
        });
        const html = await response.text();

        const descMatch =
            html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/) ||
            html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/) ||
            html.match(/<p[^>]*class="[^"]*overview[^"]*"[^>]*>([\s\S]*?)<\/p>/);
        const description = descMatch
            ? descMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#039;/g, "'").trim()
            : 'No description available.';

        const yearMatch = html.match(/(\d{4})/);
        const airdate = yearMatch ? yearMatch[1] : 'Unknown';

        const genreMatch = html.match(/<span[^>]*class="[^"]*genre[^"]*"[^>]*>([\s\S]*?)<\/span>/);
        const aliases = genreMatch ? genreMatch[1].replace(/<[^>]+>/g, '').trim() : 'N/A';

        return JSON.stringify([{ description, aliases, airdate }]);
    } catch (err) {
        console.log('extractDetails error:', err);
        return JSON.stringify([{ description: 'Error loading details.', aliases: 'N/A', airdate: 'Unknown' }]);
    }
}

// ---- EPISODES -----------------------------------------------

async function extractEpisodes(url) {
    try {
        const cleanUrl = url.replace(/\/watch\/?(\?.*)?$/, '');

        if (isMovie(cleanUrl)) {
            return JSON.stringify([{ href: cleanUrl + '/watch', number: '1' }]);
        }

        const tmdbId = extractTmdbId(cleanUrl);
        const episodes = [];

        // Try scraping Redflix episode list first
        const response = await fetchv2(cleanUrl + '/watch', {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Referer': 'https://redflix.co/'
        });
        const html = await response.text();

        const epRegex = /href="(\/tv\/[^"]+watch\?[^"]*season=(\d+)[^"]*episode=(\d+)[^"]*)"/gi;
        let m;
        while ((m = epRegex.exec(html)) !== null) {
            const href = 'https://redflix.co' + m[1].replace(/&amp;/g, '&');
            const season = m[2];
            const ep = m[3];
            episodes.push({ href, number: `S${season}E${ep}` });
        }

        // Fallback: use TMDB API to build episode list
        if (episodes.length === 0 && tmdbId) {
            try {
                const tmdbResp = await fetchv2(
                    `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=8d6d91941230817f7807d643736e8a49`,
                    { 'Accept': 'application/json' }
                );
                const tmdbData = await tmdbResp.json();
                for (const season of (tmdbData.seasons || [])) {
                    if (season.season_number === 0) continue;
                    for (let ep = 1; ep <= season.episode_count; ep++) {
                        episodes.push({
                            href: `${cleanUrl}/watch?season=${season.season_number}&episode=${ep}`,
                            number: `S${season.season_number}E${ep}`
                        });
                    }
                }
            } catch (tmdbErr) {
                console.log('TMDB fallback error:', tmdbErr);
            }
        }

        if (episodes.length === 0) {
            return JSON.stringify([{ href: cleanUrl + '/watch?season=1&episode=1', number: 'S1E1' }]);
        }

        return JSON.stringify(episodes);
    } catch (err) {
        console.log('extractEpisodes error:', err);
        return JSON.stringify([{ href: url, number: 'S1E1' }]);
    }
}

// ---- STREAM (StreamAsync + Softsubs) ------------------------
// Builds a vidsrc.me embed URL from the TMDB ID in the Redflix URL,
// follows the iframe chain to find HLS + .vtt subtitle URL,
// and returns { stream, subtitles } for softsub mode.

async function extractStreamUrl(url) {
    try {
        const tmdbId = extractTmdbId(url);
        if (!tmdbId) {
            console.log('Could not extract TMDB ID from:', url);
            return JSON.stringify({ stream: null, subtitles: null });
        }

        let embedUrl;
        if (isMovie(url)) {
            embedUrl = `https://vidsrc.me/embed/movie?tmdb=${tmdbId}`;
        } else {
            const seasonMatch = url.match(/[?&]season=(\d+)/);
            const epMatch = url.match(/[?&]episode=(\d+)/);
            const season = seasonMatch ? seasonMatch[1] : '1';
            const ep = epMatch ? epMatch[1] : '1';
            embedUrl = `https://vidsrc.me/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${ep}`;
        }

        console.log('vidsrc embed:', embedUrl);

        // Step 1: load vidsrc embed page
        const embedResp = await fetchv2(embedUrl, {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
            'Referer': 'https://redflix.co/',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        });
        const embedHtml = await embedResp.text();

        // Step 2: find inner player iframe
        const iframeMatch = embedHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i);
        if (!iframeMatch) {
            console.log('No iframe in vidsrc page');
            return JSON.stringify({ stream: null, subtitles: null });
        }

        const playerUrl = iframeMatch[1].replace(/&amp;/g, '&');
        console.log('Player URL:', playerUrl);

        // Step 3: load the actual player page
        const playerResp = await fetchv2(playerUrl, {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
            'Referer': embedUrl,
            'Accept': '*/*'
        });
        const playerHtml = await playerResp.text();

        // Step 4: unpack obfuscated script if present
        let sourceHtml = playerHtml;
        const obfMatch = playerHtml.match(/<script[^>]*>\s*(eval\(function\(p,a,c,k,e,d[\s\S]*?)<\/script>/);
        if (obfMatch) {
            try { sourceHtml = unpack(obfMatch[1]); } catch (e) { console.log('Unpack failed:', e); }
        }

        // Step 5: extract HLS stream
        const hlsMatch = sourceHtml.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)['"]/);
        if (hlsMatch) {
            const stream = hlsMatch[1];
            // Look for English subtitle .vtt track
            const vttMatch = sourceHtml.match(/["'](https?:\/\/[^"']+(?:english|en)[^"']*\.vtt[^"']*)['"]/i) ||
                             sourceHtml.match(/["'](https?:\/\/[^"']+\.vtt[^"']*)['"]/);
            const subtitles = vttMatch ? vttMatch[1] : null;
            console.log('Stream:', stream, '| Subs:', subtitles);
            return JSON.stringify({ stream, subtitles });
        }

        // Step 6: fallback MP4
        const mp4Match = sourceHtml.match(/["'](https?:\/\/[^"']+\.mp4[^"']*)['"]/);
        if (mp4Match) {
            return JSON.stringify({ stream: mp4Match[1], subtitles: null });
        }

        console.log('No stream found');
        return JSON.stringify({ stream: null, subtitles: null });

    } catch (err) {
        console.log('extractStreamUrl error:', err);
        return JSON.stringify({ stream: null, subtitles: null });
    }
}

// ============================================================
// DEOBFUSCATOR (p.a.c.k.e.r)
// Credit: @mnsrulz / @jcpiccodev
// ============================================================
class Unbaser {
    constructor(base) {
        this.ALPHABET = {
            62: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
            95: "' !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'",
        };
        this.dictionary = {};
        this.base = base;
        if (36 < base && base < 62) {
            this.ALPHABET[base] = this.ALPHABET[base] || this.ALPHABET[62].substr(0, base);
        }
        if (2 <= base && base <= 36) {
            this.unbase = (value) => parseInt(value, base);
        } else {
            try {
                [...this.ALPHABET[base]].forEach((cipher, index) => { this.dictionary[cipher] = index; });
            } catch (er) { throw Error("Unsupported base encoding."); }
            this.unbase = this._dictunbaser;
        }
    }
    _dictunbaser(value) {
        let ret = 0;
        [...value].reverse().forEach((cipher, index) => {
            ret = ret + ((Math.pow(this.base, index)) * this.dictionary[cipher]);
        });
        return ret;
    }
}
function detect(source) { return source.replace(" ", "").startsWith("eval(function(p,a,c,k,e,"); }
function unpack(source) {
    let { payload, symtab, radix, count } = _filterargs(source);
    if (count != symtab.length) throw Error("Malformed p.a.c.k.e.r. symtab.");
    let unbase;
    try { unbase = new Unbaser(radix); } catch (e) { throw Error("Unknown p.a.c.k.e.r. encoding."); }
    function lookup(match) {
        const word = match;
        let word2 = radix == 1 ? symtab[parseInt(word)] : symtab[unbase.unbase(word)];
        return word2 || word;
    }
    source = payload.replace(/\b\w+\b/g, lookup);
    return _replacestrings(source);
    function _filterargs(source) {
        const juicers = [
            /}\('(.*)', *(\d+|\[\]), *(\d+), *'(.*)'\.split\('\|'\), *(\d+), *(.*)\)\)/,
            /}\('(.*)', *(\d+|\[\]), *(\d+), *'(.*)'\.split\('\|'\)/,
        ];
        for (const juicer of juicers) {
            const args = juicer.exec(source);
            if (args) {
                let a = args;
                try {
                    return { payload: a[1], symtab: a[4].split("|"), radix: parseInt(a[2]), count: parseInt(a[3]) };
                } catch (ValueError) { throw Error("Corrupted p.a.c.k.e.r. data."); }
            }
        }
        throw Error("Could not make sense of p.a.c.k.e.r data (unexpected code structure)");
    }
    function _replacestrings(source) { return source; }
}
