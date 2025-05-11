const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const logDirectory = path.join(__dirname, 'logs');
if (!fs.existsSync(logDirectory)) {
  fs.mkdirSync(logDirectory);
}

async function scrapeSolscanWallets() {
  const walletListPath = path.join(__dirname, 'walletlist.txt');
  const outputLog = path.join(logDirectory, 'solscan_wallets.log');
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
  const timestamp = new Date().toISOString();
  fs.appendFileSync(outputLog, `\n[${timestamp}] Starting Solscan scrape for ${wallets.length} wallets\n`);
  const browser = await puppeteer.launch({ headless: true });
  for (const wallet of wallets) {
    const url = `https://solscan.io/account/${wallet}?activity_type=ACTIVITY_TOKEN_ADD_LIQ&__cf_chl_rt_tk=og8p6VyibRoU9E2d6oM.Z2_DU.GOsny5.spKPXMwslk-1746414776-1.0.1.1-YfBbg2uN4aGVlepSQOIEcSCBqw49RU2MND1eKkZLoK8#defiactivities`;
    let page;
    try {
      page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      const content = await page.content();
      fs.appendFileSync(outputLog, `\n[${timestamp}] Wallet: ${wallet}\nURL: ${url}\n--- PAGE CONTENT START ---\n${content}\n--- PAGE CONTENT END ---\n`);
      console.log(`Scraped Solscan for wallet: ${wallet}`);
    } catch (err) {
      fs.appendFileSync(outputLog, `\n[${timestamp}] Wallet: ${wallet}\nURL: ${url}\nERROR: ${err.message}\n`);
      console.error(`Error scraping wallet ${wallet}:`, err.message);
    } finally {
      if (page) await page.close();
    }
  }
  await browser.close();
  fs.appendFileSync(outputLog, `\n[${timestamp}] Finished Solscan scrape\n`);
  console.log('Solscan wallet scraping complete.');
}

scrapeSolscanWallets();