import { Module } from '@nestjs/common';
import { AgentGateway } from './agent/agent.gateway';
import { DeviceStore } from './devices/device.store';
import { DevicesController } from './devices/devices.controller';
import { HealthController } from './health/health.controller';
import { AdminController } from './admin/admin.controller';
import { AdminNextController } from './admin/admin-next.controller';
import { LogsController } from './logs/logs.controller';
import { LogStore } from './logs/log.store';
import { DatabaseService } from './database/database.service';
import { AdminSessionService } from './admin/admin-session.service';
import { AdminLockoutService } from './admin/admin-lockout.service';
import { TotpService } from './admin/totp.service';
import { AdminAuditService } from './admin/admin-audit.service';
import { RateLimitService } from './rate-limit/rate-limit.service';
import { AdminApiTokenService } from './admin/admin-api-token.service';
import { CommandStore } from './commands/command.store';
import { CommandsController } from './commands/commands.controller';
import { CommandTimeoutService } from './commands/command-timeout.service';
import { CommandDispatchService } from './commands/command-dispatch.service';
import { PtySessionStore } from './pty/pty-session.store';
import { PtyController } from './pty/pty.controller';
import { PtyGateway } from './pty/pty.gateway';
import { PtyHubService } from './pty/pty-hub.service';
import { PtyAuditStore } from './pty/pty-audit.store';
import { FileTransferStore } from './file-ops/file-transfer.store';
import { RemoteBrowserSessionStore } from './file-ops/remote-browser-session.store';
import { FileOpsController } from './file-ops/file-ops.controller';
import { FileOpAdmissionService } from './file-ops/file-op-admission.service';
import { FileOpQuotaService } from './file-ops/file-op-quota.service';
import { FileOpSloService } from './file-ops/file-op-slo.service';
import { RemoteBrowserController } from './file-ops/remote-browser.controller';

@Module({
  imports: [],
  controllers: [DevicesController, CommandsController, HealthController, AdminController, LogsController, PtyController, FileOpsController, RemoteBrowserController, AdminNextController],
  providers: [
    AgentGateway,
    DeviceStore,
    LogStore,
    DatabaseService,
    AdminSessionService,
    AdminLockoutService,
    TotpService,
    AdminAuditService,
    AdminApiTokenService,
    CommandStore,
    CommandDispatchService,
    CommandTimeoutService,
    PtySessionStore,
    PtyHubService,
    PtyAuditStore,
    FileTransferStore,
    FileOpAdmissionService,
    FileOpQuotaService,
    FileOpSloService,
    RemoteBrowserSessionStore,
    PtyGateway,
    RateLimitService,
  ],
})
export class AppModule {}
