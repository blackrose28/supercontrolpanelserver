import { describe, expect, it } from 'vitest';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { LogsController } from './logs.controller';

describe('LogsController route contracts', () => {
  it('registers summary endpoint at GET /v1/device-summary', () => {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, LogsController);
    expect(controllerPath).toBe('v1');

    const summaryPath = Reflect.getMetadata(PATH_METADATA, LogsController.prototype.summary);
    const summaryMethod = Reflect.getMetadata(METHOD_METADATA, LogsController.prototype.summary);

    expect(summaryPath).toBe('device-summary');
    expect(summaryMethod).toBe(RequestMethod.GET);
  });

  it('does not expose a GET logs/device-summary route', () => {
    const methodNames = Object.getOwnPropertyNames(LogsController.prototype)
      .filter((name) => name !== 'constructor');

    const getPaths = methodNames
      .map((name) => ({
        name,
        path: Reflect.getMetadata(PATH_METADATA, LogsController.prototype[name]),
        method: Reflect.getMetadata(METHOD_METADATA, LogsController.prototype[name]),
      }))
      .filter((entry) => entry.method === RequestMethod.GET)
      .map((entry) => entry.path);

    expect(getPaths).not.toContain('logs/device-summary');
  });
});
