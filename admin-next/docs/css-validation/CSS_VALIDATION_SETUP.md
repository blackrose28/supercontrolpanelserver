# CSS Validation Setup ✅

**Date**: 2026-04-22  
**Purpose**: Prevent CSS syntax errors (like missing braces) from breaking the app

## What Was Added

### 1. Stylelint (Industry Standard CSS Linter)

**Installed packages**:
- `stylelint` - CSS linter
- `stylelint-config-standard` - Standard ruleset

**Configuration**: `.stylelintrc.json`
```json
{
  "extends": "stylelint-config-standard",
  "rules": {
    "block-no-empty": true,
    "declaration-block-no-duplicate-properties": true,
    ...
  }
}
```

### 2. Custom CSS Validation Script

**File**: `scripts/validate-css.js`

**What it checks**:
- ✅ Balanced braces (no missing `{` or `}`)
- ✅ All media queries properly closed
- ✅ No empty selectors
- ✅ Valid media query syntax

**Example output**:
```
🔍 Validating CSS syntax...

✅ All braces balanced
✅ All media queries properly closed
✅ No empty selectors
✅ Media query syntax valid

==================================================
✅ CSS validation PASSED
```

### 3. NPM Scripts

Added to `package.json`:

```json
{
  "scripts": {
    "lint:css": "stylelint 'src/**/*.css'",
    "lint:css:fix": "stylelint 'src/**/*.css' --fix",
    "validate:css": "node scripts/validate-css.js",
    "check": "npm run typecheck && npm run test && npm run lint:css && npm run validate:css"
  }
}
```

### 4. Build-Time Validation

**File**: `vite.config.ts`

Added a Vite plugin that runs CSS validation on every build:

```typescript
{
  name: 'css-validate',
  buildStart() {
    try {
      execSync('node scripts/validate-css.js', { stdio: 'inherit' });
    } catch (e) {
      throw new Error('CSS validation failed. Fix errors before building.');
    }
  },
}
```

**Result**: Build will FAIL if CSS has syntax errors.

## How to Use

### During Development

```bash
# Check CSS for errors
npm run lint:css

# Auto-fix style issues
npm run lint:css:fix

# Validate CSS syntax (braces, media queries)
npm run validate:css

# Run all checks (TypeScript, tests, CSS)
npm run check
```

### Before Committing

```bash
# Run all checks
npm run check
```

If this passes, your CSS is valid!

### During Build

```bash
npm run build
```

The build will automatically validate CSS. If there are errors, the build will fail with a clear error message.

## What Gets Caught

### ✅ Missing Closing Braces

**Before** (would break all media queries):
```css
.telemetry-section a[aria-disabled='true'] {
  /* Missing closing brace! */

@media (max-width: 767px) {
  /* This won't work */
}
```

**After** (validation catches it):
```
❌ ERROR: 1 unclosed brace(s)

Unclosed braces at:
   Line 343, Column 45
```

### ✅ Unclosed Media Queries

```css
@media (max-width: 768px) {
  .foo { color: red; }
  /* Missing closing brace for @media */

.bar { color: blue; }
```

**Validation output**:
```
❌ ERROR: 1 unclosed media query/queries
   Line 365: @media (max-width: 768px) {
```

### ✅ Empty Selectors

```css
.empty-selector {
}
```

**Validation output**:
```
⚠️  WARNING: 1 empty selector(s) found
   Line 123: .empty-selector {
```

### ✅ Invalid Media Query Syntax

```css
@media max-width: 768px {  /* Missing parentheses */
  ...
}
```

**Validation output**:
```
❌ Line 365: Invalid media query syntax
```

## Testing the Validation

### Test 1: Introduce a Missing Brace

```bash
# Edit src/app.css and remove a closing brace
# Then run:
npm run validate:css
```

**Expected**: Error message showing unclosed brace location.

### Test 2: Try to Build with Invalid CSS

```bash
# With the missing brace still there:
npm run build
```

**Expected**: Build fails with validation error.

### Test 3: Fix and Verify

```bash
# Fix the CSS
# Then run:
npm run validate:css
npm run build
```

**Expected**: Both pass successfully.

## CI/CD Integration

Add to your CI pipeline:

```yaml
# .github/workflows/ci.yml (example)
- name: Install dependencies
  run: npm install

- name: Run all checks
  run: npm run check

- name: Build
  run: npm run build
```

The build will fail if CSS is invalid, preventing broken CSS from being deployed.

## Benefits

1. **Prevents Production Bugs**: Invalid CSS caught before deployment
2. **Fast Feedback**: Errors shown immediately during development
3. **Clear Error Messages**: Exact line numbers for issues
4. **Automated**: No manual checking needed
5. **Build Integration**: Can't build with broken CSS

## What Happened Before

**The Problem**:
- Missing closing brace at line 343
- All media queries (including card layout) became invalid
- No error messages in browser console
- Hard to debug (CSS is forgiving)
- Took hours to find the issue

**Now**:
- Validation catches it immediately
- Clear error message with line number
- Build fails if CSS is broken
- Can't accidentally commit broken CSS

## Maintenance

### Updating Rules

Edit `.stylelintrc.json` to add/remove rules:

```json
{
  "rules": {
    "your-new-rule": true
  }
}
```

### Disabling Specific Rules

If a rule is too strict:

```json
{
  "rules": {
    "rule-name": null
  }
}
```

### Ignoring Files

Create `.stylelintignore`:

```
# Ignore vendor CSS
node_modules/
dist/
```

## Summary

✅ **Stylelint**: Industry-standard CSS linting  
✅ **Custom validation**: Catches missing braces and media query issues  
✅ **Build integration**: Automatic validation on every build  
✅ **NPM scripts**: Easy to run manually  
✅ **Clear errors**: Exact line numbers and descriptions  

**Result**: CSS syntax errors will never break the app again!
