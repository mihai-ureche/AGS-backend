import type { RequestPriority, RequestStatus, TargetEntity } from './types.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRequestStatus(value: unknown): value is RequestStatus {
  return value === 'open' || value === 'in_progress' || value === 'resolved' || value === 'closed';
}

export function isRequestPriority(value: unknown): value is RequestPriority {
  return value === 'low' || value === 'normal' || value === 'high';
}

export function isTargetEntity(value: unknown): value is TargetEntity {
  return value === 'agritehnica' || value === 'green' || value === 'babyhub';
}
