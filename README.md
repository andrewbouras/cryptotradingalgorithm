# Multi-Token RSI Monitor

This tool allows you to monitor RSI (Relative Strength Index) values for multiple tokens simultaneously on photon-sol.tinyastro.io.

## Setup

1. Install dependencies:
```
npm install
```

2. Start the application:
```
npm start
```

## How to Use

1. When the application starts, it will open a Chrome browser window and navigate to photon-sol.tinyastro.io
2. Wait for the site to load, then sign in and set up a chart with RSI indicator for any token
3. Press ENTER in the terminal to indicate you're ready to monitor tokens
4. The application will start an API server at http://localhost:3000

## Adding Tokens to Monitor

To add a new token to monitor, send a POST request to `http://localhost:3000/watch-token` with JSON body containing the mint address:

```json
{
  "mintAddress": "your-token-address-with-pump"
}
```

Example using curl:
```
curl -X POST http://localhost:3000/watch-token -H "Content-Type: application/json" -d '{"mintAddress": "8kbcZ...pump"}'
```

The system will:
1. Open a new browser window for each token
2. Search for the token by the provided mint address
3. Select the first result from the search
4. Begin monitoring and logging RSI values for that token

## Requirements

- Only tokens with addresses containing "pump" will be monitored
- Each token will be monitored in a separate browser window
- RSI values are logged to the console with timestamps

## Stopping the Application

Press Ctrl+C in the terminal to stop monitoring and close all browser windows.

## Prerequisites

- Node.js (v14 or higher recommended)
- npm
- Google Chrome installed

## Installation

1. Clone this repository or download the files
2. Install dependencies:

```bash
npm install
```

## Usage

1. Make sure all Chrome windows are closed before running the script
2. Run the script:

```bash
node index.js
```

3. The script will:
   - Launch Chrome using your Profile 77 with all your extensions enabled
   - Navigate to the trading website
   - Wait for you to press ENTER after you've signed in and set up your chart
   - After pressing ENTER, the script will log RSI values to the console every 0.5 seconds

4. To stop the script, press `Ctrl+C` in your terminal

## Troubleshooting Extension Issues

If extensions aren't loading correctly:

1. Make sure Chrome is completely closed before running the script
2. Verify that the Chrome profile path is correct:
   - Current path: `C:\Users\nimmi\AppData\Local\Google\Chrome\User Data\Profile 77`
3. If needed, modify the profile path in `index.js`
4. Check that your Chrome executable path is correct:
   - Current path: `C:\Program Files\Google\Chrome\Application\chrome.exe`

## Notes

- The script uses Puppeteer-Extra with the Stealth plugin to help bypass bot detection
- Extensions should automatically load with your Chrome profile
- The script looks for RSI values inside TradingView chart widgets
- The CSS selectors used to find the RSI value might need adjustment if the website structure changes

## Notes

- The script attempts to use your existing Chrome profile, which preserves cookies, extensions, and settings
- The stealth plugin helps bypass common bot detection mechanisms like Cloudflare
- If the profile cannot be accessed, it will launch Chrome with default settings (stealth still enabled)
- The script looks for RSI values inside frames, particularly focusing on TradingView widgets
- The CSS selectors used to find the RSI value might need adjustment if the website structure changes
- If you don't see RSI values being logged, the selectors might need to be updated based on the actual site structure

## Troubleshooting

If you encounter browser launch issues:
- Make sure Chrome is completely closed before running the script (use Task Manager to check)
- Try running without specifying a profile by removing the profile-related arguments
- Make sure the path to your Chrome installation is correct
- Check if your Chrome profile is locked or in use by another process
- If you're still having issues with Cloudflare, you might need to manually solve a CAPTCHA once, then the script should work 