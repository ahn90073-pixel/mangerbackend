export const EGYPT_GOVERNORATES = Object.freeze([
  'القاهرة',
  'الجيزة',
  'الإسكندرية',
  'الدقهلية',
  'البحر الأحمر',
  'البحيرة',
  'الفيوم',
  'الغربية',
  'الإسماعيلية',
  'المنوفية',
  'المنيا',
  'القليوبية',
  'الوادي الجديد',
  'السويس',
  'أسوان',
  'أسيوط',
  'بني سويف',
  'بورسعيد',
  'دمياط',
  'الشرقية',
  'جنوب سيناء',
  'كفر الشيخ',
  'مطروح',
  'الأقصر',
  'قنا',
  'شمال سيناء',
  'سوهاج',
]);

const allowed = new Set(EGYPT_GOVERNORATES);

export function normalizeGovernorate(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return allowed.has(normalized) ? normalized : null;
}

export function normalizeGovernorateList(value) {
  if (!Array.isArray(value)) return null;
  const normalized = [...new Set(value.map(normalizeGovernorate))];
  return normalized.includes(null) ? null : normalized;
}
