import { nanoid } from 'nanoid';

export function sessionId(): string {
  return `ses_${nanoid(8)}`;
}

export function spanId(): string {
  return `spn_${nanoid(8)}`;
}
