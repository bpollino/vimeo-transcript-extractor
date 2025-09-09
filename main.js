import { Actor } from 'apify';
import { gotScraping } from 'got-scraping';

await Actor.init();

class VimeoTranscriptExtractor {
    extractVideoId(url) {
        const match = url.match(/vimeo\.com\/(\d+)/);
        return match ? match[1] : null;
    }

    async tryAdvancedScraping(videoId) {
        console.log(`Trying advanced scraping for video ${videoId}`);
        try {
            const url = `https://vimeo.com/${videoId}`;
            
            // First request to get the initial page
            const response = await gotScraping({
                url: url,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Upgrade-Insecure-Requests': '1'
                },
                timeout: { response: 30000 }
            });

            const html = response.body;
            console.log(`Page HTML length: ${html.length}`);

            // Extract all script content
            const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
            console.log(`Found ${scriptMatches.length} script tags`);

            // Look for Vimeo config data in scripts
            for (const script of scriptMatches) {
                // Remove script tags
                const scriptContent = script.replace(/<\/?script[^>]*>/gi, '');
                
                // Look for various patterns that might contain transcript URLs
                const patterns = [
                    // Direct VTT URLs
                    /https:\/\/vimeo\.com\/texttrack\/\d+\.vtt\?token=[a-f0-9_]+/gi,
                    
                    // Encoded VTT URLs
                    /vimeo\.com\\?\/texttrack\\?\/\d+\.vtt[^"'\s]*/gi,
                    
                    // Config objects with text tracks
                    /"text_tracks":\s*\[[^\]]*\]/gi,
                    
                    // Player config references
                    /config[^}]*texttrack[^}]*/gi
                ];

                for (const pattern of patterns) {
                    const matches = scriptContent.match(pattern);
                    if (matches) {
                        console.log(`Found ${matches.length} potential matches in script`);
                        
                        for (const match of matches.slice(0, 5)) {
                            let testUrl = match;
                            
                            // Clean up the URL
                            testUrl = testUrl.replace(/\\+/g, '');
                            testUrl = testUrl.replace(/^["']|["']$/g, '');
                            
                            // If it looks like a direct URL, test it
                            if (testUrl.includes('texttrack') && testUrl.includes('.vtt')) {
                                if (!testUrl.startsWith('https://')) {
                                    testUrl = 'https://' + testUrl.replace(/^\/+/, '');
                                }
                                
                                console.log(`Testing URL: ${testUrl}`);
                                
                                try {
                                    const vttResponse = await gotScraping({
                                        url: testUrl,
                                        headers: {
                                            'User-Agent': 'Mozilla/5.0',
                                            'Referer': url
                                        },
                                        timeout: { response: 10000 }
                                    });

                                    if (vttResponse.statusCode === 200 && 
                                        vttResponse.body && 
                                        vttResponse.body.includes('WEBVTT')) {
                                        console.log('Found working transcript URL!');
                                        return {
                                            success: true,
                                            method: 'advanced_scraping',
                                            transcriptUrl: testUrl,
                                            vttContent: vttResponse.body
                                        };
                                    }
                                } catch (testError) {
                                    console.log(`URL test failed: ${testError.message}`);
                                }
                            }
                        }
                    }
                }
            }

            // Try pattern-based approach as fallback
            return await this.tryPatternFallback(videoId, html);
            
        } catch (error) {
            console.log(`Advanced scraping error: ${error.message}`);
        }
        
        return { success: false };
    }

    async tryPatternFallback(videoId, html) {
        console.log('Trying pattern fallback approach');
        
        // Extract potential tokens from the page
        const tokenMatches = html.match(/[a-f0-9]{8}_0x[a-f0-9]{40}/g) || [];
        console.log(`Found ${tokenMatches.length} potential tokens`);
        
        if (tokenMatches.length > 0) {
            // Try your known pattern with extracted tokens
            const transcriptId = String(parseInt(videoId) - 859435365);
            
            for (const token of tokenMatches.slice(0, 10)) {
                const testUrl = `https://vimeo.com/texttrack/${transcriptId}.vtt?token=${token}`;
                console.log(`Testing pattern URL: ${testUrl}`);
                
                try {
                    const response = await gotScraping({
                        url: testUrl,
                        headers: { 'User-Agent': 'Mozilla/5.0' },
                        timeout: { response: 8000 }
                    });

                    if (response.statusCode === 200 && 
                        response.body && 
                        response.body.includes('WEBVTT')) {
                        console.log('Pattern method succeeded!');
                        return {
                            success: true,
                            method: 'pattern_fallback',
                            transcriptUrl: testUrl,
                            vttContent: response.body
                        };
                    }
                } catch (testError) {
                    console.log(`Pattern test failed: ${testError.message}`);
                }
            }
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

        const result = await this.tryAdvancedScraping(videoId);
        
        if (!result.success) {
            throw new Error(`No transcript found for video ${videoId}`);
        }

        const cues = this.parseVTT(result.vttContent);
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
