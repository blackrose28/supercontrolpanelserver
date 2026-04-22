#!/usr/bin/env node

/**
 * CSS Validation Script
 * Validates CSS files for common syntax errors that stylelint might miss
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const cssFile = resolve('src/app.css');
let hasErrors = false;

console.log('🔍 Validating CSS syntax...\n');

try {
  const css = readFileSync(cssFile, 'utf8');
  const lines = css.split('\n');

  // Check 1: Balanced braces
  let braceCount = 0;
  let braceStack = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    
    for (let j = 0; j < line.length; j++) {
      if (line[j] === '{') {
        braceCount++;
        braceStack.push({ line: lineNum, col: j + 1 });
      }
      if (line[j] === '}') {
        braceCount--;
        braceStack.pop();
        if (braceCount < 0) {
          console.error(`❌ Line ${lineNum}: Extra closing brace`);
          hasErrors = true;
        }
      }
    }
  }

  if (braceCount > 0) {
    console.error(`❌ ERROR: ${braceCount} unclosed brace(s)`);
    console.error('\nUnclosed braces at:');
    braceStack.forEach(b => {
      console.error(`   Line ${b.line}, Column ${b.col}`);
    });
    hasErrors = true;
  } else if (braceCount < 0) {
    console.error(`❌ ERROR: ${Math.abs(braceCount)} extra closing brace(s)`);
    hasErrors = true;
  } else {
    console.log('✅ All braces balanced');
  }

  // Check 2: Media queries are properly closed
  let mediaQueryStack = [];
  braceCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    
    if (line.includes('@media')) {
      mediaQueryStack.push({ 
        line: lineNum, 
        query: line.trim(),
        braceLevel: braceCount
      });
    }
    
    const openBraces = (line.match(/{/g) || []).length;
    const closeBraces = (line.match(/}/g) || []).length;
    braceCount += openBraces - closeBraces;
    
    // Check if media query closed
    if (closeBraces > 0 && mediaQueryStack.length > 0) {
      const lastMq = mediaQueryStack[mediaQueryStack.length - 1];
      if (braceCount === lastMq.braceLevel) {
        mediaQueryStack.pop();
      }
    }
  }

  if (mediaQueryStack.length > 0) {
    console.error(`\n❌ ERROR: ${mediaQueryStack.length} unclosed media query/queries`);
    mediaQueryStack.forEach(mq => {
      console.error(`   Line ${mq.line}: ${mq.query}`);
    });
    hasErrors = true;
  } else {
    console.log('✅ All media queries properly closed');
  }

  // Check 3: No empty selectors
  const emptySelectors = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
    
    // Check for selector followed immediately by closing brace
    if (line.endsWith('{') && !line.startsWith('@') && !line.startsWith('/*')) {
      if (nextLine === '}' || (nextLine === '' && i + 2 < lines.length && lines[i + 2].trim() === '}')) {
        emptySelectors.push(i + 1);
      }
    }
  }

  if (emptySelectors.length > 0) {
    console.warn(`\n⚠️  WARNING: ${emptySelectors.length} empty selector(s) found`);
    emptySelectors.forEach(lineNum => {
      console.warn(`   Line ${lineNum}: ${lines[lineNum - 1].trim()}`);
    });
  } else {
    console.log('✅ No empty selectors');
  }

  // Check 4: Validate media query syntax
  const mediaQueries = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('@media')) {
      const match = line.match(/@media\s+(.+?)\s*{/);
      if (match) {
        const query = match[1];
        // Check for common mistakes
        if (!query.includes('(') || !query.includes(')')) {
          console.error(`\n❌ Line ${i + 1}: Invalid media query syntax: ${line.trim()}`);
          hasErrors = true;
        }
      }
    }
  }

  console.log('✅ Media query syntax valid');

  // Summary
  console.log('\n' + '='.repeat(50));
  if (hasErrors) {
    console.error('❌ CSS validation FAILED');
    console.error('\nPlease fix the errors above before committing.');
    process.exit(1);
  } else {
    console.log('✅ CSS validation PASSED');
    console.log(`\nFile: ${cssFile}`);
    console.log(`Lines: ${lines.length}`);
  }

} catch (error) {
  console.error('❌ Error reading CSS file:', error.message);
  process.exit(1);
}
