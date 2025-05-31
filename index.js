const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');

puppeteer.use(StealthPlugin());

const logDirectory = path.join(__dirname, 'logs');
if (!fs.existsSync(logDirectory)) {
  fs.mkdirSync(logDirectory);
}

// Define a selector that reliably indicates the presence of the DeFi activities table content.
// This might need adjustment if Solscan's HTML structure changes.
// We are looking for rows within the tbody of a table that should contain the DeFi activities.
const DEFI_TABLE_CONTENT_SELECTOR = 'div[id*="radix-"][role="tabpanel"][data-state="active"] table tbody tr';

// Copied and adapted from clean_solscan_html_log.js
function parseAmountText(amountText) {
    const parsedAmounts = [];
    const amountRegex = /([\d,]+\.?[\d]*)(\$?([A-Za-z0-9.-]+))/g;
    let match;
    let lastIndex = 0;

    while ((match = amountRegex.exec(amountText)) !== null) {
        parsedAmounts.push({ amount: match[1].replace(/,/g, ''), token: match[2] });
        lastIndex = amountRegex.lastIndex;
    }

    if (parsedAmounts.length === 0 && amountText) {
        let remainingText = amountText;
        const commonTokens = ['WSOL', 'USDC', 'USDT']; 
        for (const token of commonTokens) {
            const parts = remainingText.split(new RegExp(`(${token})`, 'i')); 
            if (parts.length > 1) {
                for (let i = 0; i < parts.length -1; i+=2) {
                    const numPart = parts[i].replace(/[^\d.,]/g, '').trim();
                    const tokenPart = parts[i+1].trim();
                    if (numPart && tokenPart) {
                        parsedAmounts.push({ amount: numPart.replace(/,/g, ''), token: tokenPart });
                    }
                }
                break; 
            }
        }
    }

    if (parsedAmounts.length === 0 && amountText) { 
        parsedAmounts.push({ raw: amountText, note: 'Could not parse amount string.' });
    }
    return parsedAmounts;
}

// New function to parse HTML content directly
function parseLiveHtmlContent(htmlContent, walletAddress, scrapeTimestamp) {
    const result = {
        walletAddress: walletAddress,
        scrapeTimestamp: scrapeTimestamp,
        status: 'Unknown',
        transactions: [],
        error: null
    };

    if (!htmlContent) {
        result.status = 'No HTML content provided for parsing.';
        return result;
    }

    try {
        const $ = cheerio.load(htmlContent);
        const transactions = [];

        $('div[id*="radix-"][role="tabpanel"][data-state="active"] table tbody tr').each((i, row) => {
            const columns = $(row).find('td');
            if (columns.length > 8) { 
                const signatureLink = $(columns[1]).find('a');
                const signature = signatureLink.text().trim();
                const time = $(columns[2]).text().trim();
                const action = $(columns[3]).find('div').text().trim(); 
                const from = $(columns[4]).find('span > span').first().text().trim(); 
                const amountCell = $(columns[5]); 
                const value = $(columns[6]).text().trim(); 
                const platformCell = $(columns[7]); 
                const sourceCell = $(columns[8]);   

                const amountText = amountCell.text().replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
                const parsedAmounts = parseAmountText(amountText);

                const platformImg = platformCell.find('img');
                const sourceImg = sourceCell.find('img');

                if (signature) {
                    transactions.push({
                        signature,
                        time,
                        action,
                        from,
                        amountRaw: amountText, 
                        parsedAmounts: parsedAmounts,
                        value,
                        platform: platformImg.attr('alt') || platformImg.attr('src') || platformCell.text().trim(), 
                        source: sourceImg.attr('alt') || sourceImg.attr('src') || sourceCell.text().trim(),
                    });
                }
            }
        });

        if (transactions.length > 0) {
            result.status = 'Success';
            result.transactions = transactions;
        } else {
            // Check if the page explicitly says no DeFi activities, even if the table selector was present but empty
            if (htmlContent.includes("No DeFi Activities Found") || htmlContent.includes("This account has no DeFi activity")) {
                 result.status = 'No DeFi activities found (explicit message on page).';
            } else {
                 result.status = 'HTML parsed, but no transaction rows found (selectors might need adjustment or page had no data in table).';
            }
        }
    } catch (parseError) {
        console.error(`Error parsing HTML for wallet ${walletAddress}: ${parseError.message}`);
        result.status = 'Error during HTML parsing.';
        result.error = parseError.message;
    }
    return result;
}

