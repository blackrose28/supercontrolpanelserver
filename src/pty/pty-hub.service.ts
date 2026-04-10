import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class PtyHubService {
  private readonly clientSessions = new Map<string, Set<string>>();
  private readonly sessionClients = new Map<string, Set<any>>();
  private readonly sessionScrollback = new Map<string, string>();
  private readonly sessionScrollbackTruncated = new Map<string, boolean>();
  private readonly maxScrollbackBytes = 32_000;

  registerClient(client: any): string {
    const clientId = uuidv4();
    client.__ptyClientId = clientId;
    this.clientSessions.set(clientId, new Set());
    return clientId;
  }

  attachClient(client: any, sessionId: string) {
    const clientId = this.requireClientId(client);
    let sessions = this.clientSessions.get(clientId);
    if (!sessions) {
      sessions = new Set<string>();
      this.clientSessions.set(clientId, sessions);
    }
    sessions.add(sessionId);

    let clients = this.sessionClients.get(sessionId);
    if (!clients) {
      clients = new Set<any>();
      this.sessionClients.set(sessionId, clients);
    }
    clients.add(client);
  }

  detachClient(client: any, sessionId?: string) {
    const clientId = this.requireClientId(client);
    const sessions = this.clientSessions.get(clientId);
    if (!sessions) {
      return;
    }

    const targets = sessionId ? [sessionId] : Array.from(sessions);
    for (const sid of targets) {
      sessions.delete(sid);
      const clients = this.sessionClients.get(sid);
      if (!clients) {
        continue;
      }
      clients.delete(client);
      if (!clients.size) {
        this.sessionClients.delete(sid);
      }
    }
  }

  unregisterClient(client: any) {
    const clientId = this.tryGetClientId(client);
    if (!clientId) {
      return;
    }
    this.detachClient(client);
    this.clientSessions.delete(clientId);
  }

  sessionsForClient(client: any): string[] {
    const clientId = this.tryGetClientId(client);
    if (!clientId) {
      return [];
    }
    return Array.from(this.clientSessions.get(clientId) ?? []);
  }

  appendOutput(sessionId: string, chunk: string) {
    if (!sessionId || !chunk) {
      return;
    }
    const previous = this.sessionScrollback.get(sessionId) ?? '';
    const combined = previous + chunk;
    const truncated = combined.length > this.maxScrollbackBytes;
    const nextValue = truncated ? combined.slice(-this.maxScrollbackBytes) : combined;
    this.sessionScrollback.set(sessionId, nextValue);
    if (truncated) {
      this.sessionScrollbackTruncated.set(sessionId, true);
    }
  }

  clearScrollback(sessionId: string) {
    if (!sessionId) {
      return;
    }
    this.sessionScrollback.delete(sessionId);
    this.sessionScrollbackTruncated.delete(sessionId);
  }

  replayToClient(client: any, sessionId: string) {
    const scrollback = this.sessionScrollback.get(sessionId);
    if (!scrollback) {
      return;
    }
    this.send(client, {
      type: 'pty_output',
      payload: {
        sessionId,
        data: scrollback,
        replay: true,
        truncated: this.sessionScrollbackTruncated.get(sessionId) === true,
      },
    });
  }

  broadcast(sessionId: string, message: unknown) {
    const clients = this.sessionClients.get(sessionId);
    if (!clients?.size) {
      return;
    }
    const serialized = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === 1) {
        client.send(serialized);
      }
    }
  }

  send(client: any, message: unknown) {
    if (client.readyState === 1) {
      client.send(JSON.stringify(message));
    }
  }

  private requireClientId(client: any): string {
    const clientId = this.tryGetClientId(client);
    if (!clientId) {
      throw new Error('PTY websocket client is not registered');
    }
    return clientId;
  }

  private tryGetClientId(client: any): string | null {
    const clientId = typeof client?.__ptyClientId === 'string' ? client.__ptyClientId : '';
    return clientId || null;
  }
}
