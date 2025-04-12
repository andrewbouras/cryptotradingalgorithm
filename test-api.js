const fetch = require('node-fetch');

// Function to add a token to monitor
async function addTokenToMonitor(mintAddress) {
  try {
    const response = await fetch('http://localhost:3000/watch-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ mintAddress })
    });

    const data = await response.json();
    console.log(`Response for ${mintAddress}:`, data);
    return data;
  } catch (error) {
    console.error(`Error adding token ${mintAddress}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Example tokens to monitor (replace with actual addresses)
const tokenAddresses = [
  '8kbcZpump', // Example token with "pump" in the address
  'AnotherTokenWithpump123',
  'TokenWithoutPump' // This one should be rejected
];

// Test the API by adding each token one by one
async function runTest() {
  console.log('Testing the multi-token monitor API...');
  
  for (const address of tokenAddresses) {
    console.log(`Adding token: ${address}`);
    await addTokenToMonitor(address);
    
    // Wait 2 seconds between requests to avoid overwhelming the browser
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log('Test completed!');
}

// Run the test
runTest(); 