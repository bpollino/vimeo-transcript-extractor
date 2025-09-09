# Vimeo Transcript Extractor

🎬 Extract clean, timestamped transcripts from Vimeo videos automatically.

## 🚀 Features

- ✅ Supports public Vimeo videos with captions
- ✅ Multiple extraction methods for reliability  
- ✅ Timestamped transcript output
- ✅ Batch processing support
- ✅ JSON and LLM-ready formats
- ✅ High success rate with proprietary algorithms

## 📋 Input

- `video_url`: Single Vimeo video URL
- `video_urls`: Array of Vimeo video URLs (for batch processing)
- `language`: Optional language preference

## 📤 Output

```json
{
    "video_id": "1109387993",
    "vimeo_url": "https://vimeo.com/1109387993",
    "title": "Vimeo Video 1109387993",
    "text": "Complete transcript text...",
    "transcript": [
        {
            "text": "Hello world",
            "start": "00:00:01.000", 
            "end": "00:00:03.000"
        }
    ],
    "word_count": 150,
    "extraction_method": "player_config"
}
