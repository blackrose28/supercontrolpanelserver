export type PtyMessageRouteResult = {
  msgType: string;
  payload: Record<string, unknown>;
  handled: boolean;
};

export function routePtyMessage(input: {
  data: string;
  onInvalidJson: () => void;
  onUnsupported: (msgType: string) => void;
  onOpen: (payload: Record<string, unknown>) => void;
  onAttach: (payload: Record<string, unknown>) => void;
  onDetach: (payload: Record<string, unknown>) => void;
  onRecordingConsent: (payload: Record<string, unknown>) => void;
  onWrite: (payload: Record<string, unknown>) => void;
  onResize: (payload: Record<string, unknown>) => void;
  onClose: (payload: Record<string, unknown>) => void;
}): PtyMessageRouteResult {
  let envelope: any;
  try {
    envelope = JSON.parse(input.data);
  } catch {
    input.onInvalidJson();
    return { msgType: '', payload: {}, handled: false };
  }

  const msgType = typeof envelope?.type === 'string' ? envelope.type.trim() : '';
  const payload =
    envelope?.payload && typeof envelope.payload === 'object' ? envelope.payload : {};

  switch (msgType) {
    case 'pty_open':
      input.onOpen(payload);
      return { msgType, payload, handled: true };
    case 'pty_attach':
      input.onAttach(payload);
      return { msgType, payload, handled: true };
    case 'pty_detach':
      input.onDetach(payload);
      return { msgType, payload, handled: true };
    case 'pty_recording_consent':
      input.onRecordingConsent(payload);
      return { msgType, payload, handled: true };
    case 'pty_write':
      input.onWrite(payload);
      return { msgType, payload, handled: true };
    case 'pty_resize':
      input.onResize(payload);
      return { msgType, payload, handled: true };
    case 'pty_close':
      input.onClose(payload);
      return { msgType, payload, handled: true };
    default:
      input.onUnsupported(msgType);
      return { msgType, payload, handled: false };
  }
}
