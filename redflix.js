// ============================================================
// Redflix Module for Sora
// Search/Details/Episodes: TMDB API
// Stream + Subtitles:      vidsrc.me
// Mode: asyncJS + streamAsyncJS + softsub
// ============================================================

const TMDB_KEY = "8d6d91941230817f7807d643736e8a49";
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p/w500";

// ---- HELPERS ------------------------------------------------

function parseUrl(url) {
    const movie = url.match(/\/movie\/(?:[^/?#]+-)?(\d+)/);
    if (movie) return { type: "movie", id: movie[1] };
    const tv = url.match(/\/tv\/(?:[^/?#]+-)?(\d+)/);
    if (tv) return { type: "tv", id: tv[1] };
    const num = url.match(/\/(\d+)/);
    return { type: "movie", id: num ? num[1] : "0" };
}

// ---- SEARCH -------------------------------------------------

async function searchResults(keyword) {
    try {
        const encoded = encodeURIComponent(keyword);
        const response = await fetchv2(
            `${TMDB_BASE}/search/multi?api_key=${TMDB_KEY}&query=${encoded}&language=en-US&page=1`
        );
        const data = await response.json();

        const results = (data.results || [])
            .filter(item => item.media_type === "movie" || item.media_type === "tv")
            .map(item => ({
                title: item.title || item.name || "Unknown",
                image: item.poster_path ? TMDB_IMG + item.poster_path : "",
                href: `https://redflix.co/${item.media_type}/${item.id}`
            }));

        return JSON.stringify(results);
    } catch (err) {
        console.log("searchResults error:", err);
        return JSON.stringify([{ title: "Error", image: "", href: "" }]);
    }
}

// ---- DETAILS ------------------------------------------------

async function extractDetails(url) {
    try {
        const { type, id } = parseUrl(url);
        const response = await fetchv2(
            `${TMDB_BASE}/${type}/${id}?api_key=${TMDB_KEY}&language=en-US`
        );
        const data = await response.json();

        const description = data.overview || "No description available.";
        const airdate = (data.release_date || data.first_air_date || "Unknown").substring(0, 4);
        const aliases = (data.genres || []).map(g => g.name).join(", ") || "N/A";

        return JSON.stringify([{ description, aliases, airdate }]);
    } catch (err) {
        console.log("extractDetails error:", err);
        return JSON.stringify([{ description: "Error loading details.", aliases: "N/A", airdate: "Unknown" }]);
    }
}

// ---- EPISODES -----------------------------------------------

async function extractEpisodes(url) {
    try {
        const { type, id } = parseUrl(url);

        if (type === "movie") {
            return JSON.stringify([{ href: url, number: "1" }]);
        }

        const response = await fetchv2(
            `${TMDB_BASE}/tv/${id}?api_key=${TMDB_KEY}&language=en-US`
        );
        const data = await response.json();

        const episodes = [];
        for (const season of (data.seasons || [])) {
            if (season.season_number === 0) continue;
            for (let ep = 1; ep <= season.episode_count; ep++) {
                episodes.push({
                    href: `https://redflix.co/tv/${id}/watch?season=${season.season_number}&episode=${ep}`,
                    number: `S${season.season_number}E${ep}`
                });
            }
        }

        if (episodes.length === 0) {
            return JSON.stringify([{
                href: `https://redflix.co/tv/${id}/watch?season=1&episode=1`,
                number: "S1E1"
            }]);
        }

        return JSON.stringify(episodes);
    } catch (err) {
        console.log("extractEpisodes error:", err);
        return JSON.stringify([{ href: url, number: "S1E1" }]);
    }
}

// ---- STREAM (streamAsyncJS + softsub) -----------------------

async function extractStreamUrl(url) {
    try {
        const { type, id } = parseUrl(url);

        let embedUrl;
        if (type === "movie") {
            embedUrl = `https://vidsrc.me/embed/movie?tmdb=${id}`;
        } else {
            const season = (url.match(/[?&]season=(\d+)/) || [])[1] || "1";
            const ep     = (url.match(/[?&]episode=(\d+)/) || [])[1] || "1";
            embedUrl = `https://vidsrc.me/embed/tv?tmdb=${id}&season=${season}&episode=${ep}`;
        }

        console.log("Embed URL:", embedUrl);

        // Step 1: vidsrc wrapper page
        const embedResp = await fetchv2(embedUrl, {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
            "Referer": "https://vidsrc.me/",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        });
        const embedHtml = await embedResp.text();

        // Step 2: find inner player iframe src
        const iframeMatch = embedHtml.match(/src=["'](https?:\/\/[^"']*vidsrc[^"']+)["']/i)
                         || embedHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i);
        if (!iframeMatch) {
            console.log("No iframe found");
            return JSON.stringify({ stream: null, subtitles: null });
        }

        const playerUrl = iframeMatch[1].replace(/&amp;/g, "&");
        console.log("Player URL:", playerUrl);

        // Step 3: player page
        const playerResp = await fetchv2(playerUrl, {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
            "Referer": embedUrl,
            "Accept": "*/*"
        });
        const playerHtml = await playerResp.text();

        // Step 4: unpack obfuscated scripts
        let sourceHtml = playerHtml;
        const obfMatch = playerHtml.match(/<script[^>]*>\s*(eval\(function\(p,a,c,k,e,d[\s\S]*?)<\/script>/);
        if (obfMatch) {
            try { sourceHtml = unpack(obfMatch[1]); } catch (e) { console.log("Unpack failed:", e); }
        }

        // Step 5: HLS stream
        const hlsMatch = sourceHtml.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)['"]/);
        if (hlsMatch) {
            const stream = hlsMatch[1];
            const vttMatch =
                sourceHtml.match(/["'](https?:\/\/[^"']*(?:english|en)[^"']*\.vtt[^"']*)['"]/i) ||
                sourceHtml.match(/["'](https?:\/\/[^"']+\.vtt[^"']*)['"]/);
            const subtitles = vttMatch ? vttMatch[1] : null;
            console.log("Stream:", stream, "| Subs:", subtitles);
            return JSON.stringify({ stream, subtitles });
        }

        // Step 6: MP4 fallback
        const mp4Match = sourceHtml.match(/["'](https?:\/\/[^"']+\.mp4[^"']*)['"]/);
        if (mp4Match) {
            return JSON.stringify({ stream: mp4Match[1], subtitles: null });
        }

        console.log("No stream found");
        return JSON.stringify({ stream: null, subtitles: null });

    } catch (err) {
        console.log("extractStreamUrl error:", err);
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
            95: "' !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'"
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
            ret += Math.pow(this.base, index) * this.dictionary[cipher];
        });
        return ret;
    }
}
function detect(source) { return source.replace(" ", "").startsWith("eval(function(p,a,c,k,e,"); }
function unpack(source) {
    let { payload, symtab, radix, count } = _filterargs(source);
    if (count !== symtab.length) throw Error("Malformed p.a.c.k.e.r. symtab.");
    const unbase = new Unbaser(radix);
    function lookup(match) {
        const word2 = radix === 1 ? symtab[parseInt(match)] : symtab[unbase.unbase(match)];
        return word2 || match;
    }
    return payload.replace(/\b\w+\b/g, lookup);
    function _filterargs(source) {
        const juicers = [
            /}\('(.*)', *(\d+|\[\]), *(\d+), *'(.*)'\.split\('\|'\), *(\d+), *(.*)\)\)/,
            /}\('(.*)', *(\d+|\[\]), *(\d+), *'(.*)'\.split\('\|'\)/
        ];
        for (const juicer of juicers) {
            const args = juicer.exec(source);
            if (args) {
                try {
                    return { payload: args[1], symtab: args[4].split("|"), radix: parseInt(args[2]), count: parseInt(args[3]) };
                } catch (e) { throw Error("Corrupted p.a.c.k.e.r. data."); }
            }
        }
        throw Error("Could not make sense of p.a.c.k.e.r data.");
    }
}
