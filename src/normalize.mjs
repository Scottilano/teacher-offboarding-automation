export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function normalizeText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export function isTruthy(value) {
  return ['true', 'yes', 'y', '1', 'approved', 'x'].includes(normalizeText(value).toLowerCase());
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

export function teacherKey(row) {
  return normalizeEmail(row.email);
}

export function validateTeachers(rows, config) {
  const candidates = [];
  const rejected = [];
  const allowedStatuses = (config.eligibility?.allowedStatuses || []).map(normalizeText);

  for (const row of rows) {
    const normalized = {
      ...row,
      fullName: normalizeText(row.fullName),
      email: normalizeEmail(row.email),
      achievement: normalizeText(row.achievement),
      upgradeType: normalizeText(row.upgradeType),
      status: normalizeText(row.status),
      approved: isTruthy(row.approved),
      processAha: row.processAha === undefined || row.processAha === '' ? true : isTruthy(row.processAha),
      processArclc: row.processArclc === undefined || row.processArclc === '' ? true : isTruthy(row.processArclc)
    };

    const reasons = [];
    if (!normalized.fullName) reasons.push('MISSING_FULL_NAME');
    if (!isValidEmail(normalized.email)) reasons.push('INVALID_EMAIL');
    if (allowedStatuses.length && !allowedStatuses.includes(normalized.status)) reasons.push('STATUS_NOT_SELECTED');
    if (config.eligibility?.requireApprovedColumn && !normalized.approved) reasons.push('NOT_APPROVED');
    if (!normalized.processAha && !normalized.processArclc) reasons.push('NO_PLATFORM_SELECTED');

    if (reasons.length) rejected.push({ ...normalized, reasons });
    else candidates.push(normalized);
  }

  const grouped = new Map();
  for (const row of candidates) {
    const key = teacherKey(row);
    const existing = grouped.get(key) || {
      rowNumber: row.rowNumber,
      sourceRows: [],
      fullName: row.fullName,
      email: row.email,
      achievements: [],
      upgradeTypes: [],
      statuses: [],
      approved: row.approved,
      processAha: false,
      processArclc: false,
      observedNames: new Set()
    };
    existing.sourceRows.push(row.rowNumber);
    existing.observedNames.add(row.fullName);
    if (row.achievement && !existing.achievements.includes(row.achievement)) existing.achievements.push(row.achievement);
    if (row.upgradeType && !existing.upgradeTypes.includes(row.upgradeType)) existing.upgradeTypes.push(row.upgradeType);
    if (row.status && !existing.statuses.includes(row.status)) existing.statuses.push(row.status);
    existing.approved ||= row.approved;
    existing.processAha ||= row.processAha;
    existing.processArclc ||= row.processArclc;
    grouped.set(key, existing);
  }

  const accepted = [];
  for (const teacher of grouped.values()) {
    if (teacher.observedNames.size > 1) {
      rejected.push({
        ...teacher,
        fullName: [...teacher.observedNames].join(' / '),
        reasons: ['CONFLICTING_NAMES_FOR_EMAIL']
      });
      continue;
    }
    delete teacher.observedNames;
    accepted.push(teacher);
  }
  return { accepted, rejected };
}
