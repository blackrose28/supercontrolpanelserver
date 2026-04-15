const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  // Capture all network requests
  page.on('request', req => {
    if (req.url().includes('/v1/')) {
      console.log('REQ:', req.method(), req.url());
    }
  });
  
  page.on('response', res => {
    if (res.url().includes('/v1/')) {
      console.log('RES:', res.status(), res.url());
    }
  });
  
  try {
    await page.goto('http://localhost:3000/admin/login', { timeout: 10000 });
    await page.fill('input[name="password"]', '1726444301');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3000);
    
    // Check cookies
    const cookies = await context.cookies();
    console.log('\nCookies after login:');
    for (const c of cookies) {
      console.log('  ', c.name, '=', c.value.substring(0, 30));
    }
    
    // Check any console errors
    console.log('\nChecking console errors...');
    
  } catch (e) {
    console.log('Error:', e.message);
  }
  
  await browser.close();
})();
