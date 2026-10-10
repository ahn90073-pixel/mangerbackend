export function isSuperAdmin(user) {
  return user?.role === 'super_admin';
}

// Null intentionally means unrestricted and is only returned for a super admin.
export function assignedGovernorates(user) {
  return isSuperAdmin(user) ? null : (Array.isArray(user?.assignedGovernorates) ? user.assignedGovernorates : []);
}
