import { describe, expect, it } from 'vitest';
import { isAdminNextHashedAssetPath } from './admin-next-cache';

describe('admin-next static cache path contract', () => {
  it('matches hashed admin-next asset paths', () => {
    expect(isAdminNextHashedAssetPath('/data/Work/SuperControlPanel/cc-server/public/admin-next/assets/main-abc123.js')).toBe(true);
    expect(isAdminNextHashedAssetPath('C:\\repo\\cc-server\\public\\admin-next\\assets\\main-abc123.js')).toBe(true);
  });

  it('does not match non-asset or legacy paths', () => {
    expect(isAdminNextHashedAssetPath('/data/Work/SuperControlPanel/cc-server/public/admin-next/index.js')).toBe(false);
    expect(isAdminNextHashedAssetPath('/data/Work/SuperControlPanel/cc-server/public/admin/index.js')).toBe(false);
  });
});
