export function isAdminNextHashedAssetPath(path: string): boolean {
  const normalizedPath = path.replaceAll('\\', '/');
  return normalizedPath.includes('/public/admin-next/assets/');
}
