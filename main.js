import { Actor } from 'apify';
import { gotScraping } from 'got-scraping';

await Actor.init();

class VimeoTranscriptExtractor {
    extractVideoId(url) {
        const match = url.match(/vimeo\.com\/(\d+)/);
        return match ? match[1] : null;
    }

    async tryPlayerConfig(videoId) {
        try {
            const url = `https://player.vimeo.com/video/${videoId}/config`;
            const response = await gotScraping({
                url: url,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': `https://vimeo.com/${videoId}`,
                    'Accept': 'application/json'
                },
                timeout: { response: 15000 }
            });

            const data = JSON.parse(response.body);
            
            // Look for text tracks in multiple locations
            const paths = [
                'request.text_tracks',
                'video.text_tracks',
                'textTracks',
                'request.files.text_tracks'
            ];
            
            for (const path of paths) {
                const tracks = this.getNestedProperty(data, path);
                if (Array.isArray(tracks) && tracks.length > 0) {
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
            // Player config failed
        }
        
        return { success: false };
    }

    getNestedProperty(obj, path) {
        return path.split('.').reduce((current, key) => {
            return current && current[key] !== undefined ? current[key] : null;
        }, obj);
    }

    async tryMultiplePatterns(videoId) {
        const videoIdNum = parseInt(videoId);
        const knownToken = "68c05cf5_0xead2e88faa1ccc8b7d60742e622f324a570da52e";
        
        // Multiple pattern attempts
        const patterns = [
            String(videoIdNum - 859435365), // Your original pattern
            String(videoIdNum - 860000000), // Rounded variation
            String(videoIdNum - 850000000), // Another variation
            videoId, // Same as video ID
            String(videoIdNum).substring(0, 9), // Truncated
            String(Math.floor(videoIdNum * 0.226)), // Ratio pattern
        ];

        const urlsToTry = [];
        
        for (const transcriptId of patterns) {
            urlsToTry.push(
                `https://vimeo.com/texttrack/${transcriptId}.vtt?token=${knownToken}`,
                `https://vimeo.com/texttrack/${transcriptId}.vtt`,
                `https://vimeo.com/texttrack/${transcriptId}.json?token=${knownToken}`,
                `https://vimeo.com/texttrack/${transcriptId}.json`
            );
        }

        for (const url of urlsToTry) {
            try {
                const response = await gotScraping({
                    url: url,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    timeout: { response: 8000 }
                });

                if (response.body && (response.body.includes('WEBVTT') || response.body.includes('-->'))) {
                    return {
                        success: true,
                        method: 'pattern_method',
                        transcriptUrl: url,
                        vttContent: response.body
                    };
                }
            } catch (error) {
                continue;
            }
        }
        
        return { success: false };
    }

    async tryDirectPageScraping(videoId) {
        try {
            const url = `https://vimeo.com/${videoId}`;
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
            
            // Look for transcript URLs in HTML
            const patterns = [
                /https:\/\/vimeo\.com\/texttrack\/(\d+)\.vtt\?token=([a-f0-9_]+)/g,
                /"url":"https:\\?\/\\?\/vimeo\.com\\?\/texttrack\\?\/(\d+)\.vtt\?token=([a-f0-9_]+)"/g,
            ];

            for (const pattern of patterns) {
                const matches = html.match(pattern);
                if (matches && matches.length > 0) {
                    const transcriptUrl = matches[0].replace(/\\?\//g, '/').replace(/\\"/g, '"');
                    
                    // Test the found URL
                    const testResponse = await gotScraping({
                        url: transcriptUrl,
                        headers: { 'User-Agent': 'Mozilla/5.0' },
                        timeout: { response: 8000 }
                    });

                    if (testResponse.body && testResponse.body.includes('WEBVTT')) {
                        return {
                            success: true,
                            method: 'page_scraping',
                            transcriptUrl: transcriptUrl,
                            vttContent: testResponse.body
                        };
                    }
                }
            }
        } catch (error) {
            // Page scraping failed
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

        // Try multiple methods in order of reliability
        const methods = [
            () => this.tryPlayerConfig(videoId),
            () => this.tryMultiplePatterns(videoId),
            () => this.tryDirectPageScraping(videoId)
        ];

        let result = null;
        
        for (const method of methods) {
            result = await method();
            if (result.success) break;
        }
        
        if (!result || !result.success) {
            throw new Error(`No transcript found for video ${videoId}. The video may not have captions available, or captions may be disabled.`);
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
