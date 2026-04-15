const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  page.on('pageerror', err => {
    console.log('PAGE ERROR:', err.message);
    console.log('STACK:', err.stack);
  });
  
  await page.goto('http://localhost:3000/admin/login');
  await page.fill('input[name="password"]', '1726444301');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(5000);
  
  await browser.close();
})();
