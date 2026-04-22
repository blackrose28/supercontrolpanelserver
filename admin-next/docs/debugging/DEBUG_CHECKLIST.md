# Quick Debug Checklist

## In Browser DevTools (F12)

### 1. Check Viewport Width
- DevTools → Toggle device toolbar (Ctrl+Shift+M)
- Set to "iPhone 14 Pro Max" or custom 430x932
- **Must be < 768px for card layout**

### 2. Inspect Table Element
- Right-click table → Inspect
- Look at Styles tab
- Search for `@media (max-width: 767px)`
- **Is it there? Is it crossed out?**

### 3. Check Computed Display
- Select `<table>` element
- Go to Computed tab
- Search for "display"
- **Should be: `display: block`**
- **NOT: `display: table`**

### 4. Check for Conflicts
In Styles tab, look for:
- ❌ `table { display: table; }`
- ❌ `table { min-width: 650px; }`
- ❌ Any crossed-out `display: block`

### 5. Verify Data Labels
- Elements tab → Expand `<tbody>` → Click `<td>`
- **Should see**: `<td data-label="Name">test-device-1</td>`
- **If missing**: Component not updated

## Quick Fixes

### If media query not applying:
```bash
# Check viewport is < 768px in DevTools
```

### If display: table (not block):
```bash
# Check for conflicting CSS
grep -n "table {" src/app.css
# Lines 118, 515 should NOT have display or min-width
```

### If styles crossed out:
```bash
# Add !important to display: block
sed -i '587s/display: block;/display: block !important;/' src/app.css
```

## Current State

- **CSS file**: 684 lines
- **Card layout**: Line 574-690
- **Component**: Has data-label attributes
- **Server**: Running on localhost:5173

## What to Tell Me

If it's still not working, tell me:

1. **Viewport width in DevTools**: (e.g., 430px)
2. **Computed display value**: (e.g., "table" or "block")
3. **Is @media (max-width: 767px) visible in Styles tab?**: (yes/no)
4. **Is it crossed out?**: (yes/no)
5. **Any console errors?**: (copy/paste)

This will help me identify the exact issue!
