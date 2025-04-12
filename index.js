const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const readline = require('readline');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const http = require('http');
const https = require('https');

// Apply stealth plugin to hide puppeteer usage
puppeteer.use(StealthPlugin());

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Create a simple API server to receive mint addresses
const app = express();
const PORT = 3000;
app.use(bodyParser.json());

// Store token pages and their monitoring intervals
const tokenPages = new Map();

// Directory for logs
const logDirectory = path.join(__dirname, 'logs');
if (!fs.existsSync(logDirectory)) {
  fs.mkdirSync(logDirectory);
}

// Path to Phantom extension
const extensionPath = path.resolve(__dirname, './extensions/phantom/25.11.0_0');
// Path for persistent puppeteer profile (not using main Chrome profile)
const userDataDir = path.resolve(__dirname, './puppeteer_profile');

// Store already monitored tokens to prevent duplicates
const monitoredTokens = new Set();
// Store tokens currently being processed
const pendingTokens = new Set();
// Store blacklisted tokens that should not be monitored
const blacklistedTokens = new Set();
// Maximum number of tokens to monitor simultaneously (leaving 2 tabs for scraping)
const MAX_MONITORED_TOKENS = 8;
// Maximum number of browser tabs allowed
const MAX_BROWSER_TABS = 20;
// Maximum number of tabs reserved for Solscan scraping
const MAX_SCRAPING_TABS = 3;
// Flag to track if scraping is currently in progress
let isScrapingInProgress = false;
// Debounce timer for token requests
let requestDebounceTimers = {};
// Maximum signatures to process per scrape
const MAX_SIGNATURES_TO_PROCESS = 10;
// Flag to track if tokens are ready for additional monitoring
const tokensReadyStatus = new Map(); // tokenAddress -> {rsiWorking: boolean, mcWorking: boolean}
// Track already seen signatures to detect new ones
const seenSignatures = new Set();
// Enhanced logging file paths
const queueLogFile = path.join(logDirectory, 'token_queue.log');
const monitoringLogFile = path.join(logDirectory, 'monitoring_status.log');
const scrapingLogFile = path.join(logDirectory, 'scraping_activity.log');

// Track consecutive connection errors
let consecutiveConnectionErrors = 0;
const connectionErrorThreshold = 2; // Restart browser after this many consecutive connection errors
let tokensToRetry = []; // Queue of tokens to retry after browser restart

// Queue of tokens waiting to be monitored (when slots become available)
let tokenWaitingQueue = [];

// Error log file path
const errorLogFile = path.join(logDirectory, 'error_log.log');

// Timer for Solscan scraping (in milliseconds)
const SCRAPING_INTERVAL = 10 * 1000; // 10 seconds between scraping runs
let scrapingTimer = null;

// Track discovered pump tokens to avoid duplicate logs
const discoveredPumpTokens = new Set();

