export interface PiiScanOptions {
  /**
   * Keys explicitly allowed in this context (lowercased), e.g. `['seat_no']`
   * when checking physical layout cells on `/journeys/{id}/coach-map`.
   */
  allowedKeys?: string[];
  /**
   * When true, allows `seat_no` on layout cells (`coach-map` / `cabin-map`)
   * provided no occupant identity keys are present alongside them.
   */
  allowLayoutSeatNo?: boolean;
  /**
   * Scan string values for raw 10-digit Indian mobile numbers or emails.
   * Defaults to true.
   */
  scanPatterns?: boolean;
}

const DEFAULT_FORBIDDEN_KEYS = new Set<string>([
  'name',
  'full_name',
  'first_name',
  'last_name',
  'passenger_name',
  'pax_name',
  'age',
  'dob',
  'date_of_birth',
  'gender',
  'gender_self',
  'gender_band',
  'phone',
  'phone_enc',
  'phone_bidx',
  'phone_number',
  'mobile',
  'email',
  'pnr',
  'raw_pnr',
  'pnr_hash',
  'seat_no',
  'berth_no',
]);

const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_DATE_PATTERN =
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

const PHONE_PATTERN =
  /(?<![0-9])(?:\(\+?91\)[\s.-]?|\+?91[\s.-]?)?(?:[6-9]\d{9}|[6-9]\d{4}[\s.-]\d{5}|[6-9]\d{3}[\s.-]\d{3}[\s.-]\d{3}|[6-9]\d{2}[\s.-]\d{3}[\s.-]\d{4}|[6-9]\d{2}[\s.-]\d{4}[\s.-]\d{3}|[6-9]\d[\s.-]\d{4}[\s.-]\d{4}|[6-9]\d(?:[\s.-]\d{2}){4})(?![0-9])/;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSnakeKey(key: string): string {
  return key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesShortKnownSecret(text: string, secret: string): boolean {
  if (secret.length <= 2) {
    return text === secret;
  }
  const escaped = escapeRegExp(secret);
  const boundaryPattern = /^\w.*\w$/.test(secret)
    ? new RegExp(`\\b${escaped}\\b`, 'i')
    : new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`, 'i');
  return boundaryPattern.test(text);
}

function containsIndianPhone(text: string): boolean {
  const sanitized = text.replace(UUID_PATTERN, ' ').replace(ISO_DATE_PATTERN, ' ');
  return PHONE_PATTERN.test(sanitized);
}

function isCoachLayoutCell(obj: Record<string, unknown>, path: string): boolean {
  if (!path.includes('.seats[') || !/\.seats\[\d+\]$/.test(path)) {
    return false;
  }
  return (
    'seat_type' in obj ||
    'bay' in obj ||
    'state' in obj ||
    'seat_no' in obj ||
    'seatNo' in obj ||
    'berth_no' in obj ||
    'berthNo' in obj
  );
}

/**
 * Recursively inspects API payloads or serialized views to guarantee zero co-passenger
 * PII (`name`, `age`, `gender`, `phone`, `email`, `pnr`, `seat_no`, etc.) leaks.
 */
export function assertNoPiiLeak(
  payload: unknown,
  contextLabel: string,
  forbiddenKnownValues: string[] = [],
  options: PiiScanOptions = {},
): void {
  const allowedKeys = new Set((options.allowedKeys ?? []).map((k) => toSnakeKey(k)));
  const scanPatterns = options.scanPatterns ?? true;
  const allowLayoutSeatNo = options.allowLayoutSeatNo ?? false;
  const normalizedKnown = forbiddenKnownValues
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

  const violations: string[] = [];

  function walk(node: unknown, currentPath: string): void {
    if (node === null || node === undefined) {
      return;
    }

    if (typeof node === 'string') {
      const lowerVal = node.toLowerCase();
      for (const secret of normalizedKnown) {
        if (secret.length <= 4) {
          if (matchesShortKnownSecret(node, secret)) {
            violations.push(
              `${currentPath}: contains forbidden known PII value "${secret}" in "${node}"`,
            );
          }
        } else if (lowerVal.includes(secret.toLowerCase())) {
          violations.push(
            `${currentPath}: contains forbidden known PII value "${secret}" in "${node}"`,
          );
        }
      }

      if (scanPatterns) {
        if (containsIndianPhone(node)) {
          violations.push(`${currentPath}: matches raw Indian phone pattern in "${node}"`);
        }
        if (EMAIL_PATTERN.test(node)) {
          violations.push(`${currentPath}: matches raw email pattern in "${node}"`);
        }
      }
      return;
    }

    if (typeof node === 'number' || typeof node === 'boolean') {
      return;
    }

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        walk(node[i], `${currentPath}[${i}]`);
      }
      return;
    }

    if (isRecord(node)) {
      const entries = Object.entries(node);
      for (const [rawKey, value] of entries) {
        const key = toSnakeKey(rawKey);
        const childPath = `${currentPath}.${rawKey}`;

        const isAllowedSeatNo =
          (key === 'seat_no' || key === 'berth_no') &&
          allowLayoutSeatNo &&
          isCoachLayoutCell(node, currentPath);

        if (
          DEFAULT_FORBIDDEN_KEYS.has(key) &&
          !allowedKeys.has(key) &&
          !isAllowedSeatNo
        ) {
          if (value !== null && value !== undefined && value !== '') {
            violations.push(
              `${childPath}: forbidden PII key "${rawKey}" present with value ${JSON.stringify(value)}`,
            );
          } else {
            violations.push(`${childPath}: forbidden PII key "${rawKey}" exposed`);
          }
        }

        walk(value, childPath);
      }
    }
  }

  walk(payload, '$');

  if (violations.length > 0) {
    throw new Error(
      `PII leak detected in [${contextLabel}]:\n  - ${violations.join('\n  - ')}`,
    );
  }
}
