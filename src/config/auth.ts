function requireSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalSecret(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function getAdminPassword(): string {
  return requireSecret('CC_ADMIN_PASSWORD');
}

export function getAdminApiToken(): string | undefined {
  return optionalSecret('CC_ADMIN_API_TOKEN');
}

export function getBootstrapToken(): string {
  return requireSecret('CC_BOOTSTRAP_TOKEN');
}

export function validateAuthConfig() {
  const adminPassword = getAdminPassword();
  const adminApiToken = getAdminApiToken();
  const bootstrapToken = getBootstrapToken();

  if (adminPassword.length < 8) {
    console.warn(
      '[CC] Warning: CC_ADMIN_PASSWORD is shorter than 8 characters; use a stronger secret.',
    );
  }

  if (bootstrapToken.length < 16) {
    console.warn(
      '[CC] Warning: CC_BOOTSTRAP_TOKEN is shorter than 16 characters; use a stronger secret.',
    );
  }

  if (adminApiToken && adminApiToken.length < 16) {
    console.warn(
      '[CC] Warning: CC_ADMIN_API_TOKEN is shorter than 16 characters; use a stronger secret.',
    );
  }
}
