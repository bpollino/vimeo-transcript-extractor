import { Actor } from 'apify';
import { gotScraping } from 'got-scraping';

await Actor.init();

class VimeoTranscriptExtractor {
    extractVideoId(url) {
        const match = url.match(/vimeo\.com\/(\d+)/);
        return match ? match[1] : null;
    }

    async tryPatternMethod(videoId) {
        const videoIdNum = parseInt(videoId);
        const transcriptId = String(videoIdNum - 859435365);
        const token = "68c05cf5_0xead2e88faa1ccc8b7d60742e622f324a570da52e";
        
        const url = `https://vimeo.com/texttrack/${transcriptId}.vtt?token=${token}`;
        
        try {
            const response = await gotScraping({
                url: url,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: { response: 10000 }
            });

            if (response.body && response.body.includes('WEBVTT')) {
                return {
                    success: true,
                    transcriptUrl: url,
                    vttContent: response.body
                };
            }
        } catch (error) {
            // Failed to get transcript
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

        const result = await this.tryPatternMethod(videoId);
        
        if (!result.success) {
            throw new Error('No transcript found for this video');
        }

        const cues = this.parseVTT(result.vttContent);
        const fullTranscript = cues.map(cue => cue.text).join(' ');

        return {
            video_id: videoId,
            vimeo_url: vimeoUrl,
            text: fullTranscript,
            transcript: cues,
            word_count: fullTranscript.split(/\s+/).length,
            extraction_method: 'pattern_method',
            extracted_at: new Date().toISOString()
        };
    }
}

try {
    const input = await Actor.getInput();
    
    if (!input || !input.video_url) {
        throw new Error('No video URL provided');
    }

    const extractor = new VimeoTranscriptExtractor();
    const result = await extractor.extractTranscript(input.video_url);
    await Actor.pushData(result);

} catch (error) {
    await Actor.pushData({
        error: error.message,
        success: false,
        extracted_at: new Date().toISOString()
    });
}

await Actor.exit();
