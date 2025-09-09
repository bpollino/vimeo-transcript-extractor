import { Actor } from 'apify';
import { gotScraping } from 'got-scraping';

await Actor.init();

class VimeoTranscriptExtractor {
    constructor() {
        this.knownMappings = [
            {
                videoId: "1109387993",
                transcriptId: "249952628",
                token: "68c05cf5_0xead2e88faa1ccc8b7d60742e622f324a570da52e"
            }
        ];
    }

    extractVideoId(url) {
        const match = url.match(/vimeo\.com\/(\d+)/);
        return match ? match[1] : null;
    }

    generateTranscriptIds(videoId) {
        const videoIdNum = parseInt(videoId);
        const knownDifference = -859435365;
        
        return [
            String(videoIdNum + knownDifference),
            String(videoIdNum - 860000000),
            String(videoIdNum - 850000000),
            videoId,
            String(Math.floor(videoIdNum * 0.226)),
        ].filter(id => id && id.length >= 6);
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
                timeout: { response: 10000 }
            });

            const data = JSON.parse(response.body);
            const textTracks = this.findTextTracks(data);
            
            if (textTracks && textTracks.length > 0) {
                const englishTrack = textTracks.find(track => 
                    (track.lang && track.lang.startsWith('en')) || 
                    (track.language && track.language.startsWith('en'))
                ) || textTracks[0];
                
                return {
                    success: true,
                    method: 'player_config',
                    transcriptUrl: englishTrack.url,
                    trackInfo: englishTrack
                };
            }
        } catch (error) {
            // Player config failed, continue to next method
        }
        
        return { success: false };
    }

    findTextTracks(config) {
        const paths = [
            'request.text_tracks',
            'video.text_tracks',
            'textTracks',
            'request
