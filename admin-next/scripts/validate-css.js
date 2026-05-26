#!/usr/bin/env node

/**
 * CSS Validation Script
 * Validates CSS files for common syntax errors that stylelint might miss
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';

function getCssFiles(dir) {
  let results = [];
  try {
    const list = readdirSync(dir);
    list.forEach(file => {
      const filePath = join(dir, file);
      const stat = statSync(filePath);
      if (stat && stat.isDirectory()) {
        results = results.concat(getCssFiles(filePath));
      } else if (file.endsWith('.css')) {
        results.push(filePath);
      }
    });
  } catch (err) {
    // Ignore if dir doesn't exist
  }
  return results;
}

const cssFiles = [resolve('src/app.css'), ...getCssFiles(resolve('src/styles'))];
let hasErrors = false;

console.log('🔍 Validating CSS syntax...\n');

cssFiles.forEach(cssFile => {
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
            console.error(`❌ ${cssFile} - Line ${lineNum}: Extra closing brace`);
            hasErrors = true;
          }
        }
      }
    }

    if (braceCount > 0) {
      console.error(`❌ ${cssFile} - ERROR: ${braceCount} unclosed brace(s)`);
      console.error('\nUnclosed braces at:');
      braceStack.forEach(b => {
        console.error(`   Line ${b.line}, Column ${b.col}`);
      });
      hasErrors = true;
    } else if (braceCount < 0) {
      console.error(`❌ ${cssFile} - ERROR: ${Math.abs(braceCount)} extra closing brace(s)`);
      hasErrors = true;
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
      console.error(`\n❌ ${cssFile} - ERROR: ${mediaQueryStack.length} unclosed media query/queries`);
      mediaQueryStack.forEach(mq => {
        console.error(`   Line ${mq.line}: ${mq.query}`);
      });
      hasErrors = true;
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
      console.warn(`\n⚠️  ${cssFile} - WARNING: ${emptySelectors.length} empty selector(s) found`);
      emptySelectors.forEach(lineNum => {
        console.warn(`   Line ${lineNum}: ${lines[lineNum - 1].trim()}`);
      });
    }

    // Check 4: Validate media query syntax
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('@media')) {
        const match = line.match(/@media\s+(.+?)\s*{/);
        if (match) {
          const query = match[1];
          // Check for common mistakes
          if (!query.includes('(') || !query.includes(')')) {
            console.error(`\n❌ ${cssFile} - Line ${i + 1}: Invalid media query syntax: ${line.trim()}`);
            hasErrors = true;
          }
        }
      }
    }

  } catch (error) {
    console.error(`❌ Error reading ${cssFile}:`, error.message);
    hasErrors = true;
  }
});

// Summary
console.log('\n' + '='.repeat(50));
if (hasErrors) {
  console.error('❌ CSS validation FAILED');
  console.error('\nPlease fix the errors above.');
  process.exit(1);
} else {
  console.log('✅ CSS validation PASSED');
  console.log(`Files validated: ${cssFiles.length}`);
}