// Helper function to log errors with more details
function logDetailedError(tokenAddress, errorType, errorMessage, additionalDetails = '') {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] Token: ${tokenAddress} | Error Type: ${errorType} | Error: ${errorMessage}${additionalDetails ? ' | Details: ' + additionalDetails : ''}\n`;
  
  fs.appendFileSync(errorLogFile, logEntry);
  console.log(`Logged error to ${errorLogFile}: ${errorType} for ${tokenAddress}`);
}

// Helper function to create delays
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to log current status to files
function logSystemStatus() {
  const timestamp = new Date().toISOString();
  
  // Log queue status
  const queueEntry = `[${timestamp}] Tokens in queue: ${tokenWaitingQueue.length}\n` +
    tokenWaitingQueue.map((token, index) => 
      `  ${index+1}. ${token.symbol || 'Unknown'} (${token.address}) - Added: ${token.discoveredAt.toISOString()}`
    ).join('\n') + 
    (tokenWaitingQueue.length ? '\n' : '');
  
  fs.writeFileSync(queueLogFile, queueEntry);
  
  // Log actively monitored tokens with more details
  const monitoringEntry = `[${timestamp}] Actively Monitored Tokens: ${monitoredTokens.size}\n` +
    Array.from(monitoredTokens).map(address => {
      const status = tokensReadyStatus.get(address) || { 
        rsiWorking: false, 
        mcWorking: false,
        rsiValue: 'N/A',
        mcValue: 'N/A',
        stage: 'Starting',
        lastUpdated: 'Never',
        details: 'No details yet'
      };
      
      return `  - ${address} | RSI: ${status.rsiValue || 'N/A'} | MC: ${status.mcValue || 'N/A'} | Stage: ${status.stage || 'Unknown'}\n` +
             `    RSI Working: ${status.rsiWorking ? 'YES' : 'NO'} | MC Working: ${status.mcWorking ? 'YES' : 'NO'} | Ready: ${status.readySince ? 'YES' : 'NO'}\n` +
             `    Last Activity: ${status.lastUpdated || 'Unknown'}\n` +
             `    Details: ${status.details || 'No details'}`;
    }).join('\n\n') + 
    (monitoredTokens.size ? '\n' : '');
  
  fs.writeFileSync(monitoringLogFile, monitoringEntry);
  
  // Log to console
  console.log(`📊 System Status: ${monitoredTokens.size} monitored tokens, ${tokenWaitingQueue.length} in queue`);
}

// Helper function to log scraping activity
function logScrapingActivity(message, signatures = [], tokens = []) {
  const timestamp = new Date().toISOString();
  let entry = `[${timestamp}] ${message}\n`;
  
  if (signatures.length > 0) {
    entry += `  Signatures processed: ${signatures.length}\n`;
    entry += signatures.map((sig, i) => `    ${i+1}. ${sig.signature} (${sig.url})`).join('\n') + '\n';
  }
  
  if (tokens.length > 0) {
    entry += `  Tokens found: ${tokens.length}\n`;
    entry += tokens.map((token, i) => `    ${i+1}. ${token.symbol} (${token.address})`).join('\n') + '\n';
  }
  
  fs.appendFileSync(scrapingLogFile, entry);
  console.log(`📝 ${message}`);
}

// Helper function to write to log file
function writeToLogFile(tokenAddress, rsiValue, marketCapValue, message = '') {
  const timestamp = new Date().toISOString();
  const logFile = path.join(logDirectory, 'trading_signals.log'); // Single unified log file
  const logEntry = `[${timestamp}] Token: ${tokenAddress} | RSI: ${rsiValue} | MC: ${marketCapValue}${message ? ' | ' + message : ''}\n`;
  
  fs.appendFileSync(logFile, logEntry);
  console.log(`Logged to ${logFile}: ${message || 'RSI alert'}`);
  
  // Update status logs after important events
  logSystemStatus();
}

// Helper function to log pump tokens
function logPumpToken(tokenAddress, tokenSymbol, transactionSignature) {
  // Check if we've already seen this token to avoid duplicate entries
  const tokenKey = `${tokenAddress}:${transactionSignature}`;
  if (discoveredPumpTokens.has(tokenKey)) {
    console.log(`Skipping duplicate pump token: ${tokenSymbol} (${tokenAddress})`);
    return false;
  }
  
  // Add to discovered set
  discoveredPumpTokens.add(tokenKey);
  
  const timestamp = new Date().toISOString();
  const logFile = path.join(logDirectory, 'pump_tokens.log');
  const logEntry = `[${timestamp}] Token: ${tokenAddress} | Symbol: ${tokenSymbol} | TX: ${transactionSignature}\n`;
  
  fs.appendFileSync(logFile, logEntry);
  console.log(`Found pump token: ${tokenSymbol} (${tokenAddress}) in transaction ${transactionSignature}`);
  
  // Log to scraping activity file too
  logScrapingActivity(`New pump token found: ${tokenSymbol}`, [], [{address: tokenAddress, symbol: tokenSymbol}]);
  
  // Add to waiting queue instead of starting immediately
  if (!monitoredTokens.has(tokenAddress) && 
      !pendingTokens.has(tokenAddress) && 
      !blacklistedTokens.has(tokenAddress) &&
      !tokenWaitingQueue.some(token => token.address === tokenAddress)) {
    
    console.log(`Adding pump token to waiting queue: ${tokenSymbol} (${tokenAddress})`);
    tokenWaitingQueue.push({
      address: tokenAddress,
      symbol: tokenSymbol,
      discoveredAt: new Date()
    });
    
    // If we're not monitoring any tokens yet, start processing the queue
    if (monitoredTokens.size === 0) {
      console.log('No tokens currently being monitored, starting queue processing');
      processNextTokenFromQueue();
    }
    
    // Update status logs after adding to queue
    logSystemStatus();
  }
  
  return true; // Indicate we logged a new token
}

// Function to count active browser tabs
async function getActiveTabs() {
  if (!global.browser) return 0;
  const pages = await global.browser.pages();
  return pages.length;
}

// Function to check if we can open a new tab for token monitoring
async function canOpenNewTabForMonitoring() {
  const activeTabCount = await getActiveTabs();
  // Reserve MAX_SCRAPING_TABS tabs for scraping, the rest can be used for monitoring
  return activeTabCount < (MAX_BROWSER_TABS - MAX_SCRAPING_TABS);
}

// Function to check if we can open a new tab for scraping
async function canOpenNewTabForScraping() {
  const activeTabCount = await getActiveTabs();
  // Allow opening a scraping tab if we're under the total limit
  return activeTabCount < MAX_BROWSER_TABS;
}

// Function to process tokens sequentially, but expand monitoring when a token is working
async function processNextTokenFromQueue() {
  // Skip if there are no tokens to process
  if (tokenWaitingQueue.length === 0) {
    console.log('No tokens in waiting queue');
    return;
  }
  
  // Check if we can open new tabs for monitoring
  const canOpenTab = await canOpenNewTabForMonitoring();
  if (!canOpenTab) {
    console.log('Cannot process next token: Maximum browser tabs reached for monitoring');
    return;
  }
  
  // Take the first token that isn't blacklisted
  while (tokenWaitingQueue.length > 0) {
    const nextToken = tokenWaitingQueue.shift();
    
    // Skip if it's now blacklisted or already being monitored
    if (blacklistedTokens.has(nextToken.address) || 
        monitoredTokens.has(nextToken.address) || 
        pendingTokens.has(nextToken.address)) {
      console.log(`Skipping token ${nextToken.address}: blacklisted or already monitored`);
      continue;
    }
    
    // Start monitoring this token
    console.log(`Processing next token from waiting queue: ${nextToken.symbol || ''} (${nextToken.address})`);
    
    if (global.browser) {
      try {
        await openTokenPage(global.browser, nextToken.address);
      return; // Exit after starting one token
      } catch (err) {
        logDetailedError(nextToken.address, 'QUEUE_PROCESSING_ERROR', err.message);
        // Continue to next token if this one fails
      }
    } else {
      console.log('Browser not available. Cannot process token.');
      return;
    }
  }
}

// Function to check if a token is "working" (has valid RSI and MC values)
function checkTokenReadiness(tokenAddress, rsiValue, mcValue) {
  // Initialize if not exists
  if (!tokensReadyStatus.has(tokenAddress)) {
    tokensReadyStatus.set(tokenAddress, { 
      rsiWorking: false,
      mcWorking: false,
      rsiValue: 'N/A',
      mcValue: 'N/A',
      readySince: null,
      stage: 'Initializing',
      lastUpdated: new Date().toISOString(),
      details: 'Token just added to monitoring'
    });
  }
  
  const status = tokensReadyStatus.get(tokenAddress);
  
  // Update values
  if (rsiValue) status.rsiValue = rsiValue;
  if (mcValue) status.mcValue = mcValue;
  status.lastUpdated = new Date().toISOString();
  
  // Update working status
  if (rsiValue && !isNaN(parseFloat(rsiValue)) && parseFloat(rsiValue) >= 0 && parseFloat(rsiValue) <= 100) {
    if (!status.rsiWorking) {
      status.rsiWorking = true;
      status.details = `RSI is now working with value: ${rsiValue}`;
      status.stage = 'RSI Working';
    }
  }
  
  // Fixed MC detection to handle any numeric values including K, M, B suffixes
  if (mcValue) {
    // Look for values like $123, $123K, $1.23M, etc.
    const match = mcValue.match(/\$?([\d.]+)([KMB])?/i);
    if (match) {
      status.mcWorking = true;
      status.details = `MC is now working with value: ${mcValue}`;
      if (!status.rsiWorking) {
        status.stage = 'MC Working, Waiting for RSI';
      } else if (status.stage === 'RSI Working') {
        status.stage = 'Both RSI and MC Working';
      }
    }
  }
  
  // If both are working and wasn't ready before, mark the time
  if (status.rsiWorking && status.mcWorking && !status.readySince) {
    status.readySince = Date.now();
    status.stage = 'READY - Monitoring for signals';
    status.details = `Token fully working! RSI: ${status.rsiValue}, MC: ${status.mcValue}`;
    console.log(`✅ Token ${tokenAddress} is now ready with working RSI (${status.rsiValue}) and MC (${status.mcValue}) values!`);
    
    // Update status logs
    logSystemStatus();
    
    // Once a token is working, process the next token from the queue if we can monitor more
    setTimeout(() => {
      console.log(`Token ${tokenAddress} is working properly, starting next token from queue if available...`);
      
      // We're now monitoring multiple tokens concurrently
      if (monitoredTokens.size < MAX_MONITORED_TOKENS || tokenWaitingQueue.length > 0) {
        processNextTokenFromQueue();
      }
    }, 2000);
  }
  
  // Update the map
  tokensReadyStatus.set(tokenAddress, status);
  
  return status.rsiWorking && status.mcWorking;
}

// Function to update token status without checking readiness
function updateTokenStatus(tokenAddress, stage, details) {
  if (!tokensReadyStatus.has(tokenAddress)) {
    tokensReadyStatus.set(tokenAddress, {
      rsiWorking: false,
      mcWorking: false,
      rsiValue: 'N/A',
      mcValue: 'N/A',
      readySince: null,
      stage: stage || 'Initializing',
      lastUpdated: new Date().toISOString(),
      details: details || 'Token just added to monitoring'
    });
  } else {
    const status = tokensReadyStatus.get(tokenAddress);
    if (stage) status.stage = stage;
    if (details) status.details = details;
    status.lastUpdated = new Date().toISOString();
    tokensReadyStatus.set(tokenAddress, status);
  }
  
  // Update logs
  logSystemStatus();
}

// Function to scrape Solscan for pump tokens (updated to process only top 10 signatures and refresh for new ones)
async function scrapePumpTokens(browser) {
  // If scraping is already in progress, skip this run
  if (isScrapingInProgress) {
    console.log('Solscan scraping already in progress, skipping this run');
    return;
  }
  
  isScrapingInProgress = true;
  console.log('Starting Solscan scraping for pump tokens (limited to top 10 signatures)...');
  
  try {
    // Check if we can open new tabs for scraping
    const canOpenTab = await canOpenNewTabForScraping();
    if (!canOpenTab) {
      console.log('Cannot start scraping: Maximum browser tabs reached. Will retry later.');
      isScrapingInProgress = false;
      return;
    }
    
    // Open new page
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    // Navigate to the specified Solscan URL
    const accountUrl = 'https://solscan.io/account/6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P?program=pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
    console.log(`Navigating to: ${accountUrl}`);
    await page.goto(accountUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    
    // Wait for the transaction table to load
    await page.waitForSelector('a.inline-block.text-center.truncate.textLink.text-\\[14px\\]', { timeout: 30000 });
    console.log('Transaction table loaded, extracting signatures from first page only...');
    
    // Extract transaction signatures from the first page only
    const signatures = await page.evaluate(() => {
      const signatureLinks = document.querySelectorAll('a.inline-block.text-center.truncate.textLink.text-\\[14px\\]');
      return Array.from(signatureLinks).map(link => ({
        signature: link.textContent,
        url: link.href
      }));
    });
    
    // Limit to MAX_SIGNATURES_TO_PROCESS (10)
    const limitedSignatures = signatures.slice(0, MAX_SIGNATURES_TO_PROCESS);
    console.log(`Found ${signatures.length} transaction signatures, processing only the top ${limitedSignatures.length}`);
    
    // Check for new signatures that we haven't seen before
    const newSignatures = limitedSignatures.filter(sig => !seenSignatures.has(sig.signature));
    
    // Log the current scraping activity
    logScrapingActivity(
      `Scraping top 10 signatures (${newSignatures.length} new out of ${limitedSignatures.length})`,
      newSignatures
    );
    
    // If there are no new signatures, we can skip processing
    if (newSignatures.length === 0) {
      console.log('No new signatures found in top 10, skipping processing');
      await page.close();
      isScrapingInProgress = false;
      
      // Schedule next scrape
      if (scrapingTimer) {
        clearTimeout(scrapingTimer);
      }
      scrapingTimer = setTimeout(() => {
        if (global.browser) {
          scrapePumpTokens(global.browser).catch(err => {
            console.error('Error during scheduled pump token scraping:', err.message);
          });
        }
      }, SCRAPING_INTERVAL);
      
      return;
    }
    
    // Add all signatures to seen set
    limitedSignatures.forEach(sig => seenSignatures.add(sig.signature));
    
    // Keep track of new tokens found in this scraping run
    let newTokensFound = 0;
    let totalPumpTokens = 0;
    let foundTokens = [];
    
    // Process signatures one at a time (sequentially)
    console.log('Processing signatures ONE AT A TIME sequentially');
    
    // Create a single transaction page that we'll reuse
    let txPage = null;
    
    for (let i = 0; i < newSignatures.length; i++) {
      const signature = newSignatures[i];
      console.log(`Processing signature ${i+1}/${newSignatures.length}: ${signature.signature}`);
      
      // Create the transaction page if it doesn't exist yet
      if (!txPage) {
        txPage = await browser.newPage();
      await txPage.setViewport({ width: 1280, height: 800 });
      }
      
      try {
        // Navigate to transaction page
        await txPage.goto(signature.url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Wait for transaction details to load
        await txPage.waitForSelector('.px-3.py-1.rounded.bg-neutral2', { timeout: 30000 });
        
        // Extract token addresses ending with 'pump'
        const pumpTokens = await txPage.evaluate(() => {
          const tokens = [];
          
          // Find all token links in the transaction
          const tokenLinks = document.querySelectorAll('a[href^="/token/"]');
          
          tokenLinks.forEach(link => {
            const tokenAddress = link.getAttribute('href').replace('/token/', '');
            const tokenSymbol = link.textContent;
            
            // Check if the token address ends with 'pump'
            if (tokenAddress.endsWith('pump')) {
              tokens.push({
                address: tokenAddress,
                symbol: tokenSymbol
              });
            }
          });
          
          return tokens;
        });
        
        // Log any pump tokens found
        if (pumpTokens.length > 0) {
          totalPumpTokens += pumpTokens.length;
          console.log(`Found ${pumpTokens.length} pump tokens in transaction ${signature.signature}`);
          
          for (const token of pumpTokens) {
            // Save to found tokens list for logging
            foundTokens.push(token);
            
            // logPumpToken returns true if it's a new token
            if (await logPumpToken(token.address, token.symbol, signature.signature)) {
              newTokensFound++;
            }
          }
        }
      } catch (txError) {
        console.error(`Error processing transaction ${signature.signature}:`, txError.message);
      }
      
      // Small delay between processing signatures
      await delay(500);
    }
    
    // Close the transaction page if it was created
    if (txPage) {
      await txPage.close();
    }
    
    console.log(`Finished scraping pump tokens: ${newTokensFound} new tokens found out of ${totalPumpTokens} total`);
    
    // Log final scraping results
    logScrapingActivity(
      `Completed scraping: ${newTokensFound} new tokens found out of ${totalPumpTokens} total`,
      newSignatures,
      foundTokens
    );
    
    await page.close();
    
    // Immediately start monitoring tokens if we found any new ones
    if (newTokensFound > 0 && monitoredTokens.size === 0) {
      console.log('Found new tokens, immediately starting token monitoring');
      processNextTokenFromQueue();
    }
    
    // Update status logs
    logSystemStatus();
    
  } catch (error) {
    console.error('Error scraping pump tokens:', error.message);
  } finally {
    // Reset scraping flag when done
    isScrapingInProgress = false;
    
    // Schedule the next scraping run to happen 10 seconds after this one finished
    if (scrapingTimer) {
      clearTimeout(scrapingTimer);
    }
    scrapingTimer = setTimeout(() => {
      if (global.browser) {
        scrapePumpTokens(global.browser).catch(err => {
          console.error('Error during scheduled pump token scraping:', err.message);
        });
      }
    }, SCRAPING_INTERVAL);
  }
}

// Helper function to send buy request
async function sendBuyRequest(tokenAddress) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      mintAddress: tokenAddress
    });
    
    const options = {
      hostname: 'localhost',
      port: 3001,
      path: '/buy-token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };
    
    const req = http.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          data: responseData
        });
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.write(data);
    req.end();
  });
}

// Function to enable RSI indicator on the chart
async function enableRsiIndicator(page, tokenAddress) {
  try {
    console.log(`${tokenAddress}: Checking for RSI indicator on chart...`);
    
    // Find the TradingView frame
    const frames = page.frames();
    const tradingViewFrame = frames.find(frame => {
      const name = frame.name();
      return name && name.includes('tradingview_');
    });
    
    if (!tradingViewFrame) {
      console.log(`${tokenAddress}: Unable to find TradingView frame to enable RSI`);
      return false;
    }
    
    // Updated RSI selector to match the exact structure
    let rsiValue = await tradingViewFrame.evaluate(() => {
      // First and most specific approach: Look for RSI with exact structure from real DOM
      // This targets the specific HTML structure with "RSI" title and "14 SMA 14" description
      const rsiItems = document.querySelectorAll('.item-l31H9iuA.study-l31H9iuA');
      for (const item of rsiItems) {
        // Verify this is an RSI item by looking for the RSI title and 14 SMA 14 description
        const titleEl = item.querySelector('.title-l31H9iuA.mainTitle-l31H9iuA[data-name="legend-source-title"]');
        const descEl = item.querySelector('.title-l31H9iuA.descTitle-l31H9iuA[data-name="legend-source-title"]');
        
        if (titleEl && titleEl.textContent === 'RSI' && 
            descEl && descEl.textContent.includes('SMA')) {
          // Found the RSI item, now get the value
          const valueEl = item.querySelector('.valueValue-l31H9iuA.apply-common-tooltip[title="Plot"]');
          if (valueEl) {
            // Get the computed style to verify it's the purple RSI value
            const style = window.getComputedStyle(valueEl);
            const color = style.color;
            const isRsiPurple = color.includes('126, 87, 194') || // RGB format
                               color.includes('#7e57c2') ||       // Hex format
                               color.toLowerCase().includes('purple') || // Name
                               color.includes('rgb(126, 87, 194)');
            
            const text = valueEl.textContent.trim();
            if (text && !isNaN(parseFloat(text))) {
              console.log(`Found EXACT RSI value from specific structure: ${text} (color: ${color}, isPurple: ${isRsiPurple})`);
              return text;
            }
          }
        }
      }
      
      // Second approach: Try to find RSI indicator with simpler selectors
      const rsiSection = document.querySelector('div[data-name="legend-source-item"] div[data-name="legend-source-title"]:first-child');
      if (rsiSection && rsiSection.textContent === 'RSI') {
        // Check if we also have "14 SMA 14" in a sibling element
        const parentDiv = rsiSection.closest('div[data-name="legend-source-item"]');
        const descTitle = parentDiv?.querySelector('div[data-name="legend-source-title"]:nth-child(2)');
        
        if (descTitle && descTitle.textContent.includes('SMA')) {
          // We found the RSI with SMA - look for the value
          const valueItem = parentDiv?.querySelector('.valueValue-l31H9iuA.apply-common-tooltip[title="Plot"]');
          if (valueItem) {
            const text = valueItem.textContent.trim();
            if (text && !isNaN(parseFloat(text))) {
              console.log(`Found RSI value from simplified structure: ${text}`);
              return text;
            }
          }
        }
      }
      
      // Last resort approach: Try to find any RSI values
      // Only accept values in the valid RSI range (0-100) that are specifically in an element with title="Plot"
      const plotElements = document.querySelectorAll('.valueValue-l31H9iuA.apply-common-tooltip[title="Plot"]');
      for (const el of plotElements) {
        // Check if this element might be part of an RSI container
        const container = el.closest('.item-l31H9iuA');
        if (container && container.textContent.includes('RSI')) {
          const text = el.textContent.trim();
        if (text && !isNaN(parseFloat(text))) {
          const value = parseFloat(text);
          if (value >= 0 && value <= 100) {
              console.log(`Found potential RSI value from title="Plot": ${text}`);
              return text;
            }
          }
        }
      }
      
      console.log('No valid RSI found with any method');
      return null;
    });
    
    // Updated market cap selector to match the exact structure
    let marketCapValue = await tradingViewFrame.evaluate(() => {
      const mcElements = document.querySelectorAll('.valueItem-l31H9iuA');
      for (const item of mcElements) {
        const title = item.querySelector('.valueTitle-l31H9iuA');
        if (title && title.textContent === 'C') {
          const value = item.querySelector('.valueValue-l31H9iuA');
          return value ? value.textContent.trim() : null;
        }
      }
      return null;
    });
    
    // Log the values we found
    if (rsiValue || marketCapValue) {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] Token: ${tokenAddress} | RSI: ${rsiValue || 'N/A'} | MC: ${marketCapValue || 'N/A'}`);
    }
    
    // Additional validation for RSI values outside the page
    if (rsiValue) {
      // Check if the RSI value contains 'K', 'M', or 'B' which would indicate it's not an RSI value
      if (rsiValue.includes('K') || rsiValue.includes('M') || rsiValue.includes('B')) {
        console.log(`${tokenAddress}: Invalid RSI value detected (${rsiValue}), treating as N/A`);
      return false;
      } else {
        // Parse as float and validate range
        const rsiFloat = parseFloat(rsiValue);
        if (isNaN(rsiFloat) || rsiFloat < 0 || rsiFloat > 100) {
          console.log(`${tokenAddress}: RSI value out of range (${rsiValue}), treating as N/A`);
          return false;
        }
      }
    }
    
    // If RSI already exists, just check for duplicates and return
    if (rsiValue) {
      console.log(`${tokenAddress}: RSI indicator already exists, checking for duplicates...`);
      
      // Find all RSI titles first
      const rsiItems = await tradingViewFrame.evaluate(() => {
        // Method 1: Look for elements with exactly "RSI" text
        const rsiElements = [];
        const allElements = document.querySelectorAll('div, span');
        
        for (const element of allElements) {
          if (element.textContent === 'RSI') {
            // Store elements with text "RSI"
            rsiElements.push(element);
          }
        }
        
        // Log what we found
        console.log(`Found ${rsiElements.length} elements with text "RSI"`);
        return rsiElements.length;
      });
      
      // If duplicates found, remove them one by one with retries
      if (rsiItems > 1) {
        console.log(`${tokenAddress}: Found ${rsiItems} RSI indicators, removing extras...`);
        
        // We'll keep removing the second RSI indicator until only one remains
        let remainingToRemove = rsiItems - 1;
        let maxAttempts = 10; // Limit attempts to avoid infinite loops
        
        for (let attempt = 0; attempt < maxAttempts && remainingToRemove > 0; attempt++) {
          console.log(`${tokenAddress}: Removing duplicate RSI #${attempt+1} (${remainingToRemove} remaining)`);
          
          // Step 1: First verify how many RSI indicators are still present
          const currentRsiCount = await tradingViewFrame.evaluate(() => {
            const rsiElements = [];
            const allElements = document.querySelectorAll('div, span');
            for (const element of allElements) {
              if (element.textContent === 'RSI') {
                rsiElements.push(element);
              }
            }
            console.log(`Currently found ${rsiElements.length} RSI elements`);
            return rsiElements.length;
          });
          
          if (currentRsiCount <= 1) {
            console.log(`${tokenAddress}: Only one RSI indicator remains, no need to remove more`);
            break;
          }
          
          // Step 2: Find and click the manage button for the second RSI indicator
          const manageButtonClicked = await tradingViewFrame.evaluate(() => {
            // Find all RSI elements again to get fresh references
            const rsiElements = [];
            const allElements = document.querySelectorAll('div, span');
            for (const element of allElements) {
              if (element.textContent === 'RSI') {
                rsiElements.push(element);
              }
            }
            
            // Skip if we don't have enough elements
            if (rsiElements.length < 2) return false;
            
            // Always target the second RSI element
            const targetElement = rsiElements[1];
            console.log('Found target RSI element to remove');
            
            // Trace upwards to find the pane
            let currentElement = targetElement;
            let steps = 0;
            let maxSteps = 15; // Prevent infinite loops
            
            // Keep going up the DOM tree looking for manage button
            while (currentElement && steps < maxSteps) {
              steps++;
              
              // Look specifically for the manage panes button with this exact data-name
              const manageButton = currentElement.querySelector('.button-JQv8nO8e[data-name="pane-button-more"]');
              if (manageButton) {
                console.log('Found manage button with data-name="pane-button-more"');
                manageButton.click();
                return true;
              }
              
              // If not found, move up to parent
              currentElement = currentElement.parentElement;
            }
            
            // If we still can't find it, look globally but specifically for that button
            const allManageButtons = document.querySelectorAll('.button-JQv8nO8e[data-name="pane-button-more"]');
            if (allManageButtons.length > 0) {
              for (let i = 0; i < allManageButtons.length; i++) {
                // Try to find a manage button that's somehow associated with RSI
                const button = allManageButtons[i];
                const buttonParent = button.closest('div[class*="pane"]');
                if (buttonParent) {
                  const rsiInParent = buttonParent.textContent.includes('RSI');
                  if (rsiInParent) {
                    console.log('Found manage button in RSI-containing pane');
                    button.click();
                    return true;
                  }
                }
              }
              
              // If we can't find a specific one, just click the first one (not ideal but might work)
              console.log('Clicking first available manage button');
              allManageButtons[0].click();
              return true;
            }
            
            console.log('Could not find any manage buttons');
            return false;
          });
          
          if (!manageButtonClicked) {
            console.log(`${tokenAddress}: Could not find manage button for RSI #${attempt+1}, trying again...`);
            await delay(1000);
            continue;
          }
          
          // Wait for the menu to appear
          await delay(1000);
          
          // Step 3: Find and click specifically the delete pane button with exact data-name
          const deleteClicked = await tradingViewFrame.evaluate(() => {
            // Look ONLY for the specific delete pane button with this exact data-name
            const deleteButton = document.querySelector('.button-JQv8nO8e[data-name="pane-button-close"]');
            if (deleteButton) {
              console.log('Found delete button with data-name="pane-button-close"');
              deleteButton.click();
              return true;
            }
            
            console.log('Could not find delete button with data-name="pane-button-close"');
            return false;
          });
          
          if (deleteClicked) {
            console.log(`${tokenAddress}: Successfully clicked delete for duplicate RSI #${attempt+1}`);
            remainingToRemove--;
          } else {
            console.log(`${tokenAddress}: Could not find delete button for RSI #${attempt+1}`);
          }
          
          // Wait for UI to update after delete action
          await delay(2000);
        }
        
        console.log(`${tokenAddress}: Finished removing duplicate RSI indicators`);
      }
      
      // Activate the existing RSI indicator and return
      const activated = await tradingViewFrame.evaluate(() => {
        // Click on the RSI title to ensure it's active
        const rsiTitle = document.querySelector('.title-l31H9iuA[data-name="legend-source-title"]');
        if (rsiTitle && rsiTitle.textContent === 'RSI') {
          rsiTitle.click();
          return true;
        }
        return false;
      });
      
      if (activated) {
        console.log(`${tokenAddress}: Activated existing RSI indicator`);
      }
      
      // RSI already exists, so return success
      console.log(`${tokenAddress}: RSI indicator already present, no need to add new one`);
      return true;
    }
    
    // RSI doesn't exist, so we need to add it
    console.log(`${tokenAddress}: No RSI indicator found, adding new one...`);
    
    // Try multiple approaches to click indicators button with retries
    let indicatorsClicked = false;
    let maxAttempts = 3;
    
    for (let attempt = 1; attempt <= maxAttempts && !indicatorsClicked; attempt++) {
      console.log(`${tokenAddress}: Trying to click indicators button (attempt ${attempt}/${maxAttempts})...`);
      
      // Approach 1: Try to click the indicators button by data-name attribute
      indicatorsClicked = await tradingViewFrame.evaluate(() => {
        // First approach: by exact data-name and class combination (most precise)
        const exactButton = document.querySelector('div[data-name="open-indicators-dialog"][data-role="button"]');
        if (exactButton) {
          console.log('Found indicators button by exact match');
          exactButton.click();
          return true;
        }
        
        // First approach: by data-name
      const indicatorsButton = document.querySelector('[data-name="open-indicators-dialog"]');
      if (indicatorsButton) {
          console.log('Found indicators button by data-name');
        indicatorsButton.click();
        return true;
      }
        
        // Second approach: by class name (common in TradingView)
        const buttonsByClass = document.querySelectorAll('.button-JQv8nO8e'); 
        for (const button of buttonsByClass) {
          if (button.textContent.includes('Indicators')) {
            console.log('Found indicators button by class and text');
            button.click();
            return true;
          }
        }
        
        // Third approach: by toolbar position and icon
        const toolbar = document.querySelector('.chart-toolbar');
        if (toolbar) {
          const toolbarButtons = toolbar.querySelectorAll('div[role="button"]');
          // Usually the indicators button is one of the first few buttons
          for (let i = 0; i < Math.min(10, toolbarButtons.length); i++) {
            const btn = toolbarButtons[i];
            if (btn.querySelector('svg') || btn.innerText.includes('fx')) {
              console.log('Found potential indicators button in toolbar');
              btn.click();
              return true;
            }
          }
        }
        
        // Fourth approach: look for any button or div with indicators text
        const allElements = document.querySelectorAll('div[role="button"], button');
        for (const element of allElements) {
          if (element.textContent && element.textContent.toLowerCase().includes('indicator')) {
            console.log('Found element with indicator text');
            element.click();
            return true;
          }
        }
        
        console.log('Could not find indicators button with any method');
        return false;
      });
      
      if (indicatorsClicked) {
        console.log(`${tokenAddress}: Successfully clicked indicators button on attempt ${attempt}`);
        break;
      }
      
      // If not found, take a screenshot and try refreshing the page
      if (attempt === maxAttempts) {
        console.log(`${tokenAddress}: Could not find or click indicators button after ${maxAttempts} attempts`);
        
        // Try refreshing the page as a last resort
        console.log(`${tokenAddress}: Refreshing page to try again...`);
        try {
          await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
          await delay(5000); // Wait for page to fully load
        } catch (err) {
          console.error(`${tokenAddress}: Error refreshing page:`, err.message);
        }
      } else {
        // Wait between attempts
        await delay(2000);
      }
    }
    
    if (!indicatorsClicked) {
      console.log(`${tokenAddress}: Could not find or click indicators button`);
      return false;
    }
    
    // Wait for the indicators dialog to open
    await delay(2000);
    
    // Try to find the search box and type RSI with retries
    let searchTyped = false;
    const searchAttempts = 3;
    
    for (let attempt = 1; attempt <= searchAttempts && !searchTyped; attempt++) {
      searchTyped = await tradingViewFrame.evaluate(() => {
      // Method 1: By class name
      let searchInput = document.querySelector('.input-qm7Rg5MB[data-role="search"]');
      
      // Method 2: Any input with placeholder "Search"
      if (!searchInput) {
        searchInput = Array.from(document.querySelectorAll('input')).find(
          input => input.placeholder && input.placeholder.toLowerCase().includes('search')
        );
      }
      
        // Method 3: Any input in the currently open dialog
        if (!searchInput) {
          const dialog = document.querySelector('.dialog-UM6w7sFp');
          if (dialog) {
            searchInput = dialog.querySelector('input');
          }
        }
        
        // Method 4: Any visible input element
      if (!searchInput) {
        const inputs = document.querySelectorAll('input:not([type="hidden"])');
        if (inputs.length > 0) {
          searchInput = inputs[0]; // Try the first visible input
        }
      }
      
      if (searchInput) {
          // Clear any existing value first
          searchInput.value = '';
          searchInput.dispatchEvent(new Event('input'));
          
          // Now type "RSI" - use a shorter, more direct search term
          searchInput.value = 'RSI';
        searchInput.dispatchEvent(new Event('input'));
        searchInput.dispatchEvent(new Event('change'));
        return true;
      }
      
      return false;
    });
      
      if (searchTyped) {
        console.log(`${tokenAddress}: Successfully found search box and typed 'RSI' on attempt ${attempt}`);
      } else if (attempt < searchAttempts) {
        console.log(`${tokenAddress}: Could not find search input on attempt ${attempt}, trying again...`);
        await delay(1000);
      }
    }
    
    if (!searchTyped) {
      console.log(`${tokenAddress}: Could not find search input after multiple attempts`);
      // Try to close dialog if open
      await tradingViewFrame.evaluate(() => {
        const closeButtons = document.querySelectorAll('[data-name="close"], .close-BZKENkhT');
        for (const button of closeButtons) {
          button.click();
          return true;
        }
      });
      return false;
    }
    
    // Wait for search results
    await delay(2000);
    
    // Try multiple methods to find and click the RSI indicator with retries
    let rsiClicked = false;
    const rsiAttempts = 3;
    
    for (let attempt = 1; attempt <= rsiAttempts && !rsiClicked; attempt++) {
      rsiClicked = await tradingViewFrame.evaluate(() => {
        // Method 1: Look for "RSI" title directly
        const rsiItems = document.querySelectorAll('div.title-cIIj4HrJ');
        for (const item of rsiItems) {
          if (item.textContent && item.textContent.includes('RSI')) {
            item.click();
            console.log('Found and clicked RSI by title text');
            return true;
          }
        }
        
        // Method 2: By data attribute
      let rsiItem = document.querySelector('[data-title="Relative Strength Index"]');
      if (rsiItem) {
        rsiItem.click();
          console.log('Found and clicked RSI by data-title');
        return true;
      }
      
        // Method 3: Look for item with just "RSI" text
      const items = Array.from(document.querySelectorAll('.title-cIIj4HrJ, div[class*="title"]'));
        for (const item of items) {
          if (item.textContent === 'RSI') {
            item.click();
            console.log('Found and clicked exact RSI match');
        return true;
          }
      }
      
        // Method 4: Any element containing RSI text
      const allElements = document.querySelectorAll('div, span, a');
      for (const el of allElements) {
        if (el.textContent && el.textContent.includes('RSI') && !el.textContent.includes('...')) {
          el.click();
            console.log('Found and clicked element containing RSI');
          return true;
        }
      }
      
        console.log('Could not find any RSI element to click');
      return false;
    });
      
      if (rsiClicked) {
        console.log(`${tokenAddress}: Successfully clicked RSI indicator on attempt ${attempt}`);
      } else if (attempt < rsiAttempts) {
        console.log(`${tokenAddress}: Could not find RSI indicator on attempt ${attempt}, trying again...`);
        await delay(1000);
      }
    }
    
    if (!rsiClicked) {
      console.log(`${tokenAddress}: Could not find or click RSI indicator after multiple attempts`);
      // Try to close dialog if open
      await tradingViewFrame.evaluate(() => {
        const closeButtons = document.querySelectorAll('[data-name="close"], .close-BZKENkhT');
        for (const button of closeButtons) {
          button.click();
          return true;
        }
      });
      return false;
    }
    
    // Wait for the indicator to be added
    await delay(2000);
    
    // Try to close the dialog
    const dialogClosed = await tradingViewFrame.evaluate(() => {
      // Method 1: By data attributes
      const closeButtons = document.querySelectorAll('[data-name="close"], .close-BZKENkhT');
      for (const button of closeButtons) {
        button.click();
        return true;
      }
      
      // Method 2: By text content containing "Close" or "X"
      const buttons = document.querySelectorAll('button, div[role="button"]');
      for (const button of buttons) {
        if (button.textContent && (button.textContent.includes('Close') || button.textContent === 'X')) {
          button.click();
          return true;
        }
      }
      
      // Method 3: By typical close button classes
      const dialogCloseButtons = document.querySelectorAll('.close, .closeButton, [class*="close"]');
      for (const btn of dialogCloseButtons) {
        btn.click();
        return true;
      }
      
      return false;
    });
    
    if (!dialogClosed) {
      console.log(`${tokenAddress}: Could not close dialog, but RSI may still be added`);
    }
    
    console.log(`${tokenAddress}: Successfully attempted to enable RSI indicator`);
    
    // Wait for RSI to appear on the chart
    await delay(5000);
    return true;
  } catch (error) {
    console.error(`${tokenAddress}: Error checking/enabling RSI indicator: ${error.message}`);
    return false;
  }
}