async function scrapeSolscanWallets() {
  const walletListPath = path.join(__dirname, 'walletlist.txt');
  // Output for general operational logs (optional, can be simplified or removed)
  const operationLogPath = path.join(logDirectory, 'scraping_operations.log');
  // Final cleaned data output path
  const cleanedOutputPath = path.join(__dirname, 'cleaned_solscan_transactions.json');

  if (!fs.existsSync(walletListPath)) {
    console.error('walletlist.txt not found.');
    return;
  }
  const wallets = fs.readFileSync(walletListPath, 'utf-8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (wallets.length === 0) {
    console.log('No wallet addresses found in walletlist.txt');
    return;
  }

  const sessionTimestamp = new Date().toISOString();
  // Simplified operational logging
  fs.writeFileSync(operationLogPath, `--- SESSION START: ${sessionTimestamp} ---\nScraping ${wallets.length} wallets...\n`);
  console.log(`Starting Solscan scrape for ${wallets.length} wallets. Cleaned data will be saved to: ${cleanedOutputPath}`);

  const allWalletsData = []; // Accumulator for cleaned data
  const browser = await puppeteer.launch({ headless: true }); // Consider `headless: "new"` for newer Puppeteer versions

  for (const wallet of wallets) {
    const walletScrapeTimestamp = new Date().toISOString();
    const baseUrl = 'https://solscan.io/account/';
    const url = `${baseUrl}${wallet}#defiactivities`;
    let walletResult = { // Initialize a result object for this wallet
        walletAddress: wallet,
        scrapeTimestamp: walletScrapeTimestamp,
        status: 'Pending',
        transactions: [],
        error: null
    };

    fs.appendFileSync(operationLogPath, `\n[WALLET_PROCESSING] Timestamp: ${walletScrapeTimestamp}, Address: ${wallet}, URL: ${url}\n`);
    console.log(`\nProcessing wallet: ${wallet}`);
    console.log(`URL: ${url}`);

    let page;
    try {
      page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      console.log('Navigating to page...');
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 });
      console.log('Page navigation complete. Checking for DeFi activities tab content...');

      try {
        await page.waitForSelector(DEFI_TABLE_CONTENT_SELECTOR, { timeout: 20000 }); 
        console.log('DeFi activities table content detected.');
        const htmlContent = await page.content();
        // Parse the HTML content immediately
        const parsedData = parseLiveHtmlContent(htmlContent, wallet, walletScrapeTimestamp);
        walletResult = { ...walletResult, ...parsedData }; // Merge parsing results
        
        if (parsedData.status === 'Success') {
            console.log(`Successfully parsed ${parsedData.transactions.length} transactions for wallet: ${wallet}`);
            fs.appendFileSync(operationLogPath, `[SUCCESS] Wallet: ${wallet}, Transactions: ${parsedData.transactions.length}\n`);
        } else {
            console.log(`Parsing status for ${wallet}: ${parsedData.status}. ${parsedData.error || ''}`);
            fs.appendFileSync(operationLogPath, `[PARSE_INFO] Wallet: ${wallet}, Status: ${parsedData.status}, Error: ${parsedData.error || 'N/A'}\n`);
        }

      } catch (tableTimeoutError) {
        console.log('DeFi activities table content selector not found after timeout.');
        // Fallback: get current content to check for explicit "no data" messages
        const currentContent = await page.content();
        if (currentContent.includes("No DeFi Activities Found") || currentContent.includes("This account has no DeFi activity")) {
            walletResult.status = 'No DeFi activities found (explicit message on page).';
            console.log('[NO_DATA] No DeFi activities found on page for wallet: ' + wallet);
            fs.appendFileSync(operationLogPath, `[NO_DATA] Wallet: ${wallet}, Message: No DeFi activities found on page.\n`);
        } else {
            walletResult.status = 'DeFi table selector not found and no explicit "no data" message; page structure might be unexpected.';
            console.log('[UNEXPECTED_STRUCTURE] DeFi table selector not found for wallet: ' + wallet + '. Page structure might be different.');
            fs.appendFileSync(operationLogPath, `[UNEXPECTED_STRUCTURE] Wallet: ${wallet}, Info: DeFi table selector not found.\n`);
            // Optionally log this fallback HTML to a separate debug file if needed, but not to the main cleaned output
        }
      }
    } catch (err) {
      walletResult.status = 'Error during scraping process.';
      walletResult.error = err.message;
      fs.appendFileSync(operationLogPath, `[SCRAPE_ERROR] Wallet: ${wallet}, Error: ${err.message}\n`);
      console.error(`Error processing wallet ${wallet}: ${err.message}`);
    } finally {
      allWalletsData.push(walletResult); // Add the result for this wallet to the main list
      if (page) await page.close();
      fs.appendFileSync(operationLogPath, `[WALLET_END_PROCESSING] Wallet: ${wallet}\n---\n`);
    }
  }

  await browser.close();
  
  // Write the consolidated cleaned data to JSON file
  fs.writeFileSync(cleanedOutputPath, JSON.stringify(allWalletsData, null, 2));
  console.log(`\nCleaned data for all processed wallets written to: ${cleanedOutputPath}`);

  fs.appendFileSync(operationLogPath, `\n--- SESSION END: ${new Date().toISOString()} ---\nProcessed ${allWalletsData.length} wallets.\n`);
  console.log('\nSolscan wallet scraping and parsing session complete.');
  
  // Summary of processing
  if (allWalletsData.length > 0) {
    console.log("\nSummary of processing results:");
    allWalletsData.forEach(data => {
        console.log(`- Wallet: ${data.walletAddress}, Status: ${data.status}, Transactions Found: ${data.transactions.length}, Error: ${data.error || 'N/A'}`);
    });
  }
}

