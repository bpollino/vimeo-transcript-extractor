import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

class VimeoTranscriptExtractor {
    constructor() {
        this.foundTranscripts = [];
    }

    async extractWithBrowser(vimeoUrl) {
        const videoId = this.extractVideoId(vimeoUrl);
        if (!videoId) {
            throw new Error('Invalid Vimeo URL format');
        }

        console.log(`Starting browser extraction for video ${videoId}`);

        const crawler = new PlaywrightCrawler({
            launchContext: {
                launchOptions: {
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox']
                }
            },
            requestHandler: async ({ page, request }) => {
                await this.handlePage(page, videoId);
            },
            maxRequestRetries: 2,
            requestHandlerTimeoutSecs: 60
        });

        await crawler.run([vimeoUrl]);
        
        if (this.foundTranscripts.length === 0) {
            throw new Error(`No transcript found for video ${videoId}`);
        }

        return this.foundTranscripts[0];
    }

    async handlePage(page, videoId) {
        console.log(`Loading page for video ${videoId}`);

        // Set up network request interception to catch transcript requests
        await page.route('**/*', async (route, request) => {
            const url = request.url();
            
            // Intercept .vtt files
            if (url.includes('.vtt') && url.includes('texttrack')) {
                console.log(`Intercepted transcript request: ${url}`);
                
                try {
                    const response = await route.fetch();
                    const vttContent = await response.text();
                    
                    if (vttContent.includes('WEBVTT')) {
                        console.log('Found VTT content via network interception');
                        const transcript = this.processTranscript(videoId, url, vttContent);
                        this.foundTranscripts.push(transcript);
                    }
                } catch (error) {
                    console.log(`Error fetching intercepted request: ${error.message}`);
                }
            }
            
            await route.continue();
        });

        // Wait for page to load
        await page.waitForLoadState('networkidle');
        
        // Try to trigger transcript loading by interacting with the page
        try {
            // Look for CC button and click it
            const ccButton = await page.locator('[data-testid="cc-button"], .vp-captions-button, button[aria-label*="caption"], button[aria-label*="subtitle"]').first();
            if (await ccButton.isVisible({ timeout: 5000 })) {
                console.log('Found CC button, clicking...');
                await ccButton.click();
                await page.waitForTimeout(2000);
            }
        } catch (error) {
            console.log('No CC button found or click failed');
        }

        // Look for transcript data in page variables
        const transcriptData = await page.evaluate(() => {
            // Check various global variables where Vimeo might store data
            const sources = [
                window.vimeoPlayerConfig,
                window.__INITIAL_STATE__,
                window.playerConfig,
                window.vimeoConfig
            ];

            for (const source of sources) {
                if (source && typeof source === 'object') {
                    const jsonStr = JSON.stringify(source);
                    const vttMatches = jsonStr.match(/https:\/\/vimeo\.com\/texttrack\/\d+\.vtt[^"'\s]*/g);
                    if (vttMatches && vttMatches.length > 0) {
                        return { urls: vttMatches, source: 'page_variables' };
                    }
                }
            }

            // Look in DOM for data attributes
            const elements = document.querySelectorAll('[data-transcript-url], [data-captions-url], [data-subtitle-url]');
            const urls = [];
            elements.forEach(el => {
                ['data-transcript-url', 'data-captions-url', 'data-subtitle-url'].forEach(attr => {
                    const url = el.getAttribute(attr);
                    if (url && url.includes('.vtt')) {
                        urls.push(url);
                    }
                });
            });

            if (urls.length > 0) {
                return { urls, source: 'dom_attributes' };
            }

            return null;
        });

        if (transcriptData && transcriptData.urls) {
            console.log(`Found ${transcriptData.urls.length} transcript URLs via ${transcriptData.source}`);
            
            for (const url of transcriptData.urls) {
                try {
                    const response = await page.goto(url);
                    if (response.ok()) {
                        const vttContent = await response.text();
                        if (vttContent.includes('WEBVTT')) {
                            console.log(`Successfully fetched VTT from: ${url}`);
                            const transcript = this.processTranscript(videoId, url, vttContent);
                            this.foundTranscripts.push(transcript);
                            break; // Found one, we're good
                        }
                    }
                } catch (error) {
                    console.log(`Failed to fetch ${url}: ${error.message}`);
                }
            }
        }

        // Additional wait to catch any delayed requests
        await page.waitForTimeout(3000);
    }

    extractVideoId(url) {
        const match = url.match(/vimeo\.com\/(\d+)/);
        return match ? match[1] : null;
    }

    processTranscript(videoId, transcriptUrl, vttContent) {
        const cues = this.parseVTT(vttContent);
        const fullTranscript = cues.map(cue => cue.text).join(' ');

        return {
            video_id: videoId,
            vimeo_url: `https://vimeo.com/${videoId}`,
            text: fullTranscript,
            transcript: cues,
            word_count: fullTranscript.split(/\s+/).filter(w => w.length > 0).length,
            cue_count: cues.length,
            extraction_method: 'browser_automation',
            transcript_url: transcriptUrl,
            extracted_at: new Date().toISOString()
        };
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
        const result = await extractor.extractWithBrowser(input.video_url);
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
