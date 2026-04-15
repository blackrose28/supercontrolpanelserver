import {
  Body,
  Controller,
  Headers,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { requireAdminMutationAuthorized } from '../admin/admin-auth';
import { AdminSessionService } from '../admin/admin-session.service';
import { AdminApiTokenService } from '../admin/admin-api-token.service';
import { CommandDispatchService } from '../commands/command-dispatch.service';
import { AgentGateway } from '../agent/agent.gateway';
import { RemoteBrowserSessionStore } from './remote-browser-session.store';

@Controller('v1/file-ops/remote-browser')
export class RemoteBrowserController {
  constructor(
    private readonly commandDispatch: CommandDispatchService,
    private readonly agentGateway: AgentGateway,
    private readonly browserSessions: RemoteBrowserSessionStore,
    private readonly adminSessions: AdminSessionService,
    private readonly adminApiTokens: AdminApiTokenService,
  ) {}

  @Post('open')
  async open(
    @Body('deviceId') deviceId: string | undefined,
    @Body('serverId') serverId: string | undefined,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    const principal = requireAdminMutationAuthorized(
      auth,
      cookie,
      csrfToken,
      this.adminSessions,
      this.adminApiTokens,
      ['device:control'],
    );

    const normalizedDeviceId = String(deviceId || '').trim();
    const normalizedServerId = String(serverId || '').trim();

    let response;
    try {
      response = this.commandDispatch.dispatchGenericCommand({
        deviceId: normalizedDeviceId,
        commandType: 'open_remote_browser',
        payload: { serverId: normalizedServerId },
        principal,
      });
    } catch (error) {
      const payload =
        error && typeof error === 'object' && 'response' in error
          ? (error as any).response
          : null;
      const browserSessionId =
        payload && typeof payload === 'object' && 'command' in payload
          && payload.command && typeof payload.command === 'object'
          && 'payload' in payload.command && payload.command.payload
          && typeof payload.command.payload === 'object'
          && typeof (payload.command.payload as Record<string, unknown>).browserSessionId === 'string'
          ? String((payload.command.payload as Record<string, unknown>).browserSessionId)
          : null;
      if (browserSessionId) {
        this.browserSessions.markFailed(
          browserSessionId,
          extractErrorCode(error),
          extractErrorDetail(error),
          new Date().toISOString(),
        );
      }
      throw error;
    }
    const reqSeq = typeof response.command?.reqSeq === 'number'
      ? response.command.reqSeq
      : null;
    if (reqSeq == null) {
      throw new HttpException('Missing reqSeq for open_remote_browser', HttpStatus.CONFLICT);
    }

    const normalizedBrowserSessionId =
      response.command && response.command.payload && typeof response.command.payload === 'object'
        && typeof (response.command.payload as Record<string, unknown>).browserSessionId === 'string'
        ? String((response.command.payload as Record<string, unknown>).browserSessionId)
        : null;

    let ack;
    try {
      ack = await this.awaitResponse(String(deviceId || '').trim(), reqSeq);
    } catch (error) {
      if (normalizedBrowserSessionId) {
        const code = extractErrorCode(error);
        const detail = extractErrorDetail(error);
        this.browserSessions.markFailed(
          normalizedBrowserSessionId,
          code,
          detail,
          new Date().toISOString(),
        );
      }
      throw error;
    }
    const payload = ack.payload && typeof ack.payload === 'object' ? ack.payload as Record<string, unknown> : {};
    const browserSessionId = typeof payload.browserSessionId === 'string' ? payload.browserSessionId : null;
    const rootPath = typeof payload.rootPath === 'string' ? payload.rootPath : null;
    if (browserSessionId) {
      this.browserSessions.markOpen(browserSessionId, ack.ts, rootPath);
    }
    return payload;
  }

  @Post('list')
  async list(
    @Body('deviceId') deviceId: string | undefined,
    @Body('browserSessionId') browserSessionId: string | undefined,
    @Body('path') path: string | undefined,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    return this.dispatchBrowserCommand(
      auth,
      cookie,
      csrfToken,
      {
        deviceId,
        commandType: 'list_remote_browser_children',
        payload: {
          browserSessionId: String(browserSessionId || '').trim(),
          path: String(path || '').trim(),
        },
      },
    );
  }

  @Post('stat')
  async stat(
    @Body('deviceId') deviceId: string | undefined,
    @Body('browserSessionId') browserSessionId: string | undefined,
    @Body('path') path: string | undefined,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    return this.dispatchBrowserCommand(
      auth,
      cookie,
      csrfToken,
      {
        deviceId,
        commandType: 'stat_remote_browser_path',
        payload: {
          browserSessionId: String(browserSessionId || '').trim(),
          path: String(path || '').trim(),
        },
      },
    );
  }

  @Post('mkdir')
  async mkdir(
    @Body('deviceId') deviceId: string | undefined,
    @Body('browserSessionId') browserSessionId: string | undefined,
    @Body('path') path: string | undefined,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    return this.dispatchBrowserCommand(
      auth,
      cookie,
      csrfToken,
      {
        deviceId,
        commandType: 'create_remote_browser_directory',
        payload: {
          browserSessionId: String(browserSessionId || '').trim(),
          path: String(path || '').trim(),
        },
      },
    );
  }

  @Post('delete')
  async deletePath(
    @Body('deviceId') deviceId: string | undefined,
    @Body('browserSessionId') browserSessionId: string | undefined,
    @Body('path') path: string | undefined,
    @Body('recursive') recursive: boolean | undefined,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    return this.dispatchBrowserCommand(
      auth,
      cookie,
      csrfToken,
      {
        deviceId,
        commandType: 'delete_remote_browser_path',
        payload: {
          browserSessionId: String(browserSessionId || '').trim(),
          path: String(path || '').trim(),
          recursive: Boolean(recursive),
        },
      },
    );
  }

  @Post('close')
  async close(
    @Body('deviceId') deviceId: string | undefined,
    @Body('browserSessionId') browserSessionId: string | undefined,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    const payload = await this.dispatchBrowserCommand(
      auth,
      cookie,
      csrfToken,
      {
        deviceId,
        commandType: 'close_remote_browser',
        payload: {
          browserSessionId: String(browserSessionId || '').trim(),
        },
      },
    );
    const normalizedBrowserSessionId = String(browserSessionId || '').trim();
    if (normalizedBrowserSessionId) {
      this.browserSessions.markClosed(normalizedBrowserSessionId, new Date().toISOString());
    }
    return payload;
  }

  private async dispatchBrowserCommand(
    auth: string | undefined,
    cookie: string | undefined,
    csrfToken: string | undefined,
    input: {
      deviceId: string | undefined;
      commandType: string;
      payload: Record<string, unknown>;
    },
  ) {
    const principal = requireAdminMutationAuthorized(
      auth,
      cookie,
      csrfToken,
      this.adminSessions,
      this.adminApiTokens,
      ['device:control'],
    );

    const normalizedDeviceId = String(input.deviceId || '').trim();
    const response = this.commandDispatch.dispatchGenericCommand({
      deviceId: normalizedDeviceId,
      commandType: input.commandType,
      payload: input.payload,
      principal,
    });
    const reqSeq = typeof response.command?.reqSeq === 'number'
      ? response.command.reqSeq
      : null;
    if (reqSeq == null) {
      throw new HttpException(`Missing reqSeq for ${input.commandType}`, HttpStatus.CONFLICT);
    }
    const ack = await this.awaitResponse(normalizedDeviceId, reqSeq);
    return ack.payload;
  }

  private async awaitResponse(deviceId: string, reqSeq: number) {
    try {
      return await this.agentGateway.awaitReqResponse(deviceId, reqSeq);
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error && typeof (error as any).code === 'string'
          ? (error as any).code
          : 'AGENT_COMMAND_FAILED';
      const payload =
        error && typeof error === 'object' && 'payload' in error
          ? (error as any).payload
          : null;
      throw new HttpException(
        {
          ok: false,
          code,
          payload,
        },
        code === 'rate_limited' ? HttpStatus.TOO_MANY_REQUESTS : HttpStatus.CONFLICT,
      );
    }
  }
}

function extractErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: unknown }).response;
    if (response && typeof response === 'object' && 'code' in response && typeof (response as { code?: unknown }).code === 'string') {
      return String((response as { code?: unknown }).code);
    }
  }
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return String((error as { code?: unknown }).code);
  }
  return 'AGENT_COMMAND_FAILED';
}

function extractErrorDetail(error: unknown): string | null {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: unknown }).response;
    if (response && typeof response === 'object' && 'payload' in response) {
      return JSON.stringify((response as { payload?: unknown }).payload ?? null);
    }
  }
  if (error && typeof error === 'object' && 'payload' in error) {
    return JSON.stringify((error as { payload?: unknown }).payload ?? null);
  }
  return null;
}
