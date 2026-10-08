export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

// Matches the current Mange dashboard model: percent of sales or one fixed fee.
export function calculateCommission(amount, commissionType, commissionValue) {
  const base = Math.max(0, Number(amount) || 0);
  const rate = Math.max(0, Number(commissionValue) || 0);
  if (commissionType === 'percentage') return roundMoney((base * rate) / 100);
  return roundMoney(Math.min(base, rate));
}

export function calculateSettlementCommission(grossAmount, commissionType, commissionValue, lifetimeSales, alreadyDeducted = 0) {
  if (commissionType === 'percentage') {
    return calculateCommission(grossAmount, commissionType, commissionValue);
  }
  const totalFixedCommission = calculateCommission(lifetimeSales, 'fixed', commissionValue);
  const remaining = Math.max(0, totalFixedCommission - (Number(alreadyDeducted) || 0));
  return roundMoney(Math.min(Number(grossAmount) || 0, remaining));
}

export function initials(name = '') {
  return String(name).trim().split(/\s+/).filter(Boolean).slice(0, 2).map((word) => Array.from(word)[0]).join('') || '—';
}
