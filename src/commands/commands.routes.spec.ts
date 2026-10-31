import { describe, expect, it } from 'vitest';
import { PATH_METADATA, SSE_METADATA } from '@nestjs/common/constants';
import { CommandsController } from './commands.controller';

describe('CommandsController SSE route contract', () => {
  it('registers SSE endpoint at commands/stream', () => {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, CommandsController);
    expect(controllerPath).toBe('v1');

    const streamPath = Reflect.getMetadata(PATH_METADATA, CommandsController.prototype.streamCommands);
    const isSse = Reflect.getMetadata(SSE_METADATA, CommandsController.prototype.streamCommands);

    expect(streamPath).toBe('commands/stream');
    expect(isSse).toBe(true);
  });
});