// Helper function to parse proxy string: ip:port:username:password
function parseProxyString(proxyString) {
    const parts = proxyString.split(':');
    if (parts.length === 4) {
        return {
            host: parts[0],
            port: parts[1],
            username: parts[2],
            password: parts[3]
        };
    } else if (parts.length === 2) { // For proxies without auth: ip:port
        return {
            host: parts[0],
            port: parts[1],
            username: null,
            password: null
        };
    }
    // console.warn(`Invalid proxy string format: ${proxyString}. Expected ip:port or ip:port:username:password`); // Less noisy
    return null;
}

async function testProxies() {
    const proxyListPath = path.join(__dirname, 'Webshare 100 proxies (1).txt');
    const resultsCsvPath = path.join(__dirname, 'proxy_test_results.csv');
    const targetUrl = 'https://solscan.io/account/RAYpQbFNq9i3mu6cKpTKKRwwHFDeK5AuZz8xvxUrCgw?value=1&value=undefined#defiactivities';

    if (!fs.existsSync(proxyListPath)) {
        console.error(`Proxy list file not found: ${proxyListPath}`);
        return;
    }

    const proxyStrings = fs.readFileSync(proxyListPath, 'utf-8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    if (proxyStrings.length === 0) {
        console.log('No proxies found in the list.');
        return;
    }

    console.log(`Starting proxy test for ${proxyStrings.length} proxies. Results will be saved to: ${resultsCsvPath}`);
    
    const csvHeaders = 'Proxy,Status,Error\n';
    fs.writeFileSync(resultsCsvPath, csvHeaders); // Initialize CSV with headers

    for (const proxyString of proxyStrings) {
        const proxy = parseProxyString(proxyString);
        if (!proxy) {
            fs.appendFileSync(resultsCsvPath, `${proxyString.replace(/,/g, ';')},Invalid Format,\n`);
            continue;
        }

        console.log(`\nTesting proxy: ${proxy.host}:${proxy.port}`);
        let browser;
        let status = 'Pending';
        let errorMessage = '';

        try {
            const launchOptions = {
                headless: true, // Consider "new" for newer Puppeteer
                args: [`--proxy-server=http://${proxy.host}:${proxy.port}`]
            };
            browser = await puppeteer.launch(launchOptions);
            const page = await browser.newPage();

            if (proxy.username && proxy.password) {
                await page.authenticate({
                    username: proxy.username,
                    password: proxy.password
                });
            }
            
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            console.log(`Navigating to ${targetUrl} with proxy ${proxy.host}:${proxy.port}`);
            await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 45000 }); // Adjusted timeout for testing

            console.log('Checking for DeFi table content...');
            await page.waitForSelector(DEFI_TABLE_CONTENT_SELECTOR, { timeout: 15000 }); // Shorter timeout for content check
            status = 'Success';
            console.log(`Proxy ${proxy.host}:${proxy.port}: Success`);

        } catch (err) {
            status = 'Failed';
            errorMessage = err.message.split('\n')[0].replace(/,/g, ';'); // Get a concise error, replace commas for CSV
            console.error(`Proxy ${proxy.host}:${proxy.port}: Failed - ${errorMessage}`);
        } finally {
            if (browser) {
                await browser.close();
            }
            const sanitizedProxyString = proxyString.replace(/,/g, ';');
            fs.appendFileSync(resultsCsvPath, `${sanitizedProxyString},${status},${errorMessage}\n`);
        }
    }
    console.log(`\nProxy testing complete. Results saved to: ${resultsCsvPath}`);
}

