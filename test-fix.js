const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  const logs = [];
  page.on('pageerror', err => logs.push('ERROR: ' + err.message));
  
  await page.goto('http://localhost:3000/admin/login');
  await page.fill('input[name="password"]', '1726444301');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(5000);
  
  const tbody = await page.$('#devices-tbody');
  const html = await tbody.innerHTML();
  console.log('Devices tbody:', html.substring(0, 400));
  
  console.log('Errors:', logs.length > 0 ? logs.join(', ') : 'None');
  
  await browser.close();
})();
