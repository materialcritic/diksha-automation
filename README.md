# DIKSHA Automation

Automated course completion for DIKSHA (Dedicated Channel for Knowledge Sharing At Scale) — an Indian government e-learning platform. This project automates video playback, PDF scrolling, and module progression.

## Features

- **Auto-play Videos** — plays videos muted at 1.5x speed in the background
- **PDF Handling** — automatically scrolls through PDF content
- **Auto-advance Modules** — clicks next buttons to progress through course sections
- **Background Processing** — runs entirely in the browser without manual intervention
- **Diagnostic Tool** — analyzes page structure for troubleshooting

## Prerequisites

- Node.js (v14+)
- npm
- Google Chrome
- DIKSHA account access

## Installation

1. Clone the repository:
```bash
git clone https://github.com/materialcritic/diksha-automation
cd diksha-automation
```

2. Install dependencies:
```bash
npm install puppeteer
```

## Usage

### Progress Monitor (Main Script)

Automatically completes course content:

```bash
node diksha-progress-monitor.js
```

**What it does:**
- Navigates to the course URL
- Detects videos and plays them muted at 1.5x speed
- Waits for videos to finish
- Detects PDF content and scrolls through it
- Clicks "Next" buttons to advance modules
- Repeats until course completion

**Console output:**
- `[VIDEO]` — video detected and playing
- `[PDF]` — PDF scrolling in progress
- `[MODULE]` — advancing to next module
- `[IDLE]` — waiting for content to load

### Diagnostic Tool

Analyzes page structure for debugging:

```bash
node diksha-diagnostic.js
```

**Output:**
- Saves detailed report to `diksha-diagnostic.txt`
- Lists all buttons, links, videos, iframes
- Identifies relevant course controls
- Shows page text and structure
- Useful for troubleshooting page changes

## Configuration

Edit `diksha-progress-monitor.js` to change:

```javascript
const COURSE_URL = "https://learning.diksha.gov.in/diksha/course.php?id=...";
```

Change the `id`, `section`, and `modeActive` parameters to target different courses.

## How It Works

### Progress Monitor Flow

1. **Detect Content**
   - Check for video elements
   - Check for PDF content
   - Check for "Next" buttons

2. **Handle Videos**
   - Mute audio
   - Set playback speed to 1.5x
   - Auto-play if paused
   - Wait for completion
   - Wait 6 seconds for progress recording

3. **Handle PDFs**
   - Scroll down through content
   - Count scrolls
   - Click "next PDF" button when available

4. **Advance Modules**
   - Find enabled "Next" or "Continue" buttons
   - Click to move to next module
   - Reset and repeat

### Diagnostic Tool

Extracts and logs:
- Page text content
- All interactive buttons
- Links and navigation
- Video elements and metadata
- iframe containers
- Elements matching course-related keywords
- Video/player related elements

## Files

| File | Purpose |
|------|---------|
| `diksha-progress-monitor.js` | Main automation script for course completion |
| `diksha-diagnostic.js` | Diagnostic tool for page analysis |
| `diksha-profile/` | Chrome user profile (created automatically) |
| `diksha-diagnostic.txt` | Generated diagnostic report |

## Video Playback Settings

- **Muted** — audio disabled to avoid distraction
- **Speed** — 1.5x playback rate for faster completion
- **Autoplay** — automatically starts if paused
- **Background** — plays while waiting, no interaction needed

## Troubleshooting

### Script runs but doesn't advance

1. Run the diagnostic tool:
```bash
node diksha-diagnostic.js
```

2. Check the generated `diksha-diagnostic.txt` for:
   - Button labels and IDs
   - Video element details
   - Page structure issues

3. Update control detection patterns if UI elements changed

### Videos not playing

- Check browser console for errors
- Ensure Chrome has permission to autoplay
- Verify video is not restricted/blocked

### PDF not scrolling

- Verify PDF is loaded in an accessible container
- Check if scroll container has `overflow: auto` or `overflow: scroll`
- Use diagnostic tool to identify PDF element

## Performance

- Videos at 1.5x speed complete ~33% faster
- PDF scrolling respects page load times
- 6-second pause after video ensures DIKSHA records progress
- Idle check every 2 seconds to avoid excessive CPU usage

## Notes

- Browser window stays open for monitoring/debugging
- Persistent Chrome profile preserves login state
- Script handles multi-frame pages (iframes)
- Runs headless-false for visibility during execution

## License

MIT

## Disclaimer

Use only for your own learning accounts. Automated course completion may violate terms of service of some platforms. Use responsibly.
