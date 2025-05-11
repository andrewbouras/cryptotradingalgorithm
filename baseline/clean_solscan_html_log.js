const fs = require('fs');
const cheerio = require('cheerio');

function cleanLogData(logFilePath) {
    const logContent = fs.readFileSync(logFilePath, 'utf-8');

    // Find the start and end of the HTML content
    const htmlStartIndex = logContent.indexOf('<!DOCTYPE html>');
    const htmlEndIndex = logContent.lastIndexOf('</html>') + '</html>'.length;

    if (htmlStartIndex === -1 || htmlEndIndex === -1) {
        console.error("Could not find HTML content in the log file.");
        return;
    }

    const htmlContent = logContent.substring(htmlStartIndex, htmlEndIndex);
    const $ = cheerio.load(htmlContent);

    const transactions = [];

    // --- THIS IS A VERY GENERIC SELECTOR AND WILL LIKELY NEED ADJUSTMENT ---
    // Based on the image, we are looking for a table.
    // We need to inspect the actual HTML to find the correct selectors for the table and its rows/cells.
    // Let's assume the table has a specific ID or class, or we can identify it by its columns.
    // For example, if the table rows are `tr` elements within a `tbody`:
    $('tbody tr').each((i, row) => {
        const columns = $(row).find('td');
        // Image has 9 columns including the eye icon. So indices 0-8.
        // Signature, Time, Action, From, Amount, Value, Platform, Source
        if (columns.length > 8) { // Need at least 9 columns to get up to index 8
            const eyeIcon = $(columns[0]).find('svg');
            const signatureLink = $(columns[1]).find('a');
            const signature = signatureLink.text().trim();
            const signatureHref = signatureLink.attr('href');
            const time = $(columns[2]).text().trim();
            const action = $(columns[3]).find('div').text().trim();
            const from = $(columns[4]).find('span > span').first().text().trim();
            const amountCell = $(columns[5]);
            const value = $(columns[6]).text().trim(); // Corrected index
            const platformCell = $(columns[7]); // Corrected index
            const sourceCell = $(columns[8]);   // Corrected index

            const amountText = amountCell.text().replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
            let parsedAmounts = [];
            // Basic parsing for amount: "NUM TOKEN + NUM TOKEN"
            // Example: "60.000005194WSOL199,999,999.999953Dumpy"
            // This will be tricky due to no clear separator for the first token and its amount
            // And the second token may or may not have a $ sign like $Charlie

            // Attempt to split by known token symbols or a pattern
            // This is a simplistic approach and might need refinement based on more HTML inspection
            const amountParts = [];
            let tempAmountText = amountText;

            // Regex to find "NumberTokenSymbol" - this is a common pattern observed
            // It tries to capture a number, then a sequence of uppercase letters possibly with a $ prefix
            const amountRegex = /([0-9.,]+)(\$?[A-Za-z0-9]+)/g;
            let match;
            while((match = amountRegex.exec(tempAmountText)) !== null) {
                amountParts.push({ amount: match[1], token: match[2] });
            }

            // If regex found parts, use them. Otherwise, store raw for manual check.
            if (amountParts.length > 0) {
                parsedAmounts = amountParts;
            } else {
                // Fallback if regex fails - this will need manual inspection of amountText
                // For now, let's try to split by common known tokens if they are clearly separated
                // This is still very heuristic
                if (amountText.includes('WSOL')) {
                    const wsolSplit = amountText.split('WSOL');
                    if (wsolSplit.length === 2) {
                        parsedAmounts.push({ amount: wsolSplit[0].trim(), token: 'WSOL' });
                        // The rest might be the second token and amount
                        // Further split the second part if possible
                        const secondPart = wsolSplit[1].trim();
                        const secondAmountMatch = secondPart.match(/^([0-9.,]+)(.*)/);
                        if (secondAmountMatch) {
                            parsedAmounts.push({ amount: secondAmountMatch[1], token: secondAmountMatch[2].trim() });
                        } else {
                            parsedAmounts.push({ amount: 'UNKNOWN', token: secondPart });
                        }
                    }
                }
            }
            if (parsedAmounts.length === 0) { // If still nothing, store raw
                parsedAmounts.push({raw: amountText});
            }

            const platformImg = platformCell.find('img');
            const sourceImg = sourceCell.find('img');

            if (signature) {
                transactions.push({
                    signature,
                    // signatureHref,
                    time,
                    action,
                    from,
                    amountRaw: amountText,
                    parsedAmounts: parsedAmounts,
                    value,
                    platform: platformImg.attr('alt') || platformImg.attr('src'),
                    source: sourceImg.attr('alt') || sourceImg.attr('src'),
                });
            }
        }
    });

    if (transactions.length > 0) {
        console.log("Found transactions:", transactions.length);
        const outputFilePath = 'cleaned_solscan_transactions.json';
        fs.writeFileSync(outputFilePath, JSON.stringify(transactions, null, 2));
        console.log(`Cleaned data written to ${outputFilePath}`);

        // For terminal display, just show the first few for brevity
        console.log(JSON.stringify(transactions.slice(0, 2), null, 2));
    } else {
        console.log("No transaction data found. The HTML selectors might need adjustment.");
        console.log("Please inspect the HTML structure of the table in 'logs/solscan_wallets.log' and update the cheerio selectors in this script.");
        console.log("Specifically, check the selectors for 'tbody tr', and the individual columns.");
    }
}

// Get the log file path from command line arguments or use a default
const logFilePath = process.argv[2] || 'logs/solscan_wallets.log';

if (!fs.existsSync(logFilePath)) {
    console.error(`Log file not found: ${logFilePath}`);
    console.log("Please ensure the log file exists at the specified path or provide the correct path as a command line argument.");
} else {
    cleanLogData(logFilePath);
} 