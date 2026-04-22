export const INSERT_FILE_TRANSFER_SQL = `
  INSERT INTO file_transfers (
    id, transferId, deviceId, serverId, browserSessionId, sessionId, actorType, actorId,
    state, direction, localPath, remotePath, recursive, overwritePolicy,
    followSymlinks, rateLimitKbps, verifyChecksum, preserveMtime, preserveMode,
    attempt, maxAttempts, resumeSupported, retryScheduled, resumeToken, resumeOffsetBytes, tempPathHint,
    progressEventCount, firstProgressAt, lastProgressAt, finalizeSeen,
    bytesTransferred, bytesTotal, percent, throughputBps, etaSec, phase,
    reasonCode, reasonDetail, message, commandId, reqSeq, createdAt, updatedAt
  )
  VALUES (
    @id, @transferId, @deviceId, @serverId, @browserSessionId, @sessionId, @actorType, @actorId,
    'queued', @direction, @localPath, @remotePath, @recursive, @overwritePolicy,
    @followSymlinks, @rateLimitKbps, @verifyChecksum, @preserveMtime, @preserveMode,
    @attempt, @maxAttempts, @resumeSupported, @retryScheduled, @resumeToken, @resumeOffsetBytes, @tempPathHint,
    0, NULL, NULL, 0,
    0, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, @commandId, @reqSeq, @ts, @ts
  )
`;

export const UPDATE_FILE_TRANSFER_STATE_SQL = `
  UPDATE file_transfers
  SET state = @state,
      phase = COALESCE(@phase, phase),
      reasonCode = @reasonCode,
      reasonDetail = @reasonDetail,
      message = COALESCE(@message, message),
      attempt = COALESCE(@attempt, attempt),
      maxAttempts = COALESCE(@maxAttempts, maxAttempts),
      resumeSupported = COALESCE(@resumeSupported, resumeSupported),
      retryScheduled = COALESCE(@retryScheduled, retryScheduled),
      resumeToken = COALESCE(@resumeToken, resumeToken),
      resumeOffsetBytes = COALESCE(@resumeOffsetBytes, resumeOffsetBytes),
      tempPathHint = COALESCE(@tempPathHint, tempPathHint),
      finalizeSeen = CASE
        WHEN @state IN ('queued', 'starting', 'running') THEN 0
        WHEN @finalizeSeen = 1 THEN 1
        ELSE finalizeSeen
      END,
      startedAt = COALESCE(@startedAt, startedAt, CASE WHEN @state IN ('starting', 'running') THEN @ts ELSE NULL END),
      finishedAt = CASE
        WHEN @state IN ('succeeded', 'failed', 'canceled') THEN COALESCE(@finishedAt, @ts)
        WHEN @state IN ('queued', 'starting', 'running') THEN NULL
        ELSE finishedAt
      END,
      updatedAt = @ts
  WHERE transferId = @transferId
`;

export const UPDATE_FILE_TRANSFER_PROGRESS_SQL = `
  UPDATE file_transfers
  SET state = CASE WHEN state IN ('queued', 'failed', 'canceled', 'succeeded') THEN 'running' ELSE state END,
      bytesTransferred = @bytesTransferred,
      bytesTotal = COALESCE(@bytesTotal, bytesTotal),
      percent = @percent,
      throughputBps = @throughputBps,
      etaSec = @etaSec,
      phase = COALESCE(@phase, phase),
      message = COALESCE(@message, message),
      attempt = COALESCE(@attempt, attempt),
      maxAttempts = COALESCE(@maxAttempts, maxAttempts),
      resumeSupported = COALESCE(@resumeSupported, resumeSupported),
      retryScheduled = COALESCE(@retryScheduled, retryScheduled),
      resumeToken = COALESCE(@resumeToken, resumeToken),
      resumeOffsetBytes = COALESCE(@resumeOffsetBytes, resumeOffsetBytes),
      tempPathHint = COALESCE(@tempPathHint, tempPathHint),
      progressEventCount = progressEventCount + 1,
      firstProgressAt = COALESCE(firstProgressAt, @ts),
      lastProgressAt = @ts,
      finalizeSeen = CASE WHEN @phase = 'finalize' THEN 1 ELSE finalizeSeen END,
      startedAt = COALESCE(startedAt, @ts),
      finishedAt = NULL,
      updatedAt = @ts
  WHERE transferId = @transferId
`;

