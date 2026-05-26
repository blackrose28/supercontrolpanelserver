import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('admin-next CSS structure and rules', () => {
  const srcDir = resolve(__dirname);
  const appCssPath = resolve(srcDir, 'app.css');
  const stylesDir = resolve(srcDir, 'styles');

  it('verifies that app.css only contains @import statements pointing to the new split styles', () => {
    const css = readFileSync(appCssPath, 'utf8');
    const lines = css.split('\n').map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('/*'));
    
    // Verify app.css is small and contains imports
    expect(lines.length).toBeLessThan(25);
    
    const expectedImports = [
      '@import url("./styles/base.css");',
      '@import url("./styles/device.css");',
      '@import url("./styles/runtime.css");',
      '@import url("./styles/logs.css");',
      '@import url("./styles/commands.css");',
      '@import url("./styles/transfers.css");',
      '@import url("./styles/telemetry.css");',
      '@import url("./styles/terminal.css");',
      '@import url("./styles/responsive.css");',
    ];

    expectedImports.forEach(imp => {
      expect(css).toContain(imp);
    });
  });

  it('verifies that all split CSS files exist', () => {
    const files = [
      'base.css',
      'device.css',
      'runtime.css',
      'logs.css',
      'commands.css',
      'transfers.css',
      'telemetry.css',
      'terminal.css',
      'responsive.css',
    ];

    files.forEach(file => {
      expect(existsSync(resolve(stylesDir, file))).toBe(true);
    });
  });

  it('verifies that commands.css defines a text color on .command-state-badge and .transfer-state-badge to avoid inheritance issues', () => {
    const commandsCssPath = resolve(stylesDir, 'commands.css');
    // If the file doesn't exist, this will throw, which is expected during RED phase
    const css = readFileSync(commandsCssPath, 'utf8');
    
    const badgeRuleMatch = css.match(/\.command-state-badge,\s*\.transfer-state-badge\s*\{([^}]+)\}/);
    expect(badgeRuleMatch).not.toBeNull();
    
    const ruleContent = badgeRuleMatch![1];
    expect(ruleContent).toContain('color:');
  });
});

