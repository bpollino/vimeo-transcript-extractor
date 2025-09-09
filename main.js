import { Actor } from 'apify';
import { gotScraping } from 'got-scraping';

await Actor.init();

class VimeoTranscriptExtractor {
    extractVideoId(url) {
        const match = url.match(/vimeo\.com\/(\d+)/);
        return match ? match[1] : null;
    }

    async tryPlayerConfig(videoId) {
        console.log(`Trying player config for video ${videoId}`);
        try {
            const url = `https://player.vimeo.com/video/${videoId}/config`;
            console.log(`Fetching: ${url}`);
            
            const response = await gotScraping({
                url: url,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': `https://vimeo.com/${videoId}`,
                    'Accept': 'application/json'
                },
                timeout: { response: 15000 }
            });

            console.log(`Response status: ${response.statusCode}`);
            console.log(`Response length: ${response.body.length}`);
            
            const data = JSON.parse(response.body);
            console.log(`Config keys: ${Object.keys(data)}`);
            
            // Debug: Log the full structure
            if (data.request) {
                console.log(`Request keys: ${Object.keys(data.request)}`);
                if (data.request.text_tracks) {
                    console.log(`Found text_tracks: ${JSON.stringify(data.request.text_tracks)}`);
                }
            }
            
            if (data.video) {
                console.log(`Video keys: ${Object.keys(data.video)}`);
                if (data.video.text_tracks) {
                    console.log(`Found video.text_tracks: ${JSON.stringify(data.video.text_tracks)}`);
                }
            }
            
            // Look for text tracks in multiple locations
            const paths = [
                'request.text_tracks',
                'video.text_tracks',
                'textTracks',
                'request.files.text_tracks',
                'embed.text_tracks',
                'clip.text_tracks'
            ];
            
            for (const path of paths) {
                const tracks = this.getNestedProperty(data, path);
                console.log(`Checking path ${path}: ${tracks ? 'found' : 'not found'}`);
                if (Array.isArray(tracks) && tracks.length > 0) {
                    console.log(`Found tracks at ${path}: ${JSON.stringify(tracks)}`);
                    const track = tracks.find(t => t.lang === 'en') || tracks[0];
                    return {
                        success: true,
                        method: 'player_config',
                        transcriptUrl: track.url,
                        trackInfo: track
                    };
                }
            }
        } catch (error) {
            console.log(`Player config error: ${error.message}`);
        }
        
