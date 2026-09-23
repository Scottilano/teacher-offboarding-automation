// Rendered DOM only. No Salesforce application state or private endpoints.
export function readCoverageDom(grid) {
  const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  let region = grid;
  while (region && !region.classList?.contains('cManageInstructors')) {
    region = region.parentElement || region.getRootNode()?.host;
  }
  const nodes = [];
  const visit = root => {
    if(root.shadowRoot) visit(root.shadowRoot);
    for (const el of root.querySelectorAll('*')) { nodes.push(el); if (el.shadowRoot) visit(el.shadowRoot); }
  };
  if (region) visit(region);
  const paging = nodes.filter(el => visible(el) && ['BUTTON','A'].includes(el.tagName) &&
    /^(next(?:\s+page)?|load more|show more|下一页|加载更多|[›»])$/i.test((el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim()));
  const enabledPaging = paging.some(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true');
  const pagingRegion = nodes.some(el => visible(el) && /paginat/i.test((el.getAttribute('aria-label') || '') + ' ' + el.className));
  const scrollers = [];
  let el = grid;
  while (el) {
    if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(el).overflowY)) scrollers.push(el);
    el = el.parentElement || el.getRootNode()?.host;
  }
  const doc = document.scrollingElement;
  if (doc && !scrollers.includes(doc)) scrollers.push(doc);
  return { knownRegion: !!region,
    busy: grid.getAttribute('aria-busy') === 'true' || nodes.some(el => visible(el) &&
      (el.getAttribute('aria-busy') === 'true' || el.tagName.toLowerCase() === 'lightning-spinner' || el.classList.contains('slds-spinner'))),
    declaredRows: grid.hasAttribute('aria-rowcount') ? Number(grid.getAttribute('aria-rowcount')) : null,
    enabledPaging, pagingRegion,
    atEnd: scrollers.every(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2),
    geometry: scrollers.map(el => [el.scrollHeight,el.clientHeight,Math.round(el.scrollTop)]) };
}

export function scrollCoverageDom(grid, reset) {
  let el = grid;
  const moved = new Set();
  while (el) {
    if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(el).overflowY)) {
      el.scrollTop = reset ? 0 : Math.min(el.scrollHeight, el.scrollTop + Math.max(100,el.clientHeight * 0.8)); moved.add(el);
    }
    el = el.parentElement || el.getRootNode()?.host;
  }
  const doc = document.scrollingElement;
  if (doc && !moved.has(doc)) doc.scrollTop = reset ? 0 : Math.min(doc.scrollHeight,doc.scrollTop + Math.max(100,doc.clientHeight * 0.8));
}

export function coverageDecision(coverage, dataCount) {
  if (coverage.enabledPaging) return { complete:false, fatal:true, detail:'ARC has a Next or Load More control. Unscanned pages cannot establish absence; manual review is required.' };
  if (coverage.pagingRegion) return { complete:false, fatal:true, detail:'ARC pagination was detected. This layout has not been verified; processing stopped.' };
  if (coverage.declaredRows !== null && (!Number.isInteger(coverage.declaredRows) || coverage.declaredRows < 1)) return { complete:false, fatal:true, detail:'ARC declares an unknown or invalid row count; completeness cannot be verified.' };
  if (coverage.declaredRows !== null && coverage.declaredRows !== dataCount + 1) return { complete:false, detail:'ARC loaded row count does not match its declared total.' };
  return {complete:coverage.knownRegion && coverage.atEnd && !coverage.busy,
    detail:'ARC requires a known nonpaginated list, the end of the list, completed loading and stable rows.'};
}