function isProxyOrConnectionError(error) {
    const message = error.message.toLowerCase();
    const keywords = [
        'proxy', 'timeout', 'net::', 'econnrefused', 'enotfound', 
        'esockettimedout', 'navigation failed', 'dns_probe_finished_nxdomain', 'protocol error'
    ];
    return keywords.some(kw => message.includes(kw));
}

class ProxyManager {
    constructor(proxyStringsInput) {
        this.proxies = proxyStringsInput
            .map((proxyString, index) => {
                const parsed = parseProxyString(proxyString);
                if (!parsed) {
                    console.warn(`Invalid proxy string format during ProxyManager init: ${proxyString}. Skipping.`);
                }
                return { id: index, proxyString, parsedProxy: parsed, requestTimestamps: [] };
            })
            .filter(p => p.parsedProxy);
    }

    getAvailableProxy() {
        const now = Date.now();
        for (const proxy of this.proxies) {
            proxy.requestTimestamps = proxy.requestTimestamps.filter(ts => now - ts < 60000);
            if (proxy.requestTimestamps.length < 10) {
                return proxy;
            }
        }
        return null;
    }

    recordRequest(proxyId) {
        const proxy = this.proxies.find(p => p.id === proxyId);
        if (proxy) {
            proxy.requestTimestamps.push(Date.now());
        }
    }
}