export const UPDATE_FILE_TRANSFER_SESSION_SQL = `
  UPDATE file_transfers
  SET sessionId = @sessionId,
      updatedAt = @ts
  WHERE transferId = @transferId
`;

export const UPDATE_FILE_TRANSFER_COMMAND_SQL = `
  UPDATE file_transfers
  SET commandId = @commandId,
      reqSeq = @reqSeq,
      updatedAt = @ts
  WHERE transferId = @transferId
`;

export const PREPARE_FILE_TRANSFER_RESUME_SQL = `
  UPDATE file_transfers
  SET state = 'queued',
      phase = 'precheck',
      reasonCode = NULL,
      reasonDetail = NULL,
      message = COALESCE(@message, message),
      attempt = COALESCE(@attempt, attempt),
      maxAttempts = COALESCE(@maxAttempts, maxAttempts),
      resumeSupported = COALESCE(@resumeSupported, resumeSupported),
      retryScheduled = COALESCE(@retryScheduled, retryScheduled),
      resumeToken = COALESCE(@resumeToken, resumeToken),
      resumeOffsetBytes = COALESCE(@resumeOffsetBytes, resumeOffsetBytes),
      tempPathHint = COALESCE(@tempPathHint, tempPathHint),
      finalizeSeen = 0,
      finishedAt = NULL,
      updatedAt = @ts
  WHERE transferId = @transferId
`;

export const DELETE_FINISHED_FILE_TRANSFERS_BY_DEVICE_SQL = `
  DELETE FROM file_transfers
  WHERE deviceId = ?
    AND state IN ('succeeded', 'failed', 'canceled')
`;

export const DELETE_FILE_TRANSFER_BY_TRANSFER_ID_SQL = `
  DELETE FROM file_transfers
  WHERE transferId = ?
`;

export const GET_FILE_TRANSFER_BY_TRANSFER_ID_SQL = `
  SELECT *
  FROM file_transfers
  WHERE transferId = ?
`;

export const LIST_FILE_TRANSFERS_BY_DEVICE_SQL = `
  SELECT *
  FROM file_transfers
  WHERE deviceId = ?
  ORDER BY updatedAt DESC, createdAt DESC
  LIMIT ?
`;

export const LIST_COMPLETED_FILE_TRANSFERS_BY_DEVICE_SINCE_SQL = `
  SELECT *
  FROM file_transfers
  WHERE deviceId = ?
    AND state IN ('succeeded', 'failed', 'canceled')
    AND COALESCE(finishedAt, updatedAt) >= ?
  ORDER BY COALESCE(finishedAt, updatedAt) DESC
`;

export const LIST_COMPLETED_FILE_TRANSFERS_SINCE_SQL = `
  SELECT *
  FROM file_transfers
  WHERE state IN ('succeeded', 'failed', 'canceled')
    AND COALESCE(finishedAt, updatedAt) >= ?
  ORDER BY COALESCE(finishedAt, updatedAt) DESC
`;

export const COUNT_ACTIVE_FILE_TRANSFERS_BY_DEVICE_SQL = `
  SELECT COUNT(*) as count
  FROM file_transfers
  WHERE deviceId = ?
    AND state IN ('queued', 'starting', 'running')
`;

export const LIST_ACTIVE_FILE_TRANSFERS_SQL = `
  SELECT *
  FROM file_transfers
  WHERE state IN ('queued', 'starting', 'running', 'failed')
  ORDER BY updatedAt DESC
  LIMIT ?
`;

export const COUNT_ACTIVE_FILE_TRANSFERS_SQL = `
  SELECT COUNT(*) as count
  FROM file_transfers
  WHERE state IN ('queued', 'starting', 'running')
`;

export const SUM_TRANSFERRED_BYTES_SINCE_SQL = `
  SELECT COALESCE(SUM(bytesTransferred), 0) as total
  FROM file_transfers
  WHERE state IN ('succeeded', 'failed', 'canceled')
    AND COALESCE(finishedAt, updatedAt) >= ?
`;
