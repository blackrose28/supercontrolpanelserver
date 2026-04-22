import { HttpException, HttpStatus } from '@nestjs/common';
import { SUPPORTED_COMMAND_TYPES } from './command-dispatch.catalog';

export function unsupportedCommandTypeError() {
  return new HttpException(
    {
      ok: false,
      code: 'COMMAND_TYPE_UNSUPPORTED',
      message: 'Unsupported commandType',
      supportedCommandTypes: SUPPORTED_COMMAND_TYPES,
    },
    HttpStatus.BAD_REQUEST,
  );
}
