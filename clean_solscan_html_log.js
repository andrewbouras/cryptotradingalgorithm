const fs = require('fs');
const cheerio = require('cheerio');
const path = require('path');

function parseAmountText(amountText) {
    const parsedAmounts = [];
    // Regex to find "NumberTokenSymbol" - improved to better handle various token names
    // Captures: 1. Number (with decimals/commas), 2. Optional '$', 3. Token Symbol (alphanumeric, '.', '-')
    const amountRegex = /([\d,]+\.?[\d]*)(\$?([A-Za-z0-9.-]+))/g;
    let match;
    let lastIndex = 0;

    // Try to find all explicit [Number][TokenName] patterns first
    while ((match = amountRegex.exec(amountText)) !== null) {
        parsedAmounts.push({ amount: match[1].replace(/,/g, ''), token: match[2] });
        lastIndex = amountRegex.lastIndex;
    }

    // If the regex didn't consume the whole string, there might be other formats or remaining parts
    if (lastIndex < amountText.length && parsedAmounts.length > 0) {
        // This case is tricky, e.g. "100TOKENabc" where TOKEN is matched but abc is left.
        // For now, we assume the regex handles distinct pairs correctly.
        // More complex splitting might be needed if tokens are not clearly separated from amounts.
    }
    
    // Fallback or if initial regex is not sufficient
    if (parsedAmounts.length === 0 && amountText) {
        // Simple split by common known tokens if they are clearly separated by non-alphanumeric or space
        // This is a very heuristic approach
        let remainingText = amountText;
        const commonTokens = ['WSOL', 'USDC', 'USDT']; // Add more common tokens if needed
        for (const token of commonTokens) {
            const parts = remainingText.split(new RegExp(`(${token})`, 'i')); // split by token, keeping delimiter
            if (parts.length > 1) {
                for (let i = 0; i < parts.length -1; i+=2) {
                    const numPart = parts[i].replace(/[^\d.,]/g, '').trim();
                    const tokenPart = parts[i+1].trim();
                    if (numPart && tokenPart) {
                        parsedAmounts.push({ amount: numPart.replace(/,/g, ''), token: tokenPart });
                    }
                }
                // This heuristic is basic, if it parsed something, we assume it might be it.
                break; 
            }
        }
    }

    if (parsedAmounts.length === 0 && amountText) { // If still nothing, store raw
        parsedAmounts.push({ raw: amountText, note: 'Could not parse amount string.' });
    }
    return parsedAmounts;
}

function parseWalletLogSection(logSection) {
    const result = {
        walletAddress: null,
        scrapeTimestamp: null,
        status: 'Unknown',
        transactions: [],
        error: null
    };

    const walletStartMatch = logSection.match(/Address: ([\w\d]+)/);
    const timestampMatch = logSection.match(/Timestamp: ([^,]+),/);

    if (walletStartMatch) result.walletAddress = walletStartMatch[1];
    if (timestampMatch) result.scrapeTimestamp = timestampMatch[1];

    if (logSection.includes('[NO_DATA]')) {
        result.status = 'No DeFi activities found.';
        return result;
    }
    if (logSection.includes('[NO_DATA_OR_UNEXPECTED_PAGE_STRUCTURE]')) {
        result.status = 'DeFi table selector not found or page structure was unexpected.';
         // Optionally, you could try to extract the HTML logged in this case for manual inspection
        const htmlMatch = logSection.match(/--- PAGE CONTENT START ---\s*([\s\S]*?)\s*--- PAGE CONTENT END ---/);
        if (htmlMatch && htmlMatch[1]) {
            result.details = "Partial HTML logged, structure might be different.";
        }
        return result;
    }
    const errorMatch = logSection.match(/\[ERROR\] (.*)/);
    if (errorMatch) {
        result.status = 'Error during scraping.';
        result.error = errorMatch[1];
        return result;
    }

    const htmlStartIndex = logSection.indexOf('--- PAGE CONTENT START ---');
    const htmlEndIndex = logSection.lastIndexOf('--- PAGE CONTENT END ---');

    if (htmlStartIndex === -1 || htmlEndIndex === -1) {
        result.status = 'HTML content markers not found in log section.';
        return result;
    }

    const htmlContent = logSection.substring(htmlStartIndex + '--- PAGE CONTENT START ---'.length, htmlEndIndex).trim();
    if (!htmlContent) {
        result.status = 'Empty HTML content in log section.';
        return result;
    }

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
        result.status = 'HTML parsed, but no transaction rows found (selectors might need adjustment or page had no data in table).';
    }
    return result;
}

function cleanAllWalletsLog(logFilePath) {
    if (!fs.existsSync(logFilePath)) {
        console.error(`Log file not found: ${logFilePath}`);
        return;
    }
    const logContent = fs.readFileSync(logFilePath, 'utf-8');
    const outputFilePath = 'cleaned_solscan_transactions.json';
    const allWalletsData = [];

    // Split the log content by the [WALLET_START] delimiter
    // Each part will start with WALLET_START details and end before the next WALLET_START or end of file.
    const walletSections = logContent.split('\n[WALLET_START]').slice(1); // slice(1) to skip content before the first marker

    if (walletSections.length === 0) {
        console.log("No wallet sections found in the log file. Ensure logs are formatted with '\n[WALLET_START]'.");
        fs.writeFileSync(outputFilePath, JSON.stringify([], null, 2));
        return;
    }

    console.log(`Found ${walletSections.length} wallet sections to process.`);

    for (const section of walletSections) {
        // Re-add the delimiter for parsing context if needed, or ensure parseWalletLogSection handles it.
        // Current parseWalletLogSection expects the raw section starting with Timestamp/Address info.
        const fullSection = '[WALLET_START]' + section; // Re-add for consistent parsing if needed by regexes in parseWalletLogSection
        const walletData = parseWalletLogSection(fullSection);
        allWalletsData.push(walletData);
    }

    fs.writeFileSync(outputFilePath, JSON.stringify(allWalletsData, null, 2));
    console.log(`Cleaned data for all wallets written to ${outputFilePath}`);

    if (allWalletsData.length > 0) {
        console.log("Summary of processing:");
        allWalletsData.forEach(data => {
            console.log(`- Wallet: ${data.walletAddress}, Status: ${data.status}, Transactions Found: ${data.transactions.length}, Error: ${data.error || 'N/A'}`);
        });
    }
}

const logFilePath = process.argv[2] || path.join(__dirname, 'logs', 'solscan_wallets.log');
cleanAllWalletsLog(logFilePath); 