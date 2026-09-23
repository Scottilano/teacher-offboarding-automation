const verified = status => ['REMOVED', 'ABSENT_VERIFIED'].includes(status);
export function executionState(job, state, approved) {
  if (!state) return { disabled: true, reason: 'Connecting to the local app. Please wait.' };
  if (state.busy) return { disabled: true, reason: 'An operation is still running. Wait or request a stop after the current teacher.' };
  if (!job) return { disabled: true, reason: 'Save or open a local job first.' };
  const deferred = job.items.filter(item => item.status === 'DEFERRED').length;
  const remaining = job.items.filter(item => !verified(item.status) && item.status !== 'DEFERRED');
  if (!remaining.length) return { disabled: true, reason: deferred ? `Automatic processing has ended with ${deferred} deferred items. The entire roster is not necessarily complete.` : 'All platform actions in this job were verified complete. No further execution is needed.' };
  const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (remaining.some(item => (state.protectedTeachers || []).some(person =>
    (person.email && normalize(person.email) === normalize(item.email)) ||
    (person.fullName && normalize(person.fullName) === normalize(item.fullName))))) {
    return { disabled: true, reason: 'This old job includes currently protected teachers. Import a new roster to apply protection. Historical records are unchanged.' };
  }
  const blocked = remaining.filter(item => !['PENDING', 'READY'].includes(item.status));
  if (blocked.some(item => item.status === 'LOGIN_REQUIRED')) return { disabled: true, reason: 'Session check failed; this batch is paused. Click Check Login for the platform, sign in, inspect unfinished items, then authorize again.' };
  if (blocked.length) {
    const names = blocked.slice(0, 3).map(item => item.fullName || item.email).join(', ');
    return { disabled: true, reason: `Next batch paused: ${names}${blocked.length > 3 ? ' and others' : ''}. ${blocked.length} items require review. Inspect unfinished items, or defer individual items with a reason. Other roles are never automatically removed.` };
  }
  if (remaining.some(item => !state.sites?.[item.platform]?.ready)) return { disabled: true, reason: 'Includes a platform awaiting acceptance. Inspection only; removal is disabled.' };
  const missing = [...new Set(remaining.map(item => item.platform))].filter(platform => !state.browsers?.includes(platform));
  if (missing.length) return { disabled: true, reason: `Open the ${missing.map(p => p.toUpperCase()).join(', ')} sign-in window and complete sign-in first.` };
  if (!approved) return { disabled: true, reason: `${remaining.length} platform actions remain. Check the authorization box again before each batch.` };
  return { disabled: false, reason: `Ready to continue. ${remaining.length} platform actions remain. Verified actions in this job will be skipped.` };
}
