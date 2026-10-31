import { HttpException, HttpStatus } from '@nestjs/common';
import { DeviceStore } from '../devices/device.store';

export function requireDispatchDevice(deviceStore: DeviceStore, rawDeviceId: string): string {
  const deviceId = rawDeviceId.trim();
  if (!deviceId) {
    throw new HttpException('deviceId is required', HttpStatus.BAD_REQUEST);
  }

  const device = deviceStore.getDevice(deviceId);
  if (!device) {
    throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
  }

  return deviceId;
}
