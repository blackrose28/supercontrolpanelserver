# How to See the Mobile CSS Changes

## The CSS has been updated with the fix!

The key change: `section` now has `overflow-x: auto !important;` to force horizontal scrolling for tables.

## You MUST hard refresh your browser to see the changes:

### Chrome/Edge (Windows/Linux)
- Press: **Ctrl + Shift + R**
- Or: **Ctrl + F5**

### Chrome/Edge (Mac)
- Press: **Cmd + Shift + R**

### Firefox
- Press: **Ctrl + Shift + R** (Windows/Linux)
- Press: **Cmd + Shift + R** (Mac)

### Safari
- Press: **Cmd + Option + R**

## Alternative: Clear Cache Manually

1. Open DevTools (F12)
2. Right-click the refresh button
3. Select "Empty Cache and Hard Reload"

## What You Should See After Refresh

On iPhone 14 Pro Max (430x932) viewport:

1. ✅ Page does NOT scroll horizontally
2. ✅ Device table DOES scroll horizontally (you can swipe left/right)
3. ✅ "Actions" column is visible when you scroll the table to the right
4. ✅ All 5 columns visible: NAME, STATUS, OS, LAST SEEN, **ACTIONS**

## If It Still Doesn't Work

1. Check the browser console for CSS errors
2. Verify the dev server is running: `ps aux | grep vite`
3. Restart the dev server:
   ```bash
   # In the terminal running the dev server
   Ctrl+C
   npm run dev
   ```
4. Check that src/app.css has 619 lines:
   ```bash
   wc -l src/app.css
   ```

## Verification

After hard refresh, inspect the `<section>` element in DevTools:
- It should have `overflow-x: auto` applied
- The computed style should show `overflow-x: auto`
- The table should be wider than the section container
