const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const logDirectory = path.join(__dirname, 'logs');
if (!fs.existsSync(logDirectory)) {
  fs.mkdirSync(logDirectory);
}

// Define a selector that reliably indicates the presence of the DeFi activities table content.
// This might need adjustment if Solscan's HTML structure changes.
// We are looking for rows within the tbody of a table that should contain the DeFi activities.
const DEFI_TABLE_CONTENT_SELECTOR = 'div[id*="radix-"][role="tabpanel"][data-state="active"] table tbody tr';

async function scrapeSolscanWallets() {
  const walletListPath = path.join(__dirname, 'walletlist.txt');
  const outputLogPath = path.join(logDirectory, 'solscan_wallets.log'); // Renamed for clarity

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
  // Clear the log file for this new session or use append with clear session markers
  // For now, let's append with a clear session start.
  // If you prefer to clear the log each time, use fs.writeFileSync here.
  fs.appendFileSync(outputLogPath, `\n--- SESSION START: ${sessionTimestamp} ---\nScraping ${wallets.length} wallets...\n`);
  console.log(`Starting Solscan scrape for ${wallets.length} wallets. Log: ${outputLogPath}`);

  const browser = await puppeteer.launch({ headless: true });

  for (const wallet of wallets) {
    const walletLogTimestamp = new Date().toISOString();
    const baseUrl = 'https://solscan.io/account/';
    // Construct URL without the __cf_chl_rt_tk parameter as it's likely dynamic and might cause issues.
    // The site should still load the correct tab with #defiactivities.
    const url = `${baseUrl}${wallet}#defiactivities`;

    fs.appendFileSync(outputLogPath, `\n[WALLET_START] Timestamp: ${walletLogTimestamp}, Address: ${wallet}\nURL: ${url}\n`);
    console.log(`\nProcessing wallet: ${wallet}`);
    console.log(`URL: ${url}`);

    let page;
    try {
      page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      console.log('Navigating to page...');
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 90000 }); // networkidle0 might be more robust
      console.log('Page navigation complete. Waiting for DeFi activities tab content...');

      // Wait for the specific tab panel to be active and for table content to potentially load
      // The selector targets the active defi activities tab and waits for rows to appear in the table.
      // This is a more targeted wait than just page.content() immediately.
      try {
        await page.waitForSelector(DEFI_TABLE_CONTENT_SELECTOR, { timeout: 20000 }); // Wait up to 20s for table rows
        console.log('DeFi activities table content detected.');
        const content = await page.content();
        fs.appendFileSync(outputLogPath, '--- PAGE CONTENT START ---\n' + content + '\n--- PAGE CONTENT END ---\n');
        console.log(`Scraped and logged HTML for wallet: ${wallet}`);
      } catch (tableTimeoutError) {
        // This catch block executes if DEFI_TABLE_CONTENT_SELECTOR is not found within the timeout
        console.log('DeFi activities table content not detected after timeout.');
        // As a fallback, we can still grab the page content to see what's there (e.g. error message, different layout)
        const currentContent = await page.content();
        if (currentContent.includes("No DeFi Activities Found") || currentContent.includes("This account has no DeFi activity")) { // Example checks
            fs.appendFileSync(outputLogPath, '[NO_DATA] No DeFi activities found for this wallet (explicit message on page).\n');
            console.log('[NO_DATA] No DeFi activities found on page for wallet: ' + wallet);
        } else {
            fs.appendFileSync(outputLogPath, '[NO_DATA_OR_UNEXPECTED_PAGE_STRUCTURE] DeFi table selector not found. Logging current page state.\n--- PAGE CONTENT START ---\n' + currentContent + '\n--- PAGE CONTENT END ---\n');
            console.log('[NO_DATA_OR_UNEXPECTED_PAGE_STRUCTURE] DeFi table selector not found for wallet: ' + wallet + '. Current page content logged.');
        }
      }
    } catch (err) {
      fs.appendFileSync(outputLogPath, `[ERROR] ${err.message}\n`);
      console.error(`Error processing wallet ${wallet}: ${err.message}`);
    } finally {
      if (page) await page.close();
      fs.appendFileSync(outputLogPath, '[WALLET_END]\n---\n');
    }
  }

  await browser.close();
  fs.appendFileSync(outputLogPath, `\n--- SESSION END: ${new Date().toISOString()} ---\n`);
  console.log('\nSolscan wallet scraping session complete.');
}

scrapeSolscanWallets();