export function routeAgentRawMessage(input: {
  data: string;
  client: any;
  handleAck: (envelope: any, client: any) => void;
  handleNack: (envelope: any, client: any) => void;
  handleHeartbeat: (envelope: any, client: any) => void;
  handleStatusSnapshot: (envelope: any, client: any) => void;
  handleInventory: (envelope: any, client: any) => void;
  handleRecentLogs: (envelope: any, client: any) => void;
  handleCommandStatus: (envelope: any, client: any) => void;
  handleFunctionStatus: (envelope: any, client: any) => void;
  handlePtyOutput: (envelope: any, client: any) => void;
  handlePtyExit: (envelope: any, client: any) => void;
  handleTransferProgress: (envelope: any, client: any) => void;
  handleTransferStatus: (envelope: any, client: any) => void;
}) {
  const {
    data,
    client,
    handleAck,
    handleNack,
    handleHeartbeat,
    handleStatusSnapshot,
    handleInventory,
    handleRecentLogs,
    handleCommandStatus,
    handleFunctionStatus,
    handlePtyOutput,
    handlePtyExit,
    handleTransferProgress,
    handleTransferStatus,
  } = input;

  try {
    const envelope = JSON.parse(data);
    console.log(`Received from ${client.deviceId}: type=${envelope.type}`);

    switch (envelope.type) {
      case 'ack':
        handleAck(envelope, client);
        break;
      case 'nack':
        handleNack(envelope, client);
        break;
      case 'heartbeat':
        handleHeartbeat(envelope, client);
        break;
      case 'status_snapshot':
        handleStatusSnapshot(envelope, client);
        break;
      case 'inventory':
        handleInventory(envelope, client);
        break;
      case 'recent_logs':
        handleRecentLogs(envelope, client);
        break;
      case 'command_status':
        handleCommandStatus(envelope, client);
        break;
      case 'function-status':
        handleFunctionStatus(envelope, client);
        break;
      case 'pty-output':
        handlePtyOutput(envelope, client);
        break;
      case 'pty-exit':
        handlePtyExit(envelope, client);
        break;
      case 'transfer_progress':
        handleTransferProgress(envelope, client);
        break;
      case 'transfer_status':
        handleTransferStatus(envelope, client);
        break;
      default:
        console.log(`Unknown message type: ${envelope.type}`);
    }
  } catch (err) {
    console.error('Error handling message:', err);
  }
}