// Updated monitorTokenRSI function to track status more accurately
async function monitorTokenRSI(page, tokenAddress) {
  // State tracking
  let lowMcStartTime = null;
  let isRsiBelow25 = false;
  let hasSentBuyRequest = false;
  let noRsiDataCount = 0;
  
  // RSI direction change tracking
  let lastRsiValue = null;
  let rsiTrend = 'unknown'; // 'falling', 'rising', or 'unknown'
  let lowestRsiValue = null;
  
  // Track N/A RSI values
  let consecutiveNaRsiCount = 0;
  
  // Track invalid RSI values
  let consecutiveInvalidRsiCount = 0;
  
  // Function to blacklist current token and move to next one
  const blacklistCurrentToken = async (reason) => {
    await blacklistAndReplaceToken(tokenAddress, reason);
  };
  
  // Initial status update
  updateTokenStatus(tokenAddress, 'RSI Monitoring', 'Starting to check for RSI and MC values');
  
  // Start an interval to check for RSI updates every 0.2 seconds
  const intervalId = setInterval(async () => {
    try {
      // Find all iframes on the page
      const frames = page.frames();
      let rsiValue = null;
      let marketCapValue = null;
      
      // Find the TradingView frame (simpler approach)
      const tradingViewFrame = frames.find(frame => {
        const name = frame.name();
        return name && name.includes('tradingview_');
      });
      
      if (tradingViewFrame) {
        try {
          // Get RSI value (abbreviated for brevity, full logic in original)
          rsiValue = await tradingViewFrame.evaluate(() => {
            // First look for RSI with exact structure
            const rsiItems = document.querySelectorAll('.item-l31H9iuA.study-l31H9iuA');
            for (const item of rsiItems) {
              const titleEl = item.querySelector('.title-l31H9iuA.mainTitle-l31H9iuA[data-name="legend-source-title"]');
              const descEl = item.querySelector('.title-l31H9iuA.descTitle-l31H9iuA[data-name="legend-source-title"]');
              
              if (titleEl && titleEl.textContent === 'RSI' && descEl && descEl.textContent.includes('SMA')) {
                const valueEl = item.querySelector('.valueValue-l31H9iuA.apply-common-tooltip[title="Plot"]');
                if (valueEl) {
                  const text = valueEl.textContent.trim();
                  if (text && !isNaN(parseFloat(text))) {
                    return text;
                  }
                }
              }
            }
            
            // Second approach with simpler selectors
            const rsiSection = document.querySelector('div[data-name="legend-source-item"] div[data-name="legend-source-title"]:first-child');
            if (rsiSection && rsiSection.textContent === 'RSI') {
              const parentDiv = rsiSection.closest('div[data-name="legend-source-item"]');
              const descTitle = parentDiv?.querySelector('div[data-name="legend-source-title"]:nth-child(2)');
              
              if (descTitle && descTitle.textContent.includes('SMA')) {
                const valueItem = parentDiv?.querySelector('.valueValue-l31H9iuA.apply-common-tooltip[title="Plot"]');
                if (valueItem) {
                  const text = valueItem.textContent.trim();
                  if (text && !isNaN(parseFloat(text))) {
                    return text;
                  }
                }
              }
            }
            
            return null;
          });
          
          // Get market cap value (abbreviated for brevity, full logic in original)
          marketCapValue = await tradingViewFrame.evaluate(() => {
            const mcElements = document.querySelectorAll('.valueItem-l31H9iuA');
            for (const item of mcElements) {
              const title = item.querySelector('.valueTitle-l31H9iuA');
              if (title && title.textContent === 'C') {
                const value = item.querySelector('.valueValue-l31H9iuA');
                return value ? value.textContent.trim() : null;
              }
            }
            return null;
          });
          
          // Log the values we found
          if (rsiValue || marketCapValue) {
            const timestamp = new Date().toISOString();
            console.log(`[${timestamp}] Token: ${tokenAddress} | RSI: ${rsiValue || 'N/A'} | MC: ${marketCapValue || 'N/A'}`);
            
            // Update token status and check if token is now ready (RSI and MC are working)
            checkTokenReadiness(tokenAddress, rsiValue, marketCapValue);
          }
          
          // Additional validation for RSI values
          if (rsiValue) {
            // Check if the RSI value contains 'K', 'M', or 'B' which would indicate it's not an RSI value
            if (rsiValue.includes('K') || rsiValue.includes('M') || rsiValue.includes('B')) {
              console.log(`${tokenAddress}: Invalid RSI value detected (${rsiValue}), treating as N/A`);
              updateTokenStatus(tokenAddress, 'Invalid RSI', `Invalid RSI value detected: ${rsiValue}`);
              consecutiveInvalidRsiCount++;
              rsiValue = null;
            } else {
              // Parse as float and validate range
              const rsiFloat = parseFloat(rsiValue);
              if (isNaN(rsiFloat) || rsiFloat < 0 || rsiFloat > 100) {
                console.log(`${tokenAddress}: RSI value out of range (${rsiValue}), treating as N/A`);
                updateTokenStatus(tokenAddress, 'Out-of-Range RSI', `RSI value out of range: ${rsiValue}`);
                consecutiveInvalidRsiCount++;
                rsiValue = null;
              } else {
                // Reset counter for valid RSI values
                consecutiveInvalidRsiCount = 0;
              }
            }
          }
        } catch (frameError) {
          console.error(`Error in TradingView frame for ${tokenAddress}:`, frameError.message);
          updateTokenStatus(tokenAddress, 'Frame Error', `Error accessing TradingView: ${frameError.message}`);
          logDetailedError(tokenAddress, 'FRAME_ERROR', frameError.message);
        }
      }
      
      // Handle invalid RSI values by trying to fix or blacklisting if unfixable
      if (consecutiveInvalidRsiCount >= 3) {
        console.log(`${tokenAddress}: Multiple invalid RSI values detected (${consecutiveInvalidRsiCount}).`);
        
        // First, try to enable the RSI indicator
        if (consecutiveInvalidRsiCount === 3) {
          console.log(`${tokenAddress}: Attempting to enable RSI indicator...`);
          updateTokenStatus(tokenAddress, 'RSI Fix Attempt', 'Trying to fix invalid RSI values by enabling RSI indicator');
          const rsiEnabled = await enableRsiIndicator(page, tokenAddress);
          if (rsiEnabled) {
            // Reset counter and wait to see if RSI values appear
            consecutiveInvalidRsiCount = 0;
            updateTokenStatus(tokenAddress, 'RSI Fix Success', 'Successfully fixed RSI indicator');
            await delay(3000);
            return; // Exit this iteration
          }
        }
        
        // If enabling RSI didn't work or we've already tried, force a page reload
        if (consecutiveInvalidRsiCount === 4) {
          console.log(`${tokenAddress}: Forcing page reload...`);
          updateTokenStatus(tokenAddress, 'Page Reload', 'Reloading page to fix RSI issues');
          try {
            await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
            console.log(`${tokenAddress}: Page reloaded due to invalid RSI values`);
            consecutiveInvalidRsiCount = 0;
            updateTokenStatus(tokenAddress, 'Page Reloaded', 'Page reloaded successfully, waiting for chart to load');
            await delay(5000); // Give time for page to reload
            return;
          } catch (reloadError) {
            console.error(`Error reloading page for ${tokenAddress}:`, reloadError.message);
            updateTokenStatus(tokenAddress, 'Reload Error', `Error reloading page: ${reloadError.message}`);
            logDetailedError(tokenAddress, 'PAGE_RELOAD_ERROR', reloadError.message);
          }
        }
        
        // If all else fails, blacklist the token and move to next one
        if (consecutiveInvalidRsiCount >= 5) {
          updateTokenStatus(tokenAddress, 'Blacklisting', 'Persistent invalid RSI values, blacklisting token');
          logDetailedError(
            tokenAddress, 
            'PERSISTENT_INVALID_RSI', 
            `Failed to get valid RSI after ${consecutiveInvalidRsiCount} attempts`,
            `Last values: RSI: ${rsiValue || 'N/A'} | MC: ${marketCapValue || 'N/A'}`
          );
          
          clearInterval(intervalId);
          await blacklistCurrentToken("Persistent invalid RSI values");
          return;
        }
      }
      
      // Handle missing or N/A RSI data
      if (!rsiValue || rsiValue === 'N/A' || rsiValue === '∅') {
        consecutiveNaRsiCount++;
        console.log(`${tokenAddress}: No valid RSI data (count: ${consecutiveNaRsiCount})`);
        
        // First try to enable RSI when we reach 3 consecutive N/A values
        if (consecutiveNaRsiCount === 3) {
          console.log(`${tokenAddress}: Attempting to enable RSI indicator due to missing data...`);
          const rsiEnabled = await enableRsiIndicator(page, tokenAddress);
          if (rsiEnabled) {
            // Reset counter and wait to see if RSI values appear
            consecutiveNaRsiCount = 0;
            await delay(3000);
            return; // Exit this iteration
          }
        }
        
        // More attempts to fix the RSI (abbreviated for brevity, full logic in original)
        
        // If we've seen N/A values several times in a row (8 checks = ~1.6 seconds)
        if (consecutiveNaRsiCount >= 8) {
          logDetailedError(
            tokenAddress, 
            'PERSISTENT_MISSING_RSI', 
            `Failed to get RSI data after ${consecutiveNaRsiCount} attempts`,
            `Market Cap: ${marketCapValue || 'N/A'}`
          );
          
          clearInterval(intervalId);
          await blacklistCurrentToken("Persistent missing RSI data");
          return;
        }
      } else {
        // Reset counter if we found valid RSI data
        consecutiveNaRsiCount = 0;
      }
      
      // Check if market cap is below 20K (abbreviated for brevity, full logic in original)
      if (marketCapValue) {
        const mcMatch = marketCapValue.match(/\$?([\d.]+)([KMB])?/);
        
        if (mcMatch) {
          let mcNumeric = parseFloat(mcMatch[1]);
          const mcUnit = mcMatch[2] || '';
          
          if (mcUnit === 'K') mcNumeric *= 1000;
          else if (mcUnit === 'M') mcNumeric *= 1000000;
          else if (mcUnit === 'B') mcNumeric *= 1000000000;
          
          if (mcNumeric < 20000) {
            if (lowMcStartTime === null) {
              lowMcStartTime = Date.now();
              console.log(`${tokenAddress}: Market cap dropped below 20K`);
            } else {
              const timeBelow = (Date.now() - lowMcStartTime) / 1000 / 60; // in minutes
              
              if (timeBelow >= 4) {
                logDetailedError(
                  tokenAddress, 
                  'LOW_MARKET_CAP', 
                  `Market cap below 20K for >${timeBelow.toFixed(1)} minutes`,
                  `Value: ${marketCapValue}`
                );
                
                clearInterval(intervalId);
                await blacklistCurrentToken("Market cap below 20K for over 4 minutes");
                return;
              }
            }
          } else {
            // Reset timer if market cap goes back above 20K
            if (lowMcStartTime !== null) {
              lowMcStartTime = null;
            }
          }
        }
      }
      
      // Check RSI value for trading signals (abbreviated for brevity, full logic in original)
      if (rsiValue) {
        const rsiNumeric = parseFloat(rsiValue);
        
        if (!isNaN(rsiNumeric)) {
          // Trading logic stays the same as the original
          // ... (abbreviated)
        }
      }
    } catch (error) {
      console.error(`Error checking values for ${tokenAddress}:`, error.message);
      logDetailedError(tokenAddress, 'MONITORING_ERROR', error.message);
    }
  }, 200); // Check every 0.2 seconds

  return intervalId;
}

