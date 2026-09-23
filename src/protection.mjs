// Negative safety guard only: a name match may exclude, never authorize removal.
const normalized = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();

export function teacherProtection(item, config) {
  return (config.safety?.protectedTeachers || []).find(person =>
    (person.email && normalized(person.email) === normalized(item.email)) ||
    (person.fullName && normalized(person.fullName) === normalized(item.fullName))
  );
}

export function protectedExclusions(roster, config) {
  return roster.accepted.flatMap(item => {
    const protection = teacherProtection(item, config);
    return protection ? [{ email: item.email, fullName: item.fullName, reason: protection.reason }] : [];
  });
}

export function assertNotProtected(item, config) {
  const protection = teacherProtection(item, config);
  if (protection) throw new Error(`Protected teacher cannot be unaligned: ${item.fullName || item.email}. ${protection.reason} Import a new roster to apply the exclusion; do not bypass this restriction.`);
}

export function batchLimit(config, platforms) {
  const caps = [config.safety.maxExecuteActions, ...platforms.map(platform => config.sites[platform]?.maxBatchActions ?? config.safety.maxExecuteActions)];
  if (caps.some(cap => !Number.isInteger(cap) || cap < 1 || cap > 100)) throw new Error('Batch limits must be integers from 1 to 100.');
  return Math.min(...caps);
}
