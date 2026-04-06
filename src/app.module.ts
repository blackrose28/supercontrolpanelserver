import { Module } from '@nestjs/common';
import { AgentGateway } from './agent/agent.gateway';
import { DeviceStore } from './devices/device.store';
import { DevicesController } from './devices/devices.controller';
import { HealthController } from './health/health.controller';
import { AdminController } from './admin/admin.controller';
import { LogsController } from './logs/logs.controller';
import { LogStore } from './logs/log.store';
import { DatabaseService } from './database/database.service';
import { AdminSessionService } from './admin/admin-session.service';
import { RateLimitService } from './rate-limit/rate-limit.service';

@Module({
  imports: [],
  controllers: [DevicesController, HealthController, AdminController, LogsController],
  providers: [AgentGateway, DeviceStore, LogStore, DatabaseService, AdminSessionService, RateLimitService],
})
export class AppModule {}