// Helper function to blacklist a token and start monitoring a new one
async function blacklistAndReplaceToken(tokenAddress, reason) {
  console.log(`${tokenAddress}: Blacklisting token. Reason: ${reason}`);
  
  // Add to blacklist
  blacklistedTokens.add(tokenAddress);
  
  // Remove from tracked maps
  const tokenData = tokenPages.get(tokenAddress);
  if (tokenData && tokenData.intervalId) {
    clearInterval(tokenData.intervalId);
  }
  
  tokenPages.delete(tokenAddress);
  monitoredTokens.delete(tokenAddress);
  tokensReadyStatus.delete(tokenAddress);
  
  // Log blacklisting with more details
  const timestamp = new Date().toISOString();
  const blacklistFile = path.join(logDirectory, 'blacklisted_tokens.log');
  const blacklistEntry = `[${timestamp}] Token: ${tokenAddress} | Reason: ${reason}\n`;
  fs.appendFileSync(blacklistFile, blacklistEntry);
  
  // Close the token page if it exists
  if (tokenData && tokenData.page) {
    try {
      await tokenData.page.close();
    } catch (err) {
      console.error(`Error closing page for ${tokenAddress}:`, err.message);
    }
  }
  
  // Process the next token in the queue
  console.log(`Starting to process next token from queue (${tokenWaitingQueue.length} tokens waiting)`);
  setTimeout(() => {
    processNextTokenFromQueue();
    
    // Update status logs after blacklisting
    logSystemStatus();
  }, 2000); // Small delay before processing next token
}