        return { success: false };
    }

    getNestedProperty(obj, path) {
        return path.split('.').reduce((current, key) => {
            return current && current[key] !== undefined ? current[key] : null;
        }, obj);
    }

    async tryDirectPageScraping(videoId) {
        console.log(`Trying page scraping for video ${videoId}`);
        try {
            const url = `https://vimeo.com/${videoId}`;
            console.log(`Fetching page: ${url}`);
            
            const response = await gotScraping({
                url: url,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                },
                timeout: { response: 15000 }
            });

            const html = response.body;
            console.log(`Page HTML length: ${html.length}`);
            
            // Extract tokens and transcript IDs from JavaScript variables
            const jsPatterns = [
                // Look for texttrack URLs in JavaScript
                /texttrack[\\\/]+(\d+)\.vtt[^"']*token[=:]([a-f0-9_]+)/gi,
                
                // Look for complete URLs
                /https:\/\/vimeo\.com\/texttrack\/(\d+)\.vtt\?token=([a-f0-9_]+)/gi,
                
                // Look in JSON objects
                /"url":\s*"([^"]*texttrack[^"]*\.vtt[^"]*)"/gi,
                
                // Look for tokens in data attributes
                /data-[^=]*=["'][^"']*texttrack[^"']*["']/gi,
                
                // Search for vimeo config objects
                /vimeoPlayerConfig[^}]*texttrack[^}]*/gi,
                
                // Look for any .vtt references
                /[a-f0-9_]{8,}_0x[a-f0-9]{40,}/gi
            ];

            let foundUrls = [];
            
            for (let i = 0; i < jsPatterns.length; i++) {
                const pattern = jsPatterns[i];
                let match;
                const patternMatches = [];
                
                while ((match = pattern.exec(html)) !== null) {
                    patternMatches.push(match[0]);
                    if (patternMatches.length > 10) break; // Limit matches
                }
                
                console.log(`Pattern ${i + 1} found ${patternMatches.length} matches`);
                
                if (patternMatches.length > 0) {
                    console.log(`Sample matches: ${patternMatches.slice(0, 3)}`);
                    foundUrls = foundUrls.concat(patternMatches);
                }
            }

            // Try to construct URLs from found data
            const uniqueUrls = [...new Set(foundUrls)];
            
            for (const item of uniqueUrls) {
                let testUrl = item;
                
                // Clean up the URL
                testUrl = testUrl.replace(/\\/g, '');
                testUrl = testUrl.replace(/^"/, '').replace(/"$/, '');
                
                // If it's not a complete URL, try to extract parts
                if (!testUrl.startsWith('https://')) {
                    const transcriptMatch = testUrl.match(/(\d+)\.vtt.*?([a-f0-9_]{8,}_0x[a-f0-9]{40,})/);
                    if (transcriptMatch) {
                        testUrl = `https://vimeo.com/texttrack/${transcriptMatch[1]}.vtt?token=${transcriptMatch[2]}`;
                    } else {
                        continue;
                    }
                }
                
                console.log(`Testing constructed URL: ${testUrl}`);
                
                try {
                    const testResponse = await gotScraping({
                        url: testUrl,
                        headers: { 
                            'User-Agent': 'Mozilla/5.0',
                            'Referer': url
                        },
                        timeout: { response: 8000 }
                    });

                    if (testResponse.statusCode === 200 && 
                        testResponse.body && 
                        testResponse.body.includes('WEBVTT')) {
                        console.log('Found working transcript URL!');
                        return {
                            success: true,
                            method: 'page_scraping',
                            transcriptUrl: testUrl,
                            vttContent: testResponse.body
                        };
                    }
                } catch (testError) {
                    console.log(`URL test failed: ${testError.message}`);
                }
            }
            
            // Fallback: try with your known transcript ID and pattern matching for tokens
            const knownTranscriptId = String(parseInt(videoId) - 859435365);
            const tokenMatches = html.match(/[a-f0-9]{8}_0x[a-f0-9]{40}/g);
            
            if (tokenMatches && tokenMatches.length > 0) {
                console.log(`Found ${tokenMatches.length} potential tokens`);
                
                for (const token of tokenMatches.slice(0, 5)) { // Try first 5 tokens
                    const testUrl = `https://vimeo.com/texttrack/${knownTranscriptId}.vtt?token=${token}`;
                    console.log(`Testing with token: ${testUrl}`);
                    
                    try {
                        const testResponse = await gotScraping({
                            url: testUrl,
                            headers: { 'User-Agent': 'Mozilla/5.0' },
                            timeout: { response: 8000 }
                        });

                        if (testResponse.statusCode === 200 && 
                            testResponse.body && 
                            testResponse.body.includes('WEBVTT')) {
                            console.log('Found working transcript with token matching!');
                            return {
                                success: true,
                                method: 'token_extraction',
                                transcriptUrl: testUrl,
                                vttContent: testResponse.body
                            };
                        }
                    } catch (testError) {
                        console.log(`Token test failed: ${testError.message}`);
                    }
                }
            }
            
        } catch (error) {
            console.log(`Page scraping error: ${error.message}`);
        }
        
        return { success: false };
    }

    parseVTT(vttText) {
        const lines = vttText.split('\n');
        const cues = [];
        let currentCue = null;
        
        for (const line of lines) {
            const trimmed = line.trim();
            
            if (!trimmed || trimmed.startsWith('WEBVTT') || trimmed.startsWith('NOTE')) {
                continue;
            }
            
            if (trimmed.includes('-->')) {
                const [start, end] = trimmed.split('-->').map(t => t.trim());
                currentCue = { start, end, text: '' };
            } else if (currentCue && trimmed) {
                currentCue.text += (currentCue.text ? ' ' : '') + trimmed;
            } else if (currentCue && !trimmed) {
                if (currentCue.text) cues.push(currentCue);
                currentCue = null;
            }
        }
        
        if (currentCue && currentCue.text) cues.push(currentCue);
        return cues;
    }

    async extractTranscript(vimeoUrl) {
        const videoId = this.extractVideoId(vimeoUrl);
        
        if (!videoId) {
            throw new Error('Invalid Vimeo URL format');
        }

        console.log(`Starting extraction for video ${videoId}`);

        // Try methods in order
        const methods = [
            () => this.tryPlayerConfig(videoId),
            () => this.tryDirectPageScraping(videoId)
        ];

        let result = null;
        
        for (let i = 0; i < methods.length; i++) {
            console.log(`Trying method ${i + 1}`);
            result = await methods[i]();
            if (result.success) {
                console.log(`Method ${i + 1} succeeded!`);
                break;
            }
            console.log(`Method ${i + 1} failed`);
        }
        
        if (!result || !result.success) {
            throw new Error(`No transcript found for video ${videoId} after trying all methods`);
        }

        const vttContent = result.vttContent || '';
        const cues = this.parseVTT(vttContent);
        const fullTranscript = cues.map(cue => cue.text).join(' ');

        return {
            video_id: videoId,
            vimeo_url: vimeoUrl,
            text: fullTranscript,
            transcript: cues,
            word_count: fullTranscript.split(/\s+/).filter(w => w.length > 0).length,
            cue_count: cues.length,
            extraction_method: result.method,
            transcript_url: result.transcriptUrl,
            extracted_at: new Date().toISOString()
        };
    }
}

try {
    const input = await Actor.getInput();
    
    if (!input || !input.video_url) {
        await Actor.pushData({
            error: 'No video URL provided',
            success: false,
            extracted_at: new Date().toISOString()
        });
    } else {
        const extractor = new VimeoTranscriptExtractor();
        const result = await extractor.extractTranscript(input.video_url);
        await Actor.pushData(result);
    }

} catch (error) {
    await Actor.pushData({
        error: error.message,
        success: false,
        extracted_at: new Date().toISOString()
    });
}

await Actor.exit();
