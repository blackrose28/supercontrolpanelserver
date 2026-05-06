export class BoundedSeenIds {
  private readonly ids = new Set<string>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = Math.max(1, Math.floor(maxSize) || 1);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  rememberFresh(currentIds: string[]): string[] {
    const nextIds = new Set(currentIds.filter((id) => typeof id === 'string' && id.trim()));
    const fresh: string[] = [];
    for (const id of nextIds) {
      if (!this.ids.has(id)) {
        fresh.push(id);
      }
    }

    this.ids.clear();
    for (const id of nextIds) {
      this.ids.add(id);
      if (this.ids.size >= this.maxSize) {
        break;
      }
    }
    return fresh;
  }

  snapshot(): string[] {
    return Array.from(this.ids);
  }
}