function formatETR(ms) {
    if (ms === Infinity || isNaN(ms) || ms < 0) {
        return 'Calculating...';
    }
    let seconds = Math.floor(ms / 1000);
    let minutes = Math.floor(seconds / 60);
    let hours = Math.floor(minutes / 60);
    seconds %= 60;
    minutes %= 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// --- Constants ---
const MAX_WALLET_RETRIES = 2; // Max 2 retries (total 3 attempts) per wallet

async function scrapeWalletLiquidityActivites() {
    const walletListPath = path.join(__dirname, 'wallets_full.txt');
    const proxyListPath = path.join(__dirname, 'successful_proxies.txt');
    const csvOutputPath = path.join(__dirname, 'liquidity_add_activity.csv');
    const operationLogPath = path.join(logDirectory, 'scraping_operations_concurrent.log');

    if (!fs.existsSync(logDirectory)) fs.mkdirSync(logDirectory);

    if (!fs.existsSync(walletListPath)) {
        console.error(`Wallet list file not found: ${walletListPath}`);
        fs.appendFileSync(operationLogPath, `[ERROR] Wallet list file not found: ${walletListPath}\n`);
        return;
    }
    if (!fs.existsSync(proxyListPath)) {
        console.error(`Proxy list file not found: ${proxyListPath}`);
        fs.appendFileSync(operationLogPath, `[ERROR] Proxy list file not found: ${proxyListPath}\n`);
        return;
    }

    const allWalletAddressesFromFile = fs.readFileSync(walletListPath, 'utf-8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const proxyStrings = fs.readFileSync(proxyListPath, 'utf-8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);

    if (allWalletAddressesFromFile.length === 0) {
        console.log('No wallet addresses found in walletlist.txt');
        fs.appendFileSync(operationLogPath, '[INFO] No wallet addresses found in main list\n');
        return;
    }
    
    const proxyManager = new ProxyManager(proxyStrings);
    if (proxyManager.proxies.length === 0) {
        console.log('No valid proxies found or parsed from successful_proxies.txt');
        fs.appendFileSync(operationLogPath, '[INFO] No valid proxies found\n');
        return;
    }

    let processedWalletsFromCSV = new Set();
    if (fs.existsSync(csvOutputPath)) {
        const csvContent = fs.readFileSync(csvOutputPath, 'utf-8');
        const lines = csvContent.split(/\r?\n/);
        if (lines.length > 1) { // Has more than just a potential header
            lines.slice(1).forEach(line => { // Skip header
                const parts = line.split(',');
                if (parts.length > 0 && parts[0]) {
                    processedWalletsFromCSV.add(parts[0].replace(/"/g, '').trim());
                }
            });
            console.log(`Loaded ${processedWalletsFromCSV.size} wallets from existing CSV to resume.`);
            fs.appendFileSync(operationLogPath, `[INFO] Resuming: ${processedWalletsFromCSV.size} wallets already in CSV.\n`);
        }
    }

    const walletsToProcessQueue = allWalletAddressesFromFile
        .filter(wallet => !processedWalletsFromCSV.has(wallet))
        .map(walletAddress => ({ walletAddress, retryCount: 0 })); // Initialize with retryCount

    if (walletsToProcessQueue.length === 0) {
        console.log('All wallets from list are already processed according to the CSV file.');
        fs.appendFileSync(operationLogPath, '[INFO] All wallets already processed. Nothing to do.\n');
        return;
    }

    if (!fs.existsSync(csvOutputPath) || fs.readFileSync(csvOutputPath, 'utf-8').trim() === '') {
        fs.writeFileSync(csvOutputPath, 'WalletAddress,MintAddressCount,Status,ErrorDetails,Attempts\n'); // Added Attempts column
    }
    
    const sessionTimestamp = new Date().toISOString();
    fs.appendFileSync(operationLogPath, `--- CONCURRENT LIQUIDITY SCRAPE SESSION START: ${sessionTimestamp} ---\n`);
    fs.appendFileSync(operationLogPath, `Total wallets in file: ${allWalletAddressesFromFile.length}, Already processed: ${processedWalletsFromCSV.size}, Queued for this session: ${walletsToProcessQueue.length}\n`);
    console.log(`Starting concurrent liquidity scrape. Total in file: ${allWalletAddressesFromFile.length}. Already processed: ${processedWalletsFromCSV.size}. Queued for this session: ${walletsToProcessQueue.length}. Proxies: ${proxyManager.proxies.length}. Max retries per wallet: ${MAX_WALLET_RETRIES}`);

    let activeBrowserInstances = 0;
    const DESIRED_MAX_CONCURRENT_BROWSERS = 10;
    const MAX_CONCURRENT_BROWSERS = Math.min(DESIRED_MAX_CONCURRENT_BROWSERS, proxyManager.proxies.length > 0 ? proxyManager.proxies.length : 1);
    
    let tasksFinalizedThisSession = 0; 
    const initialWalletsForThisSession = walletsToProcessQueue.length;
    const startTimeThisSession = Date.now();
    let etrInterval;

    async function runScrapeTask(walletAddress, proxyData, attemptNumber) {
        const { parsedProxy, proxyString } = proxyData;
        let browser;
        let page;
        const proxyHost = parsedProxy.host || proxyString.split(':')[0];
        // fs.appendFileSync(operationLogPath, `[ATTEMPT ${attemptNumber}] Wallet: ${walletAddress}, Proxy: ${proxyHost}\n`); // Verbose

        try {
            const launchOptions = { 
                headless: true,
                args: [
                    `--proxy-server=http://${parsedProxy.host}:${parsedProxy.port}`,
                    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu',
                    '--enable-features=NetworkService,NetworkServiceInProcess' // May help with some net:: errors
                ]
            };
            browser = await puppeteer.launch(launchOptions);
            page = await browser.newPage();
            if (parsedProxy.username && parsedProxy.password) {
                await page.authenticate({ username: parsedProxy.username, password: parsedProxy.password });
            }
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            const targetUrl = `https://solscan.io/account/${walletAddress}?activity_type=ACTIVITY_TOKEN_ADD_LIQ#defiactivities`;
            await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 75000 }); // Increased navigation timeout slightly
            await page.waitForSelector('table.w-full.border-separate', { timeout: 60000 }); // Increased table wait slightly
            
            const extractedAddresses = await page.evaluate(() => {
                const mintAddresses = new Set();
                const ignoredAddress = "So11111111111111111111111111111111111111112";
                const table = document.querySelector('table.w-full.border-separate'); 
                if (!table) return [];
                const rows = table.querySelectorAll('tbody tr');
                rows.forEach(row => {
                    const links = row.querySelectorAll('a[href^="/token/"]');
                    links.forEach(link => {
                    const href = link.getAttribute('href');
                    if (href) {
                        const parts = href.split('/token/');
                        if (parts.length > 1 && parts[1]) {
                        const potentialMint = parts[1].split('?')[0].trim(); 
                        if (potentialMint !== ignoredAddress && potentialMint.length >= 32 && potentialMint.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(potentialMint)) {
                            mintAddresses.add(potentialMint);
                        }
                        }
                    }
                    });
                });
                return Array.from(mintAddresses);
            });
            
            if (browser) await browser.close();
            return { 
                status: extractedAddresses.length > 0 ? 'Success' : 'Success (No Mints)', 
                mintAddressCount: extractedAddresses.length, 
                walletAddress, 
                errorDetails: '',
                proxyHostUsed: proxyHost
            };
        } catch (err) {
            if (browser) {
                try { await browser.close(); } catch (e) { /* ignore */ }
            }
            let errorDetails = err.message.split('\n')[0].replace(/["|,]/g, ';').substring(0, 200);
            
            if (isProxyOrConnectionError(err)) {
                return { status: 'RetriableError', walletAddress, errorDetails, proxyHostUsed: proxyHost };
            } else if (err.message.includes('Target closed') || err.message.includes('Session closed') || err.message.includes('Browser.close')) {
                 return { status: 'FatalError', walletAddress, errorDetails: `BrowserCrashOrEarlyClose: ${errorDetails}`, proxyHostUsed: proxyHost };
            } else {
                // Consider any other error during scraping as potentially fatal for this attempt, but might be retriable by context
                // For now, let's make unexpected errors also retriable once to see if it's a fluke.
                // If it persists, it becomes fatal due to MAX_WALLET_RETRIES.
                // However, for very generic errors, it might be better to class them Fatal to avoid pointless retries.
                // Let's stick to specific retriable for now.
                return { status: 'FatalError', walletAddress, errorDetails: `UnknownScrapeError: ${errorDetails}`, proxyHostUsed: proxyHost };
            }
        }
    }

    function tryStartNextTask() {
        while (activeBrowserInstances < MAX_CONCURRENT_BROWSERS && walletsToProcessQueue.length > 0) {
            const proxyData = proxyManager.getAvailableProxy();
            if (proxyData) {
                activeBrowserInstances++;
                const walletTask = walletsToProcessQueue.shift(); 
                const currentAttemptNumber = walletTask.retryCount + 1;

                proxyManager.recordRequest(proxyData.id); 

                const proxyHostDisplay = proxyData.parsedProxy.host || proxyData.proxyString.split(':')[0];
                console.log(`Dispatching wallet ${walletTask.walletAddress} (Attempt ${currentAttemptNumber}/${MAX_WALLET_RETRIES + 1}, Q:${walletsToProcessQueue.length}) with proxy ${proxyHostDisplay}. Active: ${activeBrowserInstances}`);
                
                runScrapeTask(walletTask.walletAddress, proxyData, currentAttemptNumber)
                    .then(result => {
                        let csvLine;
                        let isFinalized = false;

                        if (result.status === 'RetriableError') {
                            console.warn(`Wallet ${result.walletAddress} (Attempt ${currentAttemptNumber}) failed (retriable): ${result.errorDetails} via ${result.proxyHostUsed}.`);
                            fs.appendFileSync(operationLogPath, `[RETRY_ATTEMPT_FAILED] Wallet: ${result.walletAddress}, Attempt: ${currentAttemptNumber}, Proxy: ${result.proxyHostUsed}, Error: ${result.errorDetails}\n`);
                            if (walletTask.retryCount < MAX_WALLET_RETRIES) {
                                walletsToProcessQueue.push({ walletAddress: result.walletAddress, retryCount: walletTask.retryCount + 1 });
                                console.log(`Re-queued ${result.walletAddress} for attempt ${currentAttemptNumber + 1}. Retries left: ${MAX_WALLET_RETRIES - (walletTask.retryCount + 1)}.`);
                                fs.appendFileSync(operationLogPath, `[RE-QUEUED] Wallet: ${result.walletAddress} for attempt ${currentAttemptNumber + 1}.\n`);
                            } else {
                                console.error(`Wallet ${result.walletAddress} failed permanently after ${currentAttemptNumber} attempts. Last error: ${result.errorDetails} (proxy ${result.proxyHostUsed})`);
                                fs.appendFileSync(operationLogPath, `[MAX_RETRIES_REACHED] Wallet: ${result.walletAddress}, LastError: ${result.errorDetails}\n`);
                                csvLine = `"${result.walletAddress}",0,"MaxRetriesFailed","${result.errorDetails}",${currentAttemptNumber}\n`;
                                fs.appendFileSync(csvOutputPath, csvLine);
                                isFinalized = true;
                            }
                        } else { // Success, Success (No Mints), or FatalError
                            if (result.status.includes('Success')) {
                                // console.log(`Wallet ${result.walletAddress} (Attempt ${currentAttemptNumber}): ${result.status}, Mints: ${result.mintAddressCount}, Proxy: ${result.proxyHostUsed}`); // Already logged by dispatch
                                fs.appendFileSync(operationLogPath, `[SUCCESS_FINAL] Wallet: ${result.walletAddress}, Attempt: ${currentAttemptNumber}, Proxy: ${result.proxyHostUsed}, Mints: ${result.mintAddressCount || 0}\n`);
                            } else { // FatalError
                                console.error(`Wallet ${result.walletAddress} (Attempt ${currentAttemptNumber}) failed (FATAL): ${result.errorDetails} via ${result.proxyHostUsed}`);
                                fs.appendFileSync(operationLogPath, `[FATAL_FINAL] Wallet: ${result.walletAddress}, Attempt: ${currentAttemptNumber}, Proxy: ${result.proxyHostUsed}, Error: ${result.errorDetails}\n`);
                            }
                            csvLine = `"${result.walletAddress}",${result.mintAddressCount || 0},"${result.status}","${result.errorDetails}",${currentAttemptNumber}\n`;
                            fs.appendFileSync(csvOutputPath, csvLine);
                            isFinalized = true;
                        }
                        if (isFinalized) {
                            tasksFinalizedThisSession++;
                        }
                    })
                    .catch(unhandledErrorInRunScrapeTask => { 
                        console.error(`[ULTRA_FATAL_ERROR_UNHANDLED] Wallet: ${walletTask.walletAddress}, Attempt: ${currentAttemptNumber}, Error: ${unhandledErrorInRunScrapeTask.message}\n`);
                        fs.appendFileSync(operationLogPath, `[ULTRA_FATAL_ERROR_UNHANDLED] Wallet: ${walletTask.walletAddress}, Attempt: ${currentAttemptNumber}, Error: ${unhandledErrorInRunScrapeTask.message}\n`);
                        const csvLine = `"${walletTask.walletAddress}",0,"UnhandledFatal","${unhandledErrorInRunScrapeTask.message.replace(/["|,]/g, ';').substring(0,200)}",${currentAttemptNumber}\n`;
                        fs.appendFileSync(csvOutputPath, csvLine);
                        tasksFinalizedThisSession++; 
                    })
                    .finally(() => {
                        activeBrowserInstances--;
                        tryStartNextTask(); 
                    });
            } else {
                // fs.appendFileSync(operationLogPath, `[PROXY_WAIT_LOOP] No proxy available. Active: ${activeBrowserInstances}. Q: ${walletsToProcessQueue.length}. Retrying dispatch loop soon.\n`);
                setTimeout(tryStartNextTask, 3000 + Math.random() * 2000); // Wait a bit longer if no proxy
                break; 
            }
        }
    }
    
    etrInterval = setInterval(() => {
        const elapsedTime = Date.now() - startTimeThisSession;
        let etrMs = Infinity;
        if (tasksFinalizedThisSession > 0) {
            const avgTimePerFinalizedTask = elapsedTime / tasksFinalizedThisSession;
            const trulyRemainingInitialTasks = initialWalletsForThisSession - tasksFinalizedThisSession;
            etrMs = trulyRemainingInitialTasks * avgTimePerFinalizedTask;
        }
        const overallCompleted = processedWalletsFromCSV.size + tasksFinalizedThisSession;
        // The number of items in walletsToProcessQueue can fluctuate due to retries.
        // initialWalletsForThisSession refers to the unique wallets athis session started with.
        console.log(`PROGRESS: ${tasksFinalizedThisSession}/${initialWalletsForThisSession} (session tasks finalized). Overall: ${overallCompleted}/${allWalletAddressesFromFile.length}. ETR: ${formatETR(etrMs)}. Active: ${activeBrowserInstances}. Q(dynamic): ${walletsToProcessQueue.length}`);
    }, 15000);

    tryStartNextTask();

    return new Promise(resolve => {
        const checkCompletion = () => {
            if (walletsToProcessQueue.length === 0 && activeBrowserInstances === 0) {
                clearInterval(etrInterval);
                const finalOverallCompleted = processedWalletsFromCSV.size + tasksFinalizedThisSession;
                console.log(`FINAL PROGRESS: ${tasksFinalizedThisSession}/${initialWalletsForThisSession} (session tasks finalized). Overall: ${finalOverallCompleted}/${allWalletAddressesFromFile.length}. ETR: Done. Active: ${activeBrowserInstances}.`);
                const totalDurationMs = Date.now() - startTimeThisSession;
                fs.appendFileSync(operationLogPath, `--- CONCURRENT LIQUIDITY SCRAPE SESSION END: ${new Date().toISOString()} ---\nFinalized ${tasksFinalizedThisSession} wallets in this session. Total duration: ${formatETR(totalDurationMs)}\n`);
                console.log(`\nConcurrent liquidity activity scraping session complete. Finalized ${tasksFinalizedThisSession} wallets in this session.`);
                console.log(`Total duration for this session: ${formatETR(totalDurationMs)}`);
                resolve();
            } else {
                setTimeout(checkCompletion, 3000);
            }
        };
        checkCompletion();
    });
}

(async () => {
    try {
        await scrapeWalletLiquidityActivites();
        console.log("Script finished successfully.");
    } catch (error) {
        console.error("Unhandled error in main execution:", error);
        const operationLogPath = path.join(logDirectory, 'scraping_operations_concurrent.log');
        fs.appendFileSync(operationLogPath, `[GLOBAL_FATAL_ERROR] ${new Date().toISOString()}: ${error.message}\n${error.stack}\n`);
    }
})();