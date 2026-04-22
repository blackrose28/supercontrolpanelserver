# Card Layout Implementation - Technical Explanation

## How It Works

The card layout uses a CSS technique to transform an HTML `<table>` into card-style blocks on mobile devices.

## The HTML Structure (DeviceListSection.tsx)

```tsx
<table>
  <thead>
    <tr>
      <th>Name</th>
      <th>Status</th>
      <th>OS</th>
      <th>Last Seen</th>
      <th>Actions</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td data-label="Name">test-device-1</td>
      <td data-label="Status">connected</td>
      <td data-label="OS">linux</td>
      <td data-label="Last Seen">2026-04-22...</td>
      <td data-label="Actions">
        <div class="device-actions-cell">
          <button>Select</button>
          <button>Actions</button>
        </div>
      </td>
    </tr>
  </tbody>
</table>
```

**Key addition**: `data-label` attributes on each `<td>` element.

## The CSS Technique (@media max-width: 767px)

### Step 1: Convert Table Elements to Block

```css
section table,
section thead,
section tbody,
section th,
section td,
section tr {
  display: block;
}
```

This makes all table elements behave like `<div>` blocks instead of table cells.

### Step 2: Hide Table Headers

```css
section thead tr {
  position: absolute;
  top: -9999px;
  left: -9999px;
}
```

Headers are hidden off-screen (not `display: none` for accessibility).

### Step 3: Style Each Row as a Card

```css
section tbody tr {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  margin-bottom: 12px;
  padding: 12px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}
```

Each `<tr>` becomes a card with border, shadow, and spacing.

### Step 4: Add Labels Using CSS Pseudo-Elements

```css
section td:before {
  content: attr(data-label);
  font-weight: 600;
  color: #6b7280;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  display: block;
  margin-bottom: 3px;
}
```

This reads the `data-label` attribute and displays it as a label above each value.

### Step 5: Style Device Name (First Cell)

```css
section td:first-child {
  font-size: 16px;
  font-weight: 600;
  color: #111827;
  padding-bottom: 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid #e5e7eb;
}

section td:first-child:before {
  display: none;  /* No label for device name */
}
```

### Step 6: Full-Width Action Buttons

```css
.device-actions-cell {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.device-actions-cell button {
  width: 100%;
  padding: 10px;
  font-size: 14px;
  text-align: center;
}
```

## How to Debug

### 1. Check if CSS is loaded

Open DevTools → Sources → Find `app.css` → Search for `@media (max-width: 767px)`

**Expected**: You should see the card layout CSS starting at line 574.

### 2. Check if media query is active

Open DevTools → Elements → Select the `<table>` element → Styles tab

**Expected**: You should see `@media (max-width: 767px)` section with styles applied (not crossed out).

### 3. Check computed display property

DevTools → Elements → Select `<table>` → Computed tab → Search for "display"

**Expected**: `display: block` (NOT `display: table`)

### 4. Check for conflicting media queries

Search the Styles tab for other `@media` rules that might be overriding.

**Common conflicts**:
- `@media (max-width: 768px)` - Should NOT have table rules
- `@media (max-width: 480px)` - Should NOT have table rules
- Any `table { display: table; }` or `table { min-width: ... }`

### 5. Check data-label attributes

DevTools → Elements → Expand `<tbody>` → Check `<td>` elements

**Expected**: Each `<td>` should have `data-label="Name"`, `data-label="Status"`, etc.

### 6. Check CSS specificity

If styles aren't applying, check if there's a more specific selector overriding.

**Example conflict**:
```css
/* More specific - wins */
body section table {
  display: table !important;
}

/* Less specific - loses */
section table {
  display: block;
}
```

## Current File State

**src/app.css**: 684 lines

**Media queries in order**:
1. Line 365: `@media (max-width: 768px)` - General mobile (NO table rules)
2. Line 501: `@media (max-width: 480px)` - Small screens (NO table rules)
3. Line 562: `@media (max-width: 768px) and (orientation: landscape)`
4. Line 574: `@media (max-width: 767px)` - **CARD LAYOUT HERE**

**Component**: `src/components/DeviceListSection.tsx` (145 lines)
- Has `data-label` attributes on all `<td>` elements

## Common Issues

### Issue 1: Media query not applying
**Cause**: Viewport width is >= 768px
**Fix**: Set DevTools to exactly 430px width (iPhone 14 Pro Max)

### Issue 2: Table still showing
**Cause**: Another media query is overriding with table rules
**Fix**: Check 768px and 480px media queries have NO table rules

### Issue 3: Labels not showing
**Cause**: `data-label` attributes missing
**Fix**: Check component has `data-label="Name"` etc. on `<td>` elements

### Issue 4: Styles crossed out in DevTools
**Cause**: CSS specificity conflict
**Fix**: Add `!important` or increase selector specificity

## Testing Commands

```bash
cd /data/Work/SuperControlPanel/cc-server/admin-next

# Verify card layout exists
sed -n '574,590p' src/app.css

# Check for conflicting table rules
grep -n "table {" src/app.css

# Verify data-labels in component
grep "data-label" src/components/DeviceListSection.tsx

# Check file sizes
wc -l src/app.css src/components/DeviceListSection.tsx
```

## What Should Happen

1. **Desktop (≥768px)**: Normal table layout
2. **Mobile (<768px)**: Card layout with:
   - Each row = one card
   - Device name at top (bold, no label)
   - Labels above each value
   - Full-width buttons
   - No horizontal scrolling

## If It's Still Not Working

Check these in DevTools:

1. **Network tab**: Is `app.css` loading? Check the response content.
2. **Console tab**: Any CSS errors?
3. **Elements tab**: Inspect the `<table>` and check computed styles.
4. **Styles tab**: Is the `@media (max-width: 767px)` section visible and not crossed out?

If all CSS looks correct but it's still not working, there might be:
- Browser extension blocking styles
- Cached service worker
- Different CSS file being loaded
- JavaScript modifying styles after load
