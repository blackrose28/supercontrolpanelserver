const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  const logs = [];
  page.on('console', msg => logs.push(msg.text()));
  page.on('pageerror', err => logs.push('PAGE ERROR: ' + err.message));
  
  try {
    await page.goto('http://localhost:3000/admin/login', { timeout: 10000 });
    await page.fill('input[name="password"]', '1726444301');
    await page.click('button[type="submit"]');
    
    // Wait for page to fully load
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);
    
    console.log('=== Checking Fetch Calls ===');
    
    // Try manually calling /v1/devices with the cookie
    const cookies = await context.cookies();
    console.log('Cookies:', cookies.map(c => c.name + '=' + c.value.substring(0,20)));
    
    // Check the devices tbody again
    const tbody = await page.$('#devices-tbody');
    if (tbody) {
      const html = await tbody.innerHTML();
      console.log('\nDevices TBody HTML:');
      console.log(html);
    }
    
    // Check if there's a visible devices table with rows
    const rows = await page.$$('.devices-table tbody tr');
    console.log('\nTable rows:', rows.length);
    
    // Look for any table data
    const tds = await page.$$('.devices-table td');
    console.log('TD elements:', tds.length);
    for (const td of tds.slice(0,5)) {
      console.log('  -', await td.textContent());
    }
    
    console.log('\n=== Console Output ===');
    logs.filter(l => !l.includes('favicon')).slice(0,10).forEach(l => console.log(l));
    
  } catch (e) {
    console.log('Error:', e.message);
  }
  
  await browser.close();
})();