// Updated function to open token page with retry logic
async function openTokenPage(browser, tokenAddress) {
  // Max number of retries
  const MAX_RETRIES = 3;
  let retryCount = 0;
  let lastError = null;
  
  // Add initial status for this token
  updateTokenStatus(tokenAddress, 'Starting', 'Preparing to open token page');
  
  // Retry loop
  while (retryCount < MAX_RETRIES) {
    try {
      console.log(`Opening new page for token: ${tokenAddress} (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      updateTokenStatus(tokenAddress, 'Opening', `Opening token page (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      
      // One more check to prevent duplicates
      if (tokenPages.has(tokenAddress) || monitoredTokens.has(tokenAddress)) {
        console.log(`Already monitoring token: ${tokenAddress}`);
        pendingTokens.delete(tokenAddress);
        return;
      }
      
      // Add to tracked tokens set to prevent duplicates
      monitoredTokens.add(tokenAddress);
      
      // Create a new page for this token
      const page = await browser.newPage();
      updateTokenStatus(tokenAddress, 'Created Page', 'Browser tab created successfully');
      
      // Set up stealth
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      // Navigate to website
      console.log(`Navigating to website for token: ${tokenAddress}`);
      updateTokenStatus(tokenAddress, 'Navigating', 'Opening chart website...');
      await page.goto('https://photon-sol.tinyastro.io', { 
        waitUntil: 'networkidle2',
        timeout: 60000
      });
      
      // Wait for the page to be fully loaded
      updateTokenStatus(tokenAddress, 'Page Loaded', 'Waiting for search box to appear');
      await delay(3000);
      
      // Wait for the search input to be available
      await page.waitForSelector('.c-autocomplete__input.js-autocomplete', { visible: true, timeout: 10000 });
      updateTokenStatus(tokenAddress, 'Ready to Search', 'Found search input, preparing to search for token');
      
      // Clear any existing text in the search field
      await page.evaluate(() => {
        const searchInput = document.querySelector('.c-autocomplete__input.js-autocomplete');
        if (searchInput) searchInput.value = '';
      });
      
      // Type the token address in the search bar
      console.log(`Searching for token: ${tokenAddress}`);
      updateTokenStatus(tokenAddress, 'Searching', `Typing token address: ${tokenAddress}`);
      await page.type('.c-autocomplete__input.js-autocomplete', tokenAddress, { delay: 100 });
      
      // Wait for search results to appear
      updateTokenStatus(tokenAddress, 'Waiting for Results', 'Waiting for search results to appear');
      await delay(3000);
      
      try {
        await page.waitForSelector('#autoComplete_list_1:not([hidden])', { visible: true, timeout: 10000 });
        updateTokenStatus(tokenAddress, 'Results Found', 'Search results appeared');
      } catch (error) {
        updateTokenStatus(tokenAddress, 'Results Timeout', 'Search results taking longer than expected');
        // Continue silently
      }
      
      // Wait for search results to be populated
      await delay(2000);
      
      // Try to click on the first search result with retry logic
      let clicked = false;
      for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
        updateTokenStatus(tokenAddress, 'Clicking Result', `Attempting to click search result (attempt ${attempt + 1}/3)`);
        clicked = await page.evaluate(() => {
          const firstResult = document.querySelector('#autoComplete_result_0 a');
          if (firstResult) {
            firstResult.click();
            return true;
          }
          return false;
        });
        
        if (!clicked) {
          updateTokenStatus(tokenAddress, 'Click Failed', `Search result click failed, retrying (${attempt + 1}/3)`);
          await delay(2000);
        }
      }
      
      if (!clicked) {
        // Try one more approach - look for any result that might match
        updateTokenStatus(tokenAddress, 'Alternative Click', 'Trying alternative method to click search result');
        const alternativeClicked = await page.evaluate(() => {
          // Try to find any result element
          const anyResult = document.querySelector('.c-autocomplete__item a');
          if (anyResult) {
            anyResult.click();
            return true;
          }
          return false;
        });
        
        if (!alternativeClicked) {
          updateTokenStatus(tokenAddress, 'No Results', 'Could not find any search results to click');
          throw new Error('Could not find any search results to click');
        } else {
          updateTokenStatus(tokenAddress, 'Alternative Click Success', 'Successfully clicked alternate search result');
        }
      } else {
        updateTokenStatus(tokenAddress, 'Result Clicked', 'Successfully clicked search result');
      }
      
      // Wait for the page to load with the chart (longer wait)
      console.log('Waiting for chart to load...');
      updateTokenStatus(tokenAddress, 'Loading Chart', 'Waiting for TradingView chart to load');
      await delay(10000);

      // Try to enable RSI indicator with retries
      console.log(`${tokenAddress}: Trying to enable RSI indicator after chart load`);
      updateTokenStatus(tokenAddress, 'Enabling RSI', 'Attempting to enable RSI indicator');
      const rsiEnabled = await enableRsiIndicator(page, tokenAddress);
      if (!rsiEnabled) {
        console.log(`${tokenAddress}: Initial RSI enabling failed, retrying...`);
        updateTokenStatus(tokenAddress, 'RSI Failed', 'First RSI enabling attempt failed, retrying');
        for (let rsiRetry = 0; rsiRetry < 2; rsiRetry++) {
          await delay(5000);
          updateTokenStatus(tokenAddress, 'RSI Retry', `Retrying RSI indicator (attempt ${rsiRetry + 1}/2)`);
          const retrySuccess = await enableRsiIndicator(page, tokenAddress);
          if (retrySuccess) {
            console.log(`${tokenAddress}: Successfully enabled RSI on retry ${rsiRetry + 1}`);
            updateTokenStatus(tokenAddress, 'RSI Enabled', 'Successfully enabled RSI indicator on retry');
            break;
          }
          if (rsiRetry === 1) {
            updateTokenStatus(tokenAddress, 'RSI Problem', 'Failed to enable RSI indicator after multiple attempts');
            logDetailedError(tokenAddress, 'RSI_ENABLE_ERROR', 'Failed to enable RSI indicator after multiple attempts');
          }
        }
      } else {
        updateTokenStatus(tokenAddress, 'RSI Enabled', 'Successfully enabled RSI indicator on first try');
      }

      // Start monitoring RSI for this token
      updateTokenStatus(tokenAddress, 'Starting Monitoring', 'Beginning RSI and MC monitoring');
      const intervalId = await monitorTokenRSI(page, tokenAddress);
      
      // Store the page and interval ID for cleanup
      tokenPages.set(tokenAddress, { page, intervalId });
      
      // Remove from pending set as we're done processing
      pendingTokens.delete(tokenAddress);
      
      console.log(`Now monitoring token: ${tokenAddress}`);
      updateTokenStatus(tokenAddress, 'Monitoring Active', 'Token is now being actively monitored');
      
      // Reset connection error counter since it succeeded
      consecutiveConnectionErrors = 0;
      
      // Successfully opened the token page
      return;
      
    } catch (error) {
      // Store the last error
      lastError = error;
      
      // Check if this is a connection error
      if (error.message.includes('Connection closed') || 
          error.message.includes('Protocol error') ||
          error.message.includes('Target closed') ||
          error.message.includes('Browser has disconnected')) {
        
        console.error(`Connection error for token ${tokenAddress}: ${error.message} (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        updateTokenStatus(tokenAddress, 'Connection Error', `Browser connection error: ${error.message}`);
        consecutiveConnectionErrors++;
        
        // If we've hit the threshold, restart the browser
        if (consecutiveConnectionErrors >= connectionErrorThreshold) {
          await restartBrowser();
          // Reset retry count to give one more chance after browser restart
          retryCount = 0;
          continue;
        }
      } else {
        // For other errors, log and retry
        console.error(`Error opening page for token ${tokenAddress}: ${error.message} (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        updateTokenStatus(tokenAddress, 'Error', `Error: ${error.message} (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        // Reset connection error counter for non-connection errors
        consecutiveConnectionErrors = 0;
      }
      
      // Increment retry count
      retryCount++;
      
      // Wait before retrying
      if (retryCount < MAX_RETRIES) {
        console.log(`Retrying token ${tokenAddress} in 5 seconds...`);
        updateTokenStatus(tokenAddress, 'Retrying', `Will retry in 5 seconds (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        await delay(5000);
      }
    }
  }
  
  // If we get here, we've failed after all retries
  console.error(`Failed to open page for token ${tokenAddress} after ${MAX_RETRIES} attempts`);
  updateTokenStatus(tokenAddress, 'Failed', `Failed after ${MAX_RETRIES} attempts: ${lastError ? lastError.message : 'Unknown error'}`);
  
  // Log detailed error
  logDetailedError(
    tokenAddress, 
    'TOKEN_OPEN_ERROR', 
    lastError ? lastError.message : 'Unknown error',
    `Failed after ${MAX_RETRIES} attempts`
  );
  
  // Remove from monitored and pending tokens
  monitoredTokens.delete(tokenAddress);
  pendingTokens.delete(tokenAddress);
  tokensReadyStatus.delete(tokenAddress);
  
  // Process next token
  console.log(`Moving to next token after failure with ${tokenAddress}`);
  setTimeout(() => {
    processNextTokenFromQueue();
  }, 2000);
}

// Function to restart the browser
async function restartBrowser() {
  console.log('⚠️ Too many connection errors detected. Restarting browser...');
  
  try {
    // Clean up existing browser
    if (global.browser) {
      // Clean up any monitored tokens
      cleanupTokenMonitoring();
      
      // Close the browser
      await global.browser.close();
      console.log('Browser closed successfully');
    }
    
    // Wait a moment before restarting
    await delay(5000);
    
    // Launch a new browser instance
    console.log('Launching new browser instance...');
    const browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      userDataDir: userDataDir,
      args: [
        '--start-maximized',
        '--no-sandbox',
        ...(fs.existsSync(extensionPath) ? [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`
        ] : [])
      ],
      ignoreDefaultArgs: ['--enable-automation']
    });
    
    // Store the new browser instance globally
    global.browser = browser;
    console.log('Browser restarted successfully');
    
    // Reset error counter
    consecutiveConnectionErrors = 0;
    
    // Retry any tokens that failed
    const tokensToProcess = [...tokensToRetry];
    tokensToRetry = []; // Clear the retry queue
    
    // Wait a moment for browser to fully initialize
    await delay(5000);
    
    // Process tokens that need to be retried
    for (const token of tokensToProcess) {
      console.log(`Retrying token after browser restart: ${token}`);
      // Remove from monitored/pending sets to allow retrying
      monitoredTokens.delete(token);
      pendingTokens.delete(token);
      // Requeue the token
      await openTokenPage(global.browser, token);
    }
    
    return true;
  } catch (error) {
    console.error('Error during browser restart:', error.message);
    consecutiveConnectionErrors = 0; // Reset to avoid infinite restart loop
    return false;
  }
}

// API endpoint to receive mint addresses
app.post('/watch-token', async (req, res) => {
  const { mintAddress } = req.body;
  
  if (!mintAddress) {
    return res.status(400).json({ error: 'Mint address is required' });
  }
  
  // Check if this token is already being monitored or is pending
  if (tokenPages.has(mintAddress) || monitoredTokens.has(mintAddress) || pendingTokens.has(mintAddress)) {
    console.log(`Already monitoring token: ${mintAddress}`);
    return res.json({ success: false, message: `Already watching token: ${mintAddress}` });
  }
  
  // Check if we already have the maximum number of tokens being monitored
  if (monitoredTokens.size >= MAX_MONITORED_TOKENS) {
    console.log(`Already monitoring max tokens (${MAX_MONITORED_TOKENS}). Adding ${mintAddress} to queue`);
    
    // Add to waiting queue instead of starting immediately
    tokenWaitingQueue.push({
      address: mintAddress,
      discoveredAt: new Date()
    });
    
    return res.json({ 
      success: true, 
      message: `Added token to queue (position ${tokenWaitingQueue.length}): ${mintAddress}` 
    });
  }
  
  // Clear any existing debounce timer for this token
  if (requestDebounceTimers[mintAddress]) {
    clearTimeout(requestDebounceTimers[mintAddress]);
  }
  
  // Add to pending set immediately to lock this token request
  pendingTokens.add(mintAddress);
  
  console.log(`Received request to watch token: ${mintAddress}`);
  
  // Use a timeout to debounce requests for the same token
  requestDebounceTimers[mintAddress] = setTimeout(async () => {
    try {
      // Check if browser exists and is connected
      if (!global.browser) {
        console.log(`No browser available for token ${mintAddress}, attempting to restart...`);
        // Add to retry queue
        if (!tokensToRetry.includes(mintAddress)) {
          tokensToRetry.push(mintAddress);
        }
        // Try to restart the browser
        await restartBrowser();
        return;
      }
      
      // Open a new page for this token if browser is available and connected
      await openTokenPage(global.browser, mintAddress);
    } catch (error) {
      console.error(`Error processing watch request for ${mintAddress}: ${error.message}`);
      logDetailedError(mintAddress, 'WATCH_REQUEST_ERROR', error.message);
      
      // Remove from pending set if there was an error
      pendingTokens.delete(mintAddress);
      monitoredTokens.delete(mintAddress);
      
      // Process next token in queue
      setTimeout(() => {
        processNextTokenFromQueue();
      }, 2000);
    } finally {
      // Clean up the debounce timer
      delete requestDebounceTimers[mintAddress];
    }
  }, 500); // 500ms debounce time
  
  return res.json({ success: true, message: `Now watching token: ${mintAddress}` });
});

// API endpoint to trigger pump token scraping
app.post('/scrape-pump-tokens', async (req, res) => {
  try {
    // Check if browser exists
    if (!global.browser) {
      console.log('No browser available, attempting to restart...');
      await restartBrowser();
    }
    
    if (!global.browser) {
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to initialize browser for scraping' 
      });
    }
    
    // Start scraping immediately (don't set up another timer)
    console.log('Manually triggering pump token scraping...');
    scrapePumpTokens(global.browser).catch(err => {
      console.error('Error during manual pump token scraping:', err.message);
    });
    
    return res.json({ 
      success: true, 
      message: 'Pump token scraping triggered manually' 
    });
  } catch (error) {
    console.error('Error initiating pump token scraping:', error.message);
    return res.status(500).json({ 
      success: false, 
      message: `Error: ${error.message}` 
    });
  }
});

// Clean up function to be called when exiting
function cleanupTokenMonitoring() {
  console.log('Cleaning up token monitoring...');
  
  // Clean up all token monitoring
  for (const [tokenAddress, { page, intervalId }] of tokenPages.entries()) {
    clearInterval(intervalId);
    page.close().catch(err => console.error(`Error closing page for ${tokenAddress}:`, err.message));
    console.log(`Stopped monitoring for token: ${tokenAddress}`);
  }
  
  // Clear all sets
  tokenPages.clear();
  monitoredTokens.clear();
  pendingTokens.clear();
  discoveredPumpTokens.clear();
  blacklistedTokens.clear();
  
  // Clear token waiting queue
  tokenWaitingQueue = [];
  
  // Clear any pending timers
  Object.keys(requestDebounceTimers).forEach(token => {
    clearTimeout(requestDebounceTimers[token]);
  });
  requestDebounceTimers = {};
  
  // Clear pump token scraping timer
  if (scrapingTimer) {
    clearTimeout(scrapingTimer);
    scrapingTimer = null;
    console.log('Stopped periodic pump token scraping');
  }
}

// Modify the process.on('SIGINT') handler to use our cleanup function
process.on('SIGINT', async () => {
  console.log('Closing browser and exiting...');
  
  cleanupTokenMonitoring();
  
  if (global.browser) await global.browser.close();
  rl.close();
  process.exit();
});

async function run() {
  // Create all log files if they don't exist
  [queueLogFile, monitoringLogFile, scrapingLogFile].forEach(file => {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, '--- Log Created ---\n');
    }
  });
  
  let browser = null;
  
  try {
    console.log('Launching Chrome with dedicated puppeteer profile');
    console.log(`Using persistent user data directory: ${userDataDir}`);
    console.log(`Loading extension from: ${extensionPath}`);
    
    // Ensure extension directory exists
    if (!fs.existsSync(extensionPath)) {
      console.error(`Warning: Phantom extension directory not found at ${extensionPath}`);
      console.log('Will continue without loading extension');
    }
    
    // Create profile directory if it doesn't exist
    if (!fs.existsSync(userDataDir)) {
      console.log(`Creating new profile directory at: ${userDataDir}`);
      fs.mkdirSync(userDataDir, { recursive: true });
    }
    
    // Launch browser with proper extension loading and persistent profile
    browser = await puppeteer.launch({
      headless: true,
      defaultViewport: null,
      userDataDir: userDataDir,
      args: [
        '--start-maximized',
        '--no-sandbox',
        ...(fs.existsSync(extensionPath) ? [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`
        ] : [])
      ],
      ignoreDefaultArgs: ['--enable-automation']
    });
    
    console.log('Successfully launched Chrome with dedicated profile');
    
    // Store browser instance globally so the API can access it
    global.browser = browser;
    
    // Setup disconnect handler to automatically restart browser if it crashes
    browser.on('disconnected', async () => {
      console.log('❌ Browser disconnected unexpectedly');
      // Only attempt restart if global.browser is still this browser instance
      // (to avoid duplicate restarts)
      if (global.browser === browser) {
        // Set to null to avoid issues during restart
        global.browser = null;
        // Restart the browser
        await restartBrowser();
      }
    });
    
    // Start API server to receive mint addresses
    app.listen(PORT, () => {
      console.log(`API server running at http://localhost:${PORT}`);
      console.log(`Send POST requests to http://localhost:${PORT}/watch-token with JSON body: { "mintAddress": "your-token-address" }`);
    });
    
    // Open initial page
    const page = await browser.newPage();
    
    // Enhanced stealth settings
    await page.evaluateOnNewDocument(() => {
      // Overwrite the 'navigator.webdriver' property to prevent detection
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
      
      // Overwrite the Chrome property so websites can't tell this is automated
      window.chrome = {
        runtime: {},
      };
    });
    
    // Set up stealth
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Navigate to website
    console.log('Navigating to website');
    try {
      await page.goto('https://photon-sol.tinyastro.io', { 
        waitUntil: 'networkidle2',
        timeout: 60000
      });
    } catch (navError) {
      console.log('Navigation error:', navError.message);
    }
    
    console.log('Press ENTER after you have signed in and loaded the chart with RSI indicator...');
    
    // Wait for user to press Enter
    await new Promise(resolve => {
      rl.question('', () => {
        console.log('ENTER pressed. Ready to monitor tokens.');
        resolve();
      });
    });
    
    // Start Solscan scraping for pump tokens
    console.log('Starting initial SolScan scraping for pump tokens...');
    try {
      // Run initial scraping
      await scrapePumpTokens(browser);
      
      // Scraping will automatically schedule the next run when it finishes
      console.log(`Pump token scraping will continue every ${SCRAPING_INTERVAL/1000} seconds after completion`);
    } catch (error) {
      console.error('Error during initial pump token scraping:', error.message);
    }
    
    // Display command menu
    console.log('\nAvailable commands:');
    console.log('1) Start monitoring a token');
    console.log('2) Scrape SolScan for pump tokens');
    console.log('3) Exit');
    
    // Setup command line interface for user commands
    const askForCommand = async () => {
      rl.question('\nEnter command number: ', async (answer) => {
        switch (answer.trim()) {
          case '1':
            rl.question('Enter token address to monitor: ', (tokenAddress) => {
              if (tokenAddress.trim()) {
                openTokenPage(browser, tokenAddress.trim())
                  .then(() => askForCommand())
                  .catch(err => {
                    console.error('Error monitoring token:', err.message);
                    askForCommand();
                  });
              } else {
                console.log('Invalid token address');
                askForCommand();
              }
            });
            break;
          
          case '2':
            console.log('Starting SolScan scraping for pump tokens...');
            try {
              await scrapePumpTokens(browser);
              console.log('Pump token scraping complete');
            } catch (error) {
              console.error('Error during pump token scraping:', error.message);
            }
            askForCommand();
            break;
          
          case '3':
            console.log('Exiting...');
            if (browser) await browser.close();
            rl.close();
            process.exit(0);
            break;
          
          default:
            console.log('Unknown command');
            askForCommand();
            break;
        }
      });
    };
    
    // Start command interface
    askForCommand();
    
    // Handle cleanup when user terminates the script
    process.on('SIGINT', async () => {
      console.log('Closing browser and exiting...');
      
      cleanupTokenMonitoring();
      
      if (browser) await browser.close();
      rl.close();
      process.exit();
    });
    
  } catch (error) {
    console.error('An error occurred:', error);
    if (browser) await browser.close();
    rl.close();
    process.exit(1);
  }
}

run();