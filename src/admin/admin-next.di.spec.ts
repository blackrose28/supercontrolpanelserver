import { describe, expect, it } from 'vitest';
import { AdminNextController } from './admin-next.controller';
import { AdminSessionService } from './admin-session.service';

describe('AdminNextController DI wiring', () => {
  it('depends only on AdminSessionService', () => {
    const paramTypes = Reflect.getMetadata('design:paramtypes', AdminNextController) as Array<unknown>;

    expect(paramTypes).toHaveLength(1);
    expect(paramTypes[0]).toBe(AdminSessionService);
  });
});
