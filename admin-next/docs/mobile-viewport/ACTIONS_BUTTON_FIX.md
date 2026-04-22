# Actions Button Offscreen Fix

## Issue
The "Actions" button in the device table was appearing offscreen on iPhone 14 Pro Max (430x932) viewport.

## Root Cause
The table was not properly configured for horizontal scrolling. The previous CSS attempted to make individual table elements scrollable, but the container (section) needed to be the scroll container.

## Solution Applied

### Key Changes in src/app.css

1. **Section as Scroll Container**
```css
@media (max-width: 768px) {
  section {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
}
```

2. **Table Configuration**
```css
@media (max-width: 768px) {
  table {
    min-width: 600px;
    font-size: 12px;
    display: table;
    width: auto;
  }
  
  th,
  td {
    padding: 6px 8px;
    font-size: 11px;
    white-space: nowrap;
  }
}
```

3. **Device Actions Cell**
```css
@media (max-width: 768px) {
  .device-actions-cell {
    display: flex;
    flex-wrap: nowrap;
    gap: 4px;
    min-width: 140px;
  }
  
  .device-actions-cell button {
    font-size: 11px;
    padding: 6px 8px;
    white-space: nowrap;
  }
}
```

4. **Body Margin Reset**
```css
body {
  margin: 0;
  padding: 0;
}
```

5. **Box Sizing**
```css
@media (max-width: 768px) {
  main {
    padding: 12px;
    max-width: 100%;
    overflow-x: hidden;
    box-sizing: border-box;
  }
  
  .panel-section,
  section {
    padding: 12px;
    margin-bottom: 12px;
    overflow-x: hidden;
    box-sizing: border-box;
  }
}
```

## How It Works

1. **Viewport Constraint**: The main container and all parent elements have `overflow-x: hidden` to prevent page-level horizontal scrolling
2. **Section Scrolling**: Each `<section>` element (which wraps tables) has `overflow-x: auto` to enable horizontal scrolling within that section
3. **Table Width**: Tables maintain a minimum width (600px on mobile, 500px on small phones) to ensure all columns are readable
4. **Touch Scrolling**: `-webkit-overflow-scrolling: touch` provides smooth momentum scrolling on iOS devices
5. **No Wrap**: Table cells use `white-space: nowrap` to prevent text wrapping and maintain column structure

## Result

- The page itself does not scroll horizontally
- The device table scrolls horizontally within its section
- All buttons (Select, Actions) are accessible by scrolling the table
- Touch scrolling is smooth and natural on mobile devices

## Testing

1. Open the app in Chrome DevTools
2. Set viewport to iPhone 14 Pro Max (430x932)
3. Navigate to the Devices section
4. Verify:
   - ✓ Page does not scroll horizontally
   - ✓ Table scrolls horizontally within its container
   - ✓ "Actions" button is accessible by scrolling the table
   - ✓ Scrolling is smooth with momentum

## File Modified
- `src/app.css` (624 lines total)

## Verification Commands
```bash
# Check section overflow
grep -A 3 "section {" src/app.css | grep "overflow-x: auto"

# Check table configuration
grep -A 5 "table {" src/app.css | grep "min-width: 600px"

# Verify file size
wc -l src/app.css
# Should output: 624
```
