const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  const logs = [];
  page.on('console', msg => logs.push(msg.text()));
  page.on('pageerror', err => logs.push('ERROR: ' + err.message));
  
  try {
    await page.goto('http://localhost:3000/admin/login', { timeout: 10000 });
    await page.fill('input[name="password"]', '1726444301');
    await page.click('button[type="submit"]');
    
    // Wait longer
    await page.waitForTimeout(8000);
    
    // Get tbody content
    const tbody = await page.$('#devices-tbody');
    const html = await tbody.innerHTML();
    console.log('Devices TBody:', html.substring(0, 300));
    
    // Check for JS errors
    console.log('\nConsole:');
    logs.forEach(l => console.log(l));
    
  } catch (e) {
    console.log('Error:', e.message);
  }
  
  await browser.close();
})();
