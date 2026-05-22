export function sendAgentMessage(client: any, message: any, seq: number) {
  const envelope = {
    ...message,
    deviceId: 'server',
    seq,
    ts: new Date().toISOString(),
  };
  client.send(JSON.stringify(envelope));
  return envelope;
}

export function payloadHasServerId(payload: unknown, serverId: string): boolean {
  return !!payload
    && typeof payload === 'object'
    && typeof (payload as Record<string, unknown>).serverId === 'string'
    && (payload as Record<string, unknown>).serverId === serverId;
}
